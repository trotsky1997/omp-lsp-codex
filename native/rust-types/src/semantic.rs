use anyhow::{Result, bail};
use ra_ap_hir::{HasVisibility, HirDisplay, Semantics, Type};
use ra_ap_ide_db::{
    RootDatabase,
    active_parameter::ActiveParameter,
    defs::{Definition, IdentClass},
};
use ra_ap_syntax::{
    AstNode, SyntaxNode, TextRange, TextSize,
    ast::{self, HasName},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Deserialize, Serialize)]
pub struct Position {
    pub line: u32,
    pub character: u32,
}
#[derive(Clone, Copy, Deserialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

pub fn lookup(
    db: &RootDatabase,
    file_id: ra_ap_vfs::FileId,
    text: &str,
    symbol: &str,
) -> Vec<(Position, String)> {
    ra_ap_hir::attach_db(db, || {
        let sema = Semantics::new(db);
        let source = sema.parse_guess_edition(file_id);
        let requested = symbol.replace('.', "::");
        let numbered = requested
            .rsplit_once('#')
            .and_then(|(name, number)| number.parse::<usize>().ok().map(|number| (name, number)));
        let (requested, occurrence) = numbered
            .map_or((requested.as_str(), None), |(name, number)| {
                (name, Some(number))
            });
        let parts: Vec<_> = requested.split("::").collect();
        let name = parts.last().copied().unwrap_or("").trim_start_matches("r#");
        let mut candidates = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for token in source
            .syntax()
            .descendants_with_tokens()
            .filter_map(|node| node.into_token())
            .filter(|token| {
                token.kind().is_any_identifier() && token.text().trim_start_matches("r#") == name
            })
        {
            for mapped in sema.descend_into_macros_exact(token.clone()) {
                let Some(declaration) = mapped
                    .parent()
                    .filter(|node| ast::Name::can_cast(node.kind()))
                else {
                    continue;
                };
                let mut owners = Vec::new();
                for parent in declaration.ancestors().skip(2) {
                    if let Some(module) = ast::Module::cast(parent.clone()) {
                        if let Some(name) = module.name() {
                            owners.push(name.text().to_string());
                        }
                    }
                    if let Some(item) = ast::Impl::cast(parent.clone()) {
                        if let Some(path) = item
                            .self_ty()
                            .and_then(|ty| ast::PathType::cast(ty.syntax().clone()))
                            .and_then(|ty| ty.path())
                            .and_then(|path| path.segment())
                            .and_then(|segment| segment.name_ref())
                        {
                            owners.push(path.text().to_string());
                        }
                    }
                    if let Some(item) = ast::Trait::cast(parent) {
                        if let Some(name) = item.name() {
                            owners.push(name.text().to_string());
                        }
                    }
                }
                owners.reverse();
                owners.push(name.to_owned());
                let qualified = owners.join("::");
                if parts.len() > 1
                    && qualified != requested
                    && !qualified.ends_with(&format!("::{requested}"))
                {
                    continue;
                }
                let byte = usize::from(token.text_range().start());
                if seen.insert((byte, qualified.clone())) {
                    let before = &text[..byte];
                    candidates.push((
                        Position {
                            line: before.bytes().filter(|byte| *byte == b'\n').count() as u32,
                            character: before.rsplit('\n').next().unwrap().encode_utf16().count()
                                as u32,
                        },
                        qualified,
                    ));
                }
            }
        }
        if let Some(occurrence) = occurrence {
            return occurrence
                .checked_sub(1)
                .and_then(|index| candidates.into_iter().nth(index))
                .into_iter()
                .collect();
        }
        candidates
    })
}

pub fn offset(text: &str, point: Position) -> Result<TextSize> {
    let mut start = 0;
    let line = text
        .split('\n')
        .nth(point.line as usize)
        .ok_or_else(|| anyhow::anyhow!("Invalid Rust line"))?;
    for row in text.split_inclusive('\n').take(point.line as usize) {
        start += row.len();
    }
    let line = line.strip_suffix('\r').unwrap_or(line);
    let mut units = 0;
    for (byte, character) in line.char_indices() {
        if units == point.character {
            return Ok(TextSize::from((start + byte) as u32));
        }
        units += character.len_utf16() as u32;
        if units > point.character {
            bail!("Rust column splits a UTF-16 surrogate pair");
        }
    }
    if units == point.character {
        return Ok(TextSize::from((start + line.len()) as u32));
    }
    bail!("Invalid Rust column")
}

fn declared<'db>(
    sema: &Semantics<'db, RootDatabase>,
    node: &SyntaxNode,
) -> Option<(Type<'db>, &'static str)> {
    if let Some(annotation) = ast::Type::cast(node.clone()) {
        return Some((sema.resolve_type(&annotation)?, "annotation"));
    }
    let definition = node
        .ancestors()
        .find_map(|node| IdentClass::classify_node(sema, &node))?
        .definitions_no_ops()
        .into_iter()
        .next()?;
    let db = sema.db;
    Some(match definition {
        Definition::Local(local) => {
            let source = local.primary_source(db);
            sema.parse_or_expand(source.source.file_id);
            if let Some(pat) = source.as_ident_pat() {
                for parent in pat.syntax().ancestors().skip(1) {
                    if let Some(statement) = ast::LetStmt::cast(parent.clone()) {
                        if let Some(annotation) = statement.ty() {
                            if statement.pat()?.syntax() == pat.syntax() {
                                return Some((sema.resolve_type(&annotation)?, "annotation"));
                            }
                            return Some((local.ty(db), "pattern"));
                        }
                        break;
                    }
                    if let Some(parameter) = ast::Param::cast(parent.clone()) {
                        if let Some(annotation) = parameter.ty() {
                            if parameter.pat()?.syntax() == pat.syntax() {
                                return Some((sema.resolve_type(&annotation)?, "annotation"));
                            }
                            return Some((local.ty(db), "pattern"));
                        }
                        break;
                    }
                    if ast::Fn::can_cast(parent.kind()) {
                        break;
                    }
                }
            }
            (local.ty(db), "inferred")
        }
        Definition::Function(function) => (function.ty(db), "signature"),
        Definition::Adt(item) => (item.ty(db), "type-definition"),
        Definition::EnumVariant(item) => (item.constructor_ty(db), "type-definition"),
        Definition::TypeAlias(item) => (item.ty(db), "type-definition"),
        Definition::Field(item) => (item.ty(db), "annotation"),
        Definition::TupleField(item) => (item.ty(db), "annotation"),
        Definition::Const(item) => (item.ty(db), "annotation"),
        Definition::Static(item) => (item.ty(db), "annotation"),
        Definition::GenericParam(ra_ap_hir::GenericParam::TypeParam(item)) => {
            (item.ty(db), "type-definition")
        }
        _ => return None,
    })
}

fn expected<'db>(
    sema: &Semantics<'db, RootDatabase>,
    expression: &ast::Expr,
    depth: usize,
) -> Option<(Type<'db>, &'static str)> {
    if depth > 32 {
        return None;
    }
    let parent = expression.syntax().parent()?;
    if let Some(branch) = ast::IfExpr::cast(parent.clone()) {
        if branch
            .then_branch()
            .is_some_and(|body| body.syntax() == expression.syntax())
            || branch
                .else_branch()
                .is_some_and(|body| body.syntax() == expression.syntax())
        {
            return expected(sema, &ast::Expr::IfExpr(branch), depth + 1);
        }
    }
    if let Some(arm) = ast::MatchArm::cast(parent.clone()) {
        if arm.expr()?.syntax() == expression.syntax() {
            let matched = arm.syntax().ancestors().find_map(ast::MatchExpr::cast)?;
            return expected(sema, &ast::Expr::MatchExpr(matched), depth + 1);
        }
    }
    if let Some(arguments) = ast::ArgList::cast(parent.clone()) {
        return Some((
            ActiveParameter::at_arg(sema, arguments, expression.syntax().text_range().start())?.ty,
            "argument",
        ));
    }
    if let Some(statement) = ast::LetStmt::cast(parent.clone()) {
        if statement.initializer()?.syntax() == expression.syntax() {
            return Some((sema.resolve_type(&statement.ty()?)?, "annotation"));
        }
    }
    if let Some(assignment) = ast::BinExpr::cast(parent.clone()) {
        if assignment.op_token()?.text() == "=" && assignment.rhs()?.syntax() == expression.syntax()
        {
            return Some((
                sema.type_of_expr(&assignment.lhs()?)?.original,
                "assignment",
            ));
        }
    }
    if let Some(field) = ast::RecordExprField::cast(parent.clone()) {
        let record = field.syntax().ancestors().find_map(ast::RecordExpr::cast)?;
        let ty = sema.type_of_expr(&ast::Expr::RecordExpr(record))?.original;
        let name = field.name_ref()?.text().to_owned();
        return ty
            .fields(sema.db)
            .into_iter()
            .find(|(field, _)| field.name(sema.db).as_str() == name)
            .map(|(_, ty)| (ty, "record-field"));
    }
    if ast::ReturnExpr::can_cast(parent.kind()) {
        for ancestor in parent.ancestors().skip(1) {
            if ast::ClosureExpr::can_cast(ancestor.kind()) {
                return None;
            }
            if let Some(function) = ast::Fn::cast(ancestor) {
                let function = sema.to_def(&function)?;
                return Some((
                    function
                        .async_ret_type(sema.db)
                        .unwrap_or_else(|| function.ret_type(sema.db)),
                    "return",
                ));
            }
        }
    }
    if let Some(statements) = ast::StmtList::cast(parent.clone()) {
        if statements.tail_expr()?.syntax() == expression.syntax() {
            let block = statements
                .syntax()
                .parent()
                .and_then(ast::BlockExpr::cast)?;
            if let Some(function) = block.syntax().parent().and_then(ast::Fn::cast) {
                let function = sema.to_def(&function)?;
                return Some((
                    function
                        .async_ret_type(sema.db)
                        .unwrap_or_else(|| function.ret_type(sema.db)),
                    "return",
                ));
            }
            return expected(sema, &ast::Expr::BlockExpr(block), depth + 1);
        }
    }
    if let Some(parentheses) = ast::ParenExpr::cast(parent) {
        return expected(sema, &ast::Expr::ParenExpr(parentheses), depth + 1);
    }
    None
}

pub fn query(
    db: &RootDatabase,
    file_id: ra_ap_vfs::FileId,
    text: &str,
    range: Range,
    view: &str,
    limit: usize,
) -> Result<Value> {
    ra_ap_hir::attach_db(db, || {
        let start = offset(text, range.start)?;
        let end = offset(text, range.end)?;
        if end < start {
            bail!("Reversed Rust range");
        }
        let sema = Semantics::new(db);
        let source = sema.parse_guess_edition(file_id);
        let span = TextRange::new(start, end);
        let ambiguous = |count| json!({"found":false,"summary":"Ambiguous Rust macro expansion","type":null,"reason":"ambiguous-macro","hint":format!("This source token maps to {count} macro expansions; query an unambiguous declaration or call outside the macro")});
        let selected = if start == end {
            let tokens = source
                .syntax()
                .token_at_offset(start)
                .right_biased()
                .map(|token| sema.descend_into_macros_exact(token));
            if tokens.as_ref().is_some_and(|tokens| tokens.len() > 1) {
                return Ok(ambiguous(tokens.as_ref().unwrap().len()));
            }
            tokens
                .and_then(|tokens| tokens.into_iter().next())
                .and_then(|token| token.parent())
        } else {
            let mut element = source.syntax().covering_element(span);
            if element
                .ancestors()
                .any(|node| ast::TokenTree::can_cast(node.kind()))
            {
                let first = source
                    .syntax()
                    .token_at_offset(start)
                    .right_biased()
                    .map(|token| sema.descend_into_macros_exact(token));
                let last = source
                    .syntax()
                    .token_at_offset(end)
                    .left_biased()
                    .map(|token| sema.descend_into_macros_exact(token));
                let count = first
                    .as_ref()
                    .map_or(0, |tokens| tokens.len())
                    .max(last.as_ref().map_or(0, |tokens| tokens.len()));
                if count > 1 {
                    return Ok(ambiguous(count));
                }
                let first = first.and_then(|tokens| tokens.into_iter().next());
                let last = last.and_then(|tokens| tokens.into_iter().next());
                if let (Some(first), Some(last)) = (first, last) {
                    let first_root = first.parent_ancestors().last();
                    let last_root = last.parent_ancestors().last();
                    if first_root == last_root
                        && first.text_range().start() <= last.text_range().end()
                    {
                        if let Some(root) = first_root {
                            element = root.covering_element(TextRange::new(
                                first.text_range().start(),
                                last.text_range().end(),
                            ));
                        }
                    }
                }
            }
            element.as_node().cloned().or_else(|| element.parent())
        };
        let Some(node) = selected else {
            return Ok(
                json!({"found":false,"summary":"No Rust type returned","type":null,"hint":"Select an expression or declaration inside a linked Cargo target"}),
            );
        };
        let expression = node
            .ancestors()
            .take_while(|node| {
                !ast::Item::can_cast(node.kind())
                    && !ast::LetStmt::can_cast(node.kind())
                    && !ast::Param::can_cast(node.kind())
                    && !ast::Pat::can_cast(node.kind())
                    && !ast::MatchArm::can_cast(node.kind())
                    && !ast::ArgList::can_cast(node.kind())
                    && !ast::RecordExprField::can_cast(node.kind())
                    && !ast::StmtList::can_cast(node.kind())
                    && !ast::GenericArgList::can_cast(node.kind())
            })
            .find_map(ast::Expr::cast);
        let mut declaration_source = None;
        let mut expected_source = None;
        let mut adjusted = None;
        let mut selected_callable = None;
        let ty = match view {
            "computed" => {
                let method = node
                    .ancestors()
                    .find_map(ast::MethodCallExpr::cast)
                    .filter(|call| {
                        call.name_ref().is_some_and(|name| {
                            name.syntax().text_range().contains_range(node.text_range())
                        })
                    });
                if let Some(method) = method {
                    selected_callable = sema.resolve_method_call_as_callable(&method);
                    selected_callable
                        .as_ref()
                        .map(|callable| callable.ty().clone())
                } else if let Some(expression) = &expression {
                    sema.type_of_expr(expression).map(|info| {
                        adjusted = info.adjusted;
                        info.original
                    })
                } else {
                    declared(&sema, &node).map(|(ty, _)| ty).or_else(|| {
                        node.ancestors()
                            .find_map(ast::Type::cast)
                            .and_then(|annotation| sema.resolve_type(&annotation))
                    })
                }
            }
            "declared" => declared(&sema, &node).map(|(ty, source)| {
                declaration_source = Some(source);
                ty
            }),
            "expected" => expression
                .as_ref()
                .and_then(|expression| expected(&sema, expression, 0))
                .map(|(ty, source)| {
                    expected_source = Some(source);
                    ty
                }),
            _ => bail!("Invalid Rust type view"),
        };
        let Some(ty) = ty.filter(|ty| !ty.is_unknown()) else {
            let mut result = json!({"found":false,"summary":"No Rust type returned","type":null,"hint":format!("No {view} type for selected {:?}; select an argument, annotated initializer, assignment RHS or function return expression for expected. Check Cargo target/features/dependencies for unresolved nodes.", node.kind())});
            let suggested = ast::MatchArm::cast(node.clone())
                .and_then(|arm| arm.expr())
                .or_else(|| {
                    ast::LetStmt::cast(node.clone()).and_then(|statement| statement.initializer())
                });
            if let Some(range) = suggested
                .and_then(|expression| sema.original_range_opt(expression.syntax()))
                .filter(|range| range.file_id.file_id(db) == file_id)
            {
                let point = |offset: TextSize| {
                    let prefix = &text[..usize::from(offset)];
                    format!(
                        "{}:{}",
                        prefix.bytes().filter(|byte| *byte == b'\n').count() + 1,
                        prefix.rsplit('\n').next().unwrap().encode_utf16().count() + 1
                    )
                };
                let range = format!(
                    "{}-{}",
                    point(range.range.start()),
                    point(range.range.end())
                );
                result["suggestedRange"] = range.clone().into();
                result["hint"] = format!(
                    "{}\nRetry the contained expression with --range {range}",
                    result["hint"].as_str().unwrap()
                )
                .into();
            }
            return Ok(result);
        };
        let scope = sema.scope(&node).ok_or_else(|| {
            anyhow::anyhow!("Source is outside a linked Rust crate; check Cargo target/features")
        })?;
        let target = scope.krate().to_display_target(db);
        let mut truncated = false;
        let mut describe = |ty: &Type<'_>| {
            // Source-code formatting preserves associated-type projections such as F::Output.
            let mut text = ty
                .display_source_code(db, scope.module().into(), true)
                .unwrap_or_else(|_| ty.display(db, target).to_string());
            if limit != 0 && text.chars().count() > 6000 {
                text = text.chars().take(6000).collect();
                truncated = true;
            }
            text
        };
        let summary = describe(&ty);
        let maximum = if limit == 0 { 200 } else { limit.min(200) };
        let fields = ty.fields(db);
        let arguments: Vec<_> = ty.type_arguments().collect();
        let tuple = ty.tuple_fields(db);
        let properties: Vec<_> = fields.iter().take(maximum).map(|(field, ty)| json!({"name":field.name(db).display(db,target.edition).to_string(),"type":describe(ty),"visible":field.is_visible_from(db,scope.module())})).collect();
        let type_arguments: Vec<_> = arguments.iter().take(maximum).map(&mut describe).collect();
        let tuple: Vec<_> = tuple.iter().take(maximum).map(&mut describe).collect();
        let callable = selected_callable.or_else(|| ty.as_callable(db));
        let mut signatures = Vec::new();
        let mut parameter_count = 0;
        if let Some(callable) = &callable {
            let parameters = callable.params();
            parameter_count = parameters.len();
            let parameters: Vec<_> = parameters.iter().take(maximum).enumerate().map(|(index, parameter)| json!({"name":parameter.name(db).map(|name|name.display(db,target.edition).to_string()).unwrap_or_else(||format!("arg{index}")),"type":describe(parameter.ty())})).collect();
            signatures.push(json!({"parameters":parameters,"parameterCount":parameter_count,"returns":describe(&callable.return_type())}));
        }
        let adjusted = adjusted.map(|ty| describe(&ty));
        truncated |=
            fields.len() > maximum || arguments.len() > maximum || parameter_count > maximum;
        let kind = if callable.is_some() {
            "callable"
        } else if ty.as_adt().is_some() {
            "adt"
        } else if ty.is_tuple() {
            "tuple"
        } else if ty.is_scalar() {
            "primitive"
        } else {
            "other"
        };
        let mut result = json!({"found":true,"summary":summary,"incomplete":ty.contains_unknown(),"type":{"text":summary,"kind":kind,"properties":properties,"totalProperties":fields.len(),"signatures":signatures,"typeArguments":type_arguments,"totalTypeArguments":arguments.len(),"tuple":tuple},"truncated":truncated});
        if let Some(source) = declaration_source {
            result["declarationSource"] = source.into();
        }
        if let Some(source) = expected_source {
            result["expectedSource"] = source.into();
        }
        if let Some(adjusted) = adjusted {
            result["type"]["adjusted"] = adjusted.into();
        }
        if truncated {
            result["hint"] = "Type details sampled (at most 200 members); use --limit 0 for full text or --fields summary for a focused answer".into();
        }
        Ok(result)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ra_ap_test_fixture::WithFixture;
    fn at(source: &str, needle: &str, view: &str, selection: bool) -> Value {
        let (db, file) = RootDatabase::with_single_file(&format!(
            "//- minicore: coerce_unsized\n//- /main.rs\n{source}"
        ));
        let start = source.rfind(needle).unwrap();
        let position = |offset| {
            let prefix = &source[..offset];
            Position {
                line: prefix.bytes().filter(|byte| *byte == b'\n').count() as u32,
                character: prefix.rsplit('\n').next().unwrap().encode_utf16().count() as u32,
            }
        };
        query(
            &db,
            file.file_id(&db),
            source,
            Range {
                start: position(start),
                end: position(if selection {
                    start + needle.len()
                } else {
                    start
                }),
            },
            view,
            50,
        )
        .unwrap()
    }
    #[test]
    fn generic_arguments_and_methods_are_instantiated_by_the_checker() {
        let source =
            "fn identity<T>(value: T) -> T { value }\nfn main() { let output = identity(42u32); }";
        assert_eq!(at(source, "42u32", "computed", true)["summary"], "u32");
        assert_eq!(at(source, "42u32", "expected", true)["summary"], "u32");
        let source = "struct Holder<T> { value: T }\nimpl<T> Holder<T> { fn take(&self, value: T) -> T { value } }\nfn main() { let holder=Holder{value:1u32}; holder.take(2u32); }";
        assert_eq!(at(source, "2u32", "expected", true)["summary"], "u32");
        let method = at(source, "take", "computed", false);
        assert_eq!(method["found"], true);
        assert_eq!(
            method["type"]["signatures"][0]["parameters"][0]["type"],
            "u32"
        );
    }
    #[test]
    fn declared_annotations_and_destructured_bindings_keep_their_own_types() {
        let result = at(
            "fn main(){ let value: u64 = 1; let other=value; }",
            "value",
            "declared",
            false,
        );
        assert_eq!(result["summary"], "u64");
        assert_eq!(result["declarationSource"], "annotation");
        let result = at(
            "fn main(){ let (left,right): (u32,bool)=(1,true); let _=right; }",
            "right",
            "declared",
            false,
        );
        assert_eq!(result["summary"], "bool");
        assert_eq!(result["declarationSource"], "pattern");
        assert_eq!(
            at(
                "fn main(){ let output = 42u32; }",
                "output",
                "computed",
                false
            )["summary"],
            "u32"
        );
    }
    #[test]
    fn declarative_macro_tokens_resolve_to_the_expanded_semantic_context() {
        let source = "macro_rules! passthrough { ($($item:item)*) => {$($item)*} }\npassthrough! { fn consume(value:u64){} fn example(){let output:u64=1;consume(output);} }";
        assert_eq!(at(source, "output", "declared", false)["summary"], "u64");
        assert_eq!(at(source, "output", "expected", true)["summary"], "u64");
        let (db, file) = RootDatabase::with_single_file(source);
        let candidates = lookup(&db, file.file_id(&db), source, "consume");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].1, "consume");
    }
    #[test]
    fn repeated_macro_expansions_are_ambiguous_instead_of_selecting_an_arbitrary_context() {
        let source = "macro_rules! twice { ($value:expr) => { { let left:u32=$value; let right:u64=$value; } } }\nfn main(){twice!(1);}";
        let result = at(source, "1", "expected", true);
        assert_eq!(result["found"], false);
        assert_eq!(result["reason"], "ambiguous-macro");
    }
    #[test]
    fn structured_fields_include_visibility_in_the_querying_module() {
        let source = "mod model { pub struct Item { pub exposed:u32, hidden:bool } pub fn make()->Item{Item{exposed:1,hidden:false}} } fn main(){let item=model::make();item;}";
        let result = at(source, "item", "computed", false);
        let fields = result["type"]["properties"].as_array().unwrap();
        assert_eq!(
            fields
                .iter()
                .find(|field| field["name"] == "exposed")
                .unwrap()["visible"],
            true
        );
        assert_eq!(
            fields
                .iter()
                .find(|field| field["name"] == "hidden")
                .unwrap()["visible"],
            false
        );
    }
    #[test]
    fn expected_types_follow_the_direct_context_without_confusing_casts_and_nested_expressions() {
        for (source, needle, wanted, origin) in [
            (
                "fn main(){ let number: u64 = 1; }",
                "1",
                "u64",
                "annotation",
            ),
            (
                "fn main(){ let mut number: u64=0; number=2; }",
                "2",
                "u64",
                "assignment",
            ),
            ("fn number() -> u64 { 3 }", "3", "u64", "return"),
            ("fn number() -> u64 { return 4; }", "4", "u64", "return"),
            (
                "fn number() -> u64 { if true { 8 } else if false { 9 } else { 10 } }",
                "9",
                "u64",
                "return",
            ),
            (
                "struct Box<T>{value:T} fn main(){let x:Box<u64>=Box{value:5};}",
                "5",
                "u64",
                "record-field",
            ),
            (
                "fn main(){let output:u64=match true{true=>6,false=>7};}",
                "6",
                "u64",
                "annotation",
            ),
        ] {
            let result = at(source, needle, "expected", true);
            assert_eq!(result["summary"], wanted, "{source}");
            assert_eq!(result["expectedSource"], origin);
        }
        for (source, needle) in [
            ("fn main(){let x=1u32 as u64;}", "1u32"),
            ("fn consume(x:u64){} fn main(){consume({let x=1; x});}", "1"),
            (
                "fn number() -> u64 { if { true } { 8 } else { 9 } }",
                "true",
            ),
        ] {
            assert_eq!(
                at(source, needle, "expected", true)["found"],
                false,
                "{source}"
            );
        }
        let arm = at(
            "fn main(){let output:u64=match true{true=>6,false=>7};}",
            "true=>6",
            "expected",
            true,
        );
        assert_eq!(arm["found"], false);
        assert_eq!(arm["suggestedRange"], "1:43-1:44");
        assert!(arm["hint"].as_str().unwrap().ends_with("--range 1:43-1:44"));
    }
    #[test]
    fn associated_type_projections_keep_their_identity_in_signatures() {
        let source = "trait Task{type Output;} trait Marker{} struct Handle<T>(T); fn spawn<F:Task>(future:F)->Handle<F::Output> where F::Output:Marker {loop{}}";
        let result = at(source, "spawn", "declared", false);
        assert!(
            result["summary"]
                .as_str()
                .unwrap()
                .contains("<F as Task>::Output"),
            "{result}"
        );
        assert_eq!(
            result["type"]["signatures"][0]["returns"],
            "Handle<<F as Task>::Output>"
        );
    }
    #[test]
    fn references_report_original_and_adjusted_types_separately() {
        let source = "trait Marker{} struct Item; impl Marker for Item{} fn consume(x:&dyn Marker){} fn main(){consume(&Item);}";
        let computed = at(source, "&Item", "computed", true);
        let expected = at(source, "&Item", "expected", true);
        assert_eq!(computed["summary"], "&Item");
        assert!(expected["summary"].as_str().unwrap().contains("dyn Marker"));
        assert!(
            computed["type"]["adjusted"]
                .as_str()
                .unwrap()
                .contains("dyn Marker")
        );
    }
    #[test]
    fn utf16_offsets_reject_split_pairs_and_out_of_bounds() {
        let text = "\u{feff}let value = \"😀\";\r\nnext\n";
        assert_eq!(
            offset(
                text,
                Position {
                    line: 1,
                    character: 0
                }
            )
            .unwrap(),
            TextSize::from(24)
        );
        assert!(
            offset(
                text,
                Position {
                    line: 0,
                    character: 15
                }
            )
            .is_err()
        );
        assert!(
            offset(
                text,
                Position {
                    line: 3,
                    character: 0
                }
            )
            .is_err()
        );
        assert!(
            offset(
                text,
                Position {
                    line: 1,
                    character: 5
                }
            )
            .is_err()
        );
    }
}
