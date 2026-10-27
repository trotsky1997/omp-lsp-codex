import childProcess from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gitRoot, inside, insideWorkspace, MAX_FILES, MAX_FILE_BYTES, numstatFiles, object, readText, resolveFile } from "./config.js";
import { syntaxLanguage, syntaxTool } from "./syntax.js";
import { windowsCommand } from "./windows-command.js";
const INSTALL = "Install ast-grep: npm install --global @ast-grep/cli (https://ast-grep.github.io/guide/quick-start.html)";
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".pyi", ".rs"];
const DECLARATIONS = {
    TypeScript: ["function_declaration", "function_signature", "generator_function_declaration", "class_declaration", "class", "abstract_class_declaration", "interface_declaration", "type_alias_declaration", "enum_declaration", "method_definition", "method_signature", "property_signature", "public_field_definition", "variable_declarator", "arrow_function", "function_expression"],
    JavaScript: ["function_declaration", "generator_function_declaration", "class_declaration", "class", "method_definition", "field_definition", "variable_declarator", "arrow_function", "function_expression"],
    Python: ["function_definition", "class_definition", "assignment"],
    Rust: ["function_item", "function_signature_item", "struct_item", "enum_item", "enum_variant", "trait_item", "impl_item", "mod_item", "type_item", "const_item", "static_item", "field_declaration", "associated_type"],
};
function family(file) { const language = syntaxLanguage(file); return language === "Tsx" ? "TypeScript" : language === "Jsx" ? "JavaScript" : language; }
function point(text, bytes) {
    const prefix = Buffer.from(text).subarray(0, bytes).toString("utf8"), newline = prefix.lastIndexOf("\n");
    return { line: prefix.split("\n").length, column: prefix.length - newline };
}
function checkDeadline(deadline) { if (Date.now() >= deadline)
    throw new Error("Analysis deadline exceeded; increase --timeout or narrow --file"); }
async function git(root, args, deadline) {
    checkDeadline(deadline);
    const result = await promisify(childProcess.execFile)("git", ["-c", "diff.autoRefreshIndex=false", "-C", root, "--literal-pathspecs", ...args], { encoding: "buffer", timeout: Math.max(1, deadline - Date.now()), maxBuffer: 32 * 1024 * 1024, killSignal: "SIGKILL", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.stdout);
}
function safeFile(root, file) {
    try {
        return !lstatSync(file).isSymbolicLink() && statSync(file).isFile() && statSync(file).size <= MAX_FILE_BYTES && insideWorkspace(root, realpathSync(file));
    }
    catch {
        return false;
    }
}
async function inventory(root, deadline, maximum = MAX_FILES) {
    let files = [], bounded = false;
    if (existsSync(join(root, ".git")))
        files = (await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], deadline)).split("\0").filter(Boolean).map(file => resolve(root, file));
    else {
        const pending = [root];
        while (pending.length && files.length <= maximum) {
            checkDeadline(deadline);
            const dir = pending.pop();
            for (const item of readdirSync(dir, { withFileTypes: true })) {
                const file = join(dir, item.name);
                if (item.isDirectory() && ![".git", "node_modules", ".venv", "venv", "target", "dist", "build", "__pycache__"].includes(item.name) && !existsSync(join(file, ".git")))
                    pending.push(file);
                else if (item.isFile() && EXTENSIONS.includes(extname(file)))
                    files.push(file);
                if (files.length > maximum)
                    break;
            }
        }
        bounded = pending.length > 0 || files.length > maximum;
    }
    const eligible = [...new Set(files)].filter(file => EXTENSIONS.includes(extname(file))).sort(), valid = [];
    for (const file of eligible.slice(0, maximum)) {
        checkDeadline(deadline);
        if (safeFile(root, file))
            valid.push(file);
    }
    return { files: valid, bounded: bounded || eligible.length > maximum, total: eligible.length };
}
async function parse(file, text, args, deadline) {
    checkDeadline(deadline);
    const language = syntaxLanguage(file), group = family(file);
    if (!language || !group || !DECLARATIONS[group])
        throw new Error(`Unsupported analysis language: ${file}`);
    const tool = syntaxTool(dirname(file), args.globalBinsOnly);
    if (!tool.command)
        throw new Error(INSTALL);
    const kinds = DECLARATIONS[group], any = kinds.map(kind => ({ kind }));
    const rules = kinds.map(kind => ({ id: kind, language, rule: { kind } }));
    rules.push({ id: "body", language, rule: { any, has: { field: "body", pattern: "$BODY" } } }, { id: "name", language, rule: { any, has: { field: "name", pattern: "$NAME" } } });
    if (group === "Python")
        rules.push({ id: "left", language, rule: { kind: "assignment", has: { field: "left", pattern: "$NAME" } } }, ...["import_statement", "import_from_statement", "decorated_definition", "string", "comment"].map(kind => ({ id: kind, language, rule: { kind } })));
    else if (group === "Rust")
        rules.push(...["use_declaration", "attribute_item", "line_comment", "block_comment"].map(kind => ({ id: kind, language, rule: { kind } })));
    else
        rules.push({ id: "export", language, rule: { kind: "export_statement" } }, { id: "import", language, rule: { any: [{ kind: "import_statement" }, { kind: "export_statement" }], has: { field: "source", pattern: "$SOURCE" } } }, { id: "comment", language, rule: { kind: "comment" } });
    const callKind = group === "Python" ? "call" : "call_expression";
    rules.push({ id: "call", language, rule: { kind: callKind, has: { field: "function", pattern: "$CALLEE" } } });
    const flags = ["scan", "--stdin", "--inline-rules", rules.map(rule => JSON.stringify(rule)).join("\n---\n"), "--json=compact"];
    const invocation = process.platform === "win32" && /\.(cmd|bat)$/i.test(tool.command) ? windowsCommand(tool.command, flags) : { command: tool.command, args: flags, windowsVerbatimArguments: false };
    const stdout = await new Promise((resolveOutput, reject) => {
        const child = childProcess.execFile(invocation.command, invocation.args, { cwd: tmpdir(), encoding: "utf8", timeout: Math.max(1, Math.min(5000, deadline - Date.now())), maxBuffer: 32 * 1024 * 1024, killSignal: "SIGKILL", windowsVerbatimArguments: invocation.windowsVerbatimArguments }, (error, output, stderr) => error ? reject(new Error(`ast-grep analysis failed: ${String(stderr || error.message).slice(0, 500)}; ${INSTALL}`)) : resolveOutput(output));
        child.stdin?.on("error", error => { child.kill("SIGKILL"); reject(error); });
        child.stdin?.end(text);
    });
    const values = JSON.parse(stdout);
    if (!Array.isArray(values))
        throw new Error("Invalid ast-grep analysis response");
    const source = Buffer.from(text);
    const decode = (value) => {
        const item = object(value), offsets = object(object(item.range).byteOffset), start = offsets.start, end = offsets.end;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || Number(start) < 0 || Number(end) < Number(start) || Number(end) > source.length || typeof item.text !== "string" || source.subarray(Number(start), Number(end)).toString("utf8") !== item.text)
            throw new Error("Invalid ast-grep analysis source range");
        return { text: item.text, start: Number(start), end: Number(end) };
    };
    const nodes = values.map(value => {
        const item = object(value), node = decode(item);
        if (typeof item.ruleId !== "string" || !rules.some(rule => rule.id === item.ruleId))
            throw new Error("Invalid ast-grep analysis rule");
        const captures = Object.fromEntries(Object.entries(object(object(item.metaVariables).single)).map(([name, capture]) => [name, decode(capture)]));
        if (Object.values(captures).some(capture => capture.start < node.start || capture.end > node.end))
            throw new Error("Invalid ast-grep analysis capture");
        return { ...node, kind: item.ruleId, captures };
    });
    return { file, text, nodes };
}
function surfaces(parsed) {
    const group = family(parsed.file), nodes = parsed.nodes, declarations = nodes.filter(node => DECLARATIONS[group].includes(node.kind));
    const body = (node) => nodes.find(item => item.kind === "body" && item.start === node.start && item.end === node.end)?.captures.BODY;
    const rawName = (node) => nodes.find(item => ["name", "left"].includes(item.kind) && item.start === node.start && item.end === node.end)?.captures.NAME.text;
    const parents = (node) => declarations.filter(item => item.start < node.start && item.end >= node.end).sort((a, b) => b.start - a.start || a.end - b.end);
    const publicName = (name) => !name.startsWith("_") || /^__.+__$/.test(name);
    const selected = [];
    const all = declarations.find(node => node.kind === "assignment" && rawName(node) === "__all__");
    const explicitAll = all && /^__all__\s*=\s*\[[\s\S]*\]\s*$/.test(all.text) ? nodes.filter(node => node.kind === "string" && node.start > all.start && node.end < all.end).map(node => unquote(node.text)).filter((name) => name !== undefined) : undefined;
    const header = (start, end) => {
        const source = Buffer.from(parsed.text), pieces = [];
        let offset = start;
        for (const node of nodes.filter(item => ["comment", "line_comment", "block_comment"].includes(item.kind) && item.start >= start && item.end <= end).sort((a, b) => a.start - b.start)) {
            pieces.push(source.subarray(offset, node.start).toString("utf8"), " ");
            offset = node.end;
        }
        pieces.push(source.subarray(offset, end).toString("utf8"));
        let result = "", quote = "", escaped = false;
        for (const char of pieces.join("")) {
            if (quote) {
                result += char;
                if (escaped)
                    escaped = false;
                else if (char === "\\")
                    escaped = true;
                else if (char === quote)
                    quote = "";
            }
            else if (["'", '"', "`"].includes(char)) {
                quote = char;
                result += char;
            }
            else if (/\s/.test(char)) {
                if (!result.endsWith(" "))
                    result += " ";
            }
            else
                result += char;
        }
        return result.trim().replace(/;$/, "");
    };
    for (const node of declarations.sort((a, b) => a.start - b.start || b.end - a.end)) {
        const containers = parents(node), parent = containers[0];
        if (containers.some(item => /function|method|variable_declarator|assignment|const_item|static_item/.test(item.kind)))
            continue;
        let name = rawName(node), visibility = "public";
        if (group === "Rust" && node.kind === "impl_item")
            name = (body(node) ? Buffer.from(node.text).subarray(0, body(node).start - node.start).toString("utf8") : node.text).trim();
        const exported = nodes.find(item => item.kind === "export" && item.start <= (containers.at(-1) ?? node).start && item.end >= (containers.at(-1) ?? node).end);
        if (!name && !parent && exported && /^export\s+default\b/.test(exported.text))
            name = "default";
        if (!name)
            continue;
        if (group === "TypeScript" || group === "JavaScript") {
            if (!exported)
                continue;
            if (/^(?:declare\s+)?private\b/.test(node.text) || name.startsWith("#"))
                continue;
            visibility = /^protected\b/.test(node.text) ? "protected" : "public";
            if (!parent && /^export\s+default\b/.test(exported.text))
                visibility = "default-export";
        }
        else if (group === "Python") {
            if (name === "__all__" || !publicName(name) || !parent && explicitAll && !explicitAll.includes(name))
                continue;
        }
        else {
            const pub = node.text.match(/^pub(?:\([^)]*\))?\s/), inherited = parent && ["trait_item", "enum_item", "enum_variant"].includes(parent.kind) && selected.some(item => item.node === parent);
            if (!pub && !inherited && node.kind !== "impl_item")
                continue;
            if (parent && !["impl_item", "trait_item"].includes(parent.kind) && !selected.some(item => item.node === parent))
                continue;
            visibility = pub?.[0].trim() || (inherited ? "inherited-public" : "implementation");
        }
        const prefix = containers.map(item => rawName(item) ?? (item.kind === "class" ? "default" : undefined)).filter(Boolean).reverse();
        if (parent?.kind === "impl_item")
            prefix.push(selected.find(item => item.node === parent)?.value.name ?? "impl");
        const fullName = [...prefix, name].join(".");
        let end = body(node)?.text.startsWith("(") || node.kind === "enum_declaration" ? node.end : body(node)?.start ?? node.end;
        if (node.kind === "variable_declarator" || node.kind === "assignment") {
            const nested = nodes.filter(item => item.kind === "body" && item.start >= node.start && item.end <= node.end).map(item => item.captures.BODY).filter(Boolean).sort((a, b) => a.start - b.start)[0];
            if (nested)
                end = nested.start;
        }
        const decorated = nodes.find(item => item.kind === "decorated_definition" && item.start < node.start && item.end === node.end);
        const variableKind = node.kind === "variable_declarator" ? exported?.text.match(/^export\s+(?:declare\s+)?(?:const|let|var)\b/)?.[0] : undefined;
        const signature = (variableKind ? variableKind + " " : "") + header(decorated?.start ?? node.start, end);
        selected.push({ node, value: { name: fullName, kind: node.kind, visibility, signature, ...point(parsed.text, node.start) } });
    }
    for (const node of nodes.filter(node => node.kind === "export" && !declarations.some(item => item.start >= node.start && item.end <= node.end))) {
        selected.push({ node, value: { name: node.text.replace(/\s+/g, " ").replace(/;$/, ""), kind: "re-export", visibility: "public", signature: node.text.replace(/\s+/g, " ").replace(/;$/, ""), ...point(parsed.text, node.start) } });
    }
    for (const node of nodes.filter(node => node.kind === "use_declaration" && /^pub\b/.test(node.text)))
        selected.push({ node, value: { name: header(node.start, node.end), kind: "re-export", visibility: "public", signature: header(node.start, node.end), ...point(parsed.text, node.start) } });
    return selected.map(item => item.value);
}
function unquote(value) {
    const text = value.trim();
    if (text.length < 2 || !["'", '"'].includes(text[0]) || text.at(-1) !== text[0])
        return undefined;
    if (!text.includes("\\"))
        return text.slice(1, -1);
    try {
        return text[0] === '"' ? JSON.parse(text) : JSON.parse('"' + text.slice(1, -1).replaceAll('"', '\\"').replaceAll("\\'", "'") + '"');
    }
    catch {
        return undefined;
    }
}
function rustPaths(value) {
    const tokens = value.match(/(?:r#)?[\p{L}_][\p{L}\p{N}_]*|::|[{},*;]/gu) ?? [];
    let offset = 0;
    const parseList = (prefix) => {
        const result = [];
        while (offset < tokens.length && tokens[offset] !== "}") {
            const path = [...prefix];
            while (offset < tokens.length) {
                const token = tokens[offset++];
                if (token === "{") {
                    result.push(...parseList(path));
                    if (tokens[offset] === "}")
                        offset++;
                    break;
                }
                if ([",", ";", "}"].includes(token)) {
                    if (token === "}")
                        offset--;
                    if (path.length)
                        result.push(path.join("::"));
                    break;
                }
                if (token === "as") {
                    while (offset < tokens.length && ![",", "}", ";"].includes(tokens[offset]))
                        offset++;
                    continue;
                }
                if (token !== "::") {
                    if (token !== "self" || !path.length)
                        path.push(token.replace(/^r#/, ""));
                }
                if (offset === tokens.length)
                    result.push(path.join("::"));
            }
            if (tokens[offset] === ",")
                offset++;
        }
        return result;
    };
    return [...new Set(parseList([]))];
}
function imports(parsed) {
    const rows = [], group = family(parsed.file);
    const add = (specifier, kind, node) => { if (specifier && !/[\0\r\n]/.test(specifier))
        rows.push({ specifier, kind, ...point(parsed.text, node.start) }); };
    for (const node of parsed.nodes) {
        if (node.kind === "import" && node.captures.SOURCE) {
            const value = unquote(node.captures.SOURCE.text);
            if (value)
                add(value, /^export\b/.test(node.text) ? "re-export" : /^import\s+type\b/.test(node.text) ? "type-import" : "import", node);
        }
        if (group === "Python" && node.kind === "import_statement")
            for (const name of node.text.replace(/^import\s+/, "").split(","))
                add(name.trim().split(/\s+as\s+/)[0], "import", node);
        if (group === "Python" && node.kind === "import_from_statement") {
            const match = node.text.match(/^from\s+(\.*[\p{L}\p{N}_.]*)\s+import\b/u);
            if (match && /^\.+$/.test(match[1]))
                for (const part of node.text.slice(match[0].length).replace(/[()]/g, "").split(",")) {
                    const name = part.trim().split(/\s+as\s+/)[0];
                    if (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name))
                        add(match[1] + name, "from-member", node);
                }
            else if (match)
                add(match[1], "from-import", node);
        }
        if (group === "Rust" && node.kind === "use_declaration") {
            let text = node.text;
            for (const comment of parsed.nodes.filter(item => ["line_comment", "block_comment"].includes(item.kind) && item.start >= node.start && item.end <= node.end).sort((a, b) => b.start - a.start)) {
                const bytes = Buffer.from(text);
                text = Buffer.concat([bytes.subarray(0, comment.start - node.start), Buffer.alloc(comment.end - comment.start, 32), bytes.subarray(comment.end - node.start)]).toString("utf8");
            }
            for (const value of rustPaths(text.replace(/^(?:pub(?:\([^)]*\))?\s+)?use\s+/, "")))
                add(value, /^pub\b/.test(text) ? "re-export" : "use", node);
        }
        if (group === "Rust" && node.kind === "mod_item" && !node.text.includes("{")) {
            const name = node.text.match(/\bmod\s+((?:r#)?[\p{L}_][\p{L}\p{N}_]*)\s*;/u)?.[1];
            if (name)
                add(name.replace(/^r#/, ""), "module", node);
        }
        if (["TypeScript", "JavaScript"].includes(group) && node.kind === "call" && /^(?:require|import)$/.test(node.captures.CALLEE?.text ?? "")) {
            const match = node.text.match(/^(?:require|import)\s*\(\s*((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))\s*\)$/);
            const value = match && unquote(match[1]);
            if (value)
                add(value, "dynamic-import", node);
        }
    }
    return [...new Map(rows.map(row => [`${row.specifier}\0${row.line}\0${row.kind}`, row])).values()];
}
function importClues(file, text) {
    const group = family(file), pieces = [], literals = [];
    let offset = 0, cursor = 0;
    const hide = (start, end) => { pieces.push(text.slice(offset, start), text.slice(start, end).replace(/[^\r\n]/g, " ")); offset = end; cursor = end; };
    while (cursor < text.length) {
        const start = cursor, char = text[cursor];
        if (group === "Python" && char === "#" || group !== "Python" && text.startsWith("//", cursor)) {
            const end = text.indexOf("\n", cursor);
            hide(start, end < 0 ? text.length : end);
            continue;
        }
        if (group !== "Python" && text.startsWith("/*", cursor)) {
            cursor += 2;
            let nesting = 1;
            while (cursor < text.length && nesting) {
                if (text.startsWith("/*", cursor)) {
                    nesting++;
                    cursor += 2;
                }
                else if (text.startsWith("*/", cursor)) {
                    nesting--;
                    cursor += 2;
                }
                else
                    cursor++;
            }
            hide(start, cursor);
            continue;
        }
        const raw = group === "Rust" ? text.slice(cursor, cursor + 20).match(/^(?:b)?r(#{0,16})"/) : undefined;
        if (raw) {
            const closing = '"' + raw[1], end = text.indexOf(closing, cursor + raw[0].length);
            hide(start, end < 0 ? text.length : end + closing.length);
            continue;
        }
        if (["'", '"', "`"].includes(char) && !(group === "Rust" && char === "'" && !/^'(?:\\.|[^\\'\r\n])'/.test(text.slice(cursor, cursor + 8)))) {
            const closing = group === "Python" && text.startsWith(char.repeat(3), cursor) ? char.repeat(3) : char;
            cursor += closing.length;
            while (cursor < text.length) {
                if (text[cursor] === "\\")
                    cursor += 2;
                else if (text.startsWith(closing, cursor)) {
                    cursor += closing.length;
                    break;
                }
                else
                    cursor++;
            }
            literals.push({ start, text: text.slice(start, cursor) });
            hide(start, cursor);
            continue;
        }
        cursor++;
    }
    pieces.push(text.slice(offset));
    const code = pieces.join(""), clues = [];
    const add = (specifier, kind) => { if (specifier && !/[\0\r\n]/.test(specifier))
        clues.push({ specifier, kind, line: 0, column: 0 }); };
    if (group === "TypeScript" || group === "JavaScript")
        for (const literal of literals) {
            const prefix = code.slice(Math.max(0, literal.start - 4096), literal.start);
            if (/(?:^|\n)\s*import\s*$/.test(prefix) || /(?:^|\n)\s*(?:import|export)\b[^;]*\bfrom\s*$/.test(prefix) || /\b(?:require|import)\s*\(\s*$/.test(prefix)) {
                const name = unquote(literal.text);
                if (name)
                    add(name, "import");
            }
        }
    else if (group === "Python") {
        for (const match of code.matchAll(/(?:^|\n)\s*from\s+(\.*[\p{L}\p{N}_.]*)\s+import\b/gu)) {
            if (/^\.+$/.test(match[1])) {
                const tail = code.slice(match.index + match[0].length, match.index + match[0].length + 4096), names = tail.trimStart().startsWith("(") ? tail.split(")")[0].slice(tail.indexOf("(") + 1) : tail.split(/[\r\n;]/)[0];
                for (const part of names.split(",")) {
                    const name = part.trim().split(/\s+as\s+/)[0];
                    if (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name))
                        add(match[1] + name, "from-member");
                }
            }
            else
                add(match[1], "from-import");
        }
        for (const match of code.matchAll(/(?:^|\n)\s*import\s+([^\r\n;]+)/g))
            for (const name of match[1].split(","))
                add(name.trim().split(/\s+as\s+/)[0], "import");
    }
    else if (group === "Rust") {
        for (const match of code.matchAll(/(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]{1,4096});/g))
            for (const name of rustPaths(match[1]))
                add(name, "use");
        for (const match of code.matchAll(/(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+((?:r#)?[\p{L}_][\p{L}\p{N}_]*)\s*;/gu))
            add(match[1].replace(/^r#/, ""), "module");
    }
    return [...new Map(clues.map(clue => [`${clue.kind}\0${clue.specifier}`, clue])).values()];
}
function moduleFile(root, file, value) {
    const group = family(file), specifier = value.specifier;
    const find = (candidates) => candidates.find(candidate => safeFile(root, candidate));
    if (group === "TypeScript" || group === "JavaScript") {
        if (!specifier.startsWith("."))
            return { status: "external" };
        const target = resolve(dirname(file), specifier), without = target.replace(/\.(?:[cm]?js|jsx)$/, "");
        const found = find([target, ...EXTENSIONS.filter(ext => ![".rs", ".py", ".pyi"].includes(ext)).map(ext => without + ext), ...[".ts", ".tsx", ".js", ".mts", ".mjs"].map(ext => join(target, "index" + ext))]);
        return found ? { file: realpathSync(found), status: "internal" } : { status: "unresolved" };
    }
    if (group === "Python") {
        const dots = specifier.match(/^\.+/)?.[0].length ?? 0, name = specifier.slice(dots).replaceAll(".", sep);
        let base = dirname(file);
        for (let i = 1; i < dots; i++)
            base = dirname(base);
        const prefixes = dots ? [base] : [root, join(root, "src")];
        const found = find([...prefixes.flatMap(prefix => [join(prefix, name + ".py"), join(prefix, name + ".pyi"), join(prefix, name, "__init__.py"), join(prefix, name, "__init__.pyi")]), ...(value.kind === "from-member" ? [join(base, "__init__.py"), join(base, "__init__.pyi")] : [])]);
        return found ? { file: realpathSync(found), status: "internal" } : { status: dots ? "unresolved" : "external" };
    }
    let own = ["lib.rs", "main.rs", "mod.rs"].includes(basename(file)) ? dirname(file) : join(dirname(file), basename(file, ".rs"));
    const parts = specifier.split("::");
    if (value.kind === "module")
        parts.unshift("self");
    if (parts[0] === "crate") {
        let packageRoot = dirname(file);
        while (packageRoot !== root && !existsSync(join(packageRoot, "Cargo.toml")))
            packageRoot = dirname(packageRoot);
        own = existsSync(join(packageRoot, "src")) ? join(packageRoot, "src") : packageRoot;
        parts.shift();
    }
    else if (parts[0] === "self")
        parts.shift();
    else if (parts[0] === "super") {
        while (parts[0] === "super") {
            own = dirname(own);
            parts.shift();
        }
    }
    else
        return { status: "external" };
    if (parts.at(-1) === "*")
        parts.pop();
    while (parts.length) {
        const target = join(own, ...parts), found = find([target + ".rs", join(target, "mod.rs")]);
        if (found)
            return { file: realpathSync(found), status: "internal" };
        parts.pop();
    }
    const found = find([join(own, "mod.rs"), join(own, "lib.rs"), join(own, "main.rs"), own + ".rs"]);
    return found ? { file: realpathSync(found), status: "internal" } : { status: "unresolved" };
}
export async function dependencies(args) {
    if (!args.file || args.apply)
        throw new Error("dependencies is read-only; use --file PATH [--reverse] [--depth N]");
    const file = resolveFile(args.file, args.cwd), root = realpathSync(gitRoot(dirname(file))), deadline = Date.now() + args.timeout, depth = args.depth ?? 1;
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > 10)
        throw new Error("Dependency depth must be 1-10");
    const scope = inside(root, args.cwd) && inside(args.cwd, file) ? realpathSync(args.cwd) : root;
    const nodes = [], edges = [], errors = [], ids = new Map(), scanned = new Map(), snapshots = new Map();
    const attempted = new Set(), candidates = new Set(), incoming = new Map(), prefilterStates = new Map();
    const maximumReadBytes = 128 * 1024 * 1024, maximumPrefilterBytes = maximumReadBytes / 2;
    let bounded = false, totalFiles, prefilteredFiles = 0, prefilterBytes = 0, readBytes = 0, verificationBytes = 0, indexedEdges = 0;
    const readSource = (source, verify = false) => {
        const size = statSync(source).size;
        if (readBytes + verificationBytes + size * (verify ? 2 : 1) > maximumReadBytes) {
            bounded = true;
            throw new Error("Dependency read budget reached; use --cwd PACKAGE_DIRECTORY to narrow the inventory");
        }
        const text = readText(source), bytes = Buffer.byteLength(text);
        readBytes += bytes;
        if (verify)
            verificationBytes += bytes;
        return text;
    };
    const addNode = (name, status = "internal") => { const key = `${status}\0${name}`; if (ids.has(key))
        return ids.get(key); if (nodes.length >= MAX_FILES) {
        bounded = true;
        return undefined;
    } const id = String(nodes.length); ids.set(key, id); nodes.push({ id, ...(status === "internal" ? { file: name } : { name }), status }); return id; };
    const start = addNode(file), seenEdges = new Set();
    const scan = async (source, targets) => {
        let parsed = scanned.get(source);
        if (!parsed) {
            if (attempted.has(source))
                return;
            if (attempted.size >= MAX_FILES) {
                bounded = true;
                return;
            }
            attempted.add(source);
            const text = readSource(source, true);
            snapshots.set(source, text);
            parsed = await parse(source, text, args, deadline);
            scanned.set(source, parsed);
        }
        for (const entry of imports(parsed)) {
            const target = moduleFile(root, source, entry);
            if (targets && (!target.file || !targets.has(target.file)))
                continue;
            const from = addNode(source), to = addNode(target.file ?? entry.specifier, target.status), key = `${from}\0${to}\0${entry.line}\0${entry.kind}`;
            if (from === undefined || to === undefined || edges.length >= 1000) {
                bounded = true;
                continue;
            }
            if (!seenEdges.has(key)) {
                seenEdges.add(key);
                edges.push({ from, to, ...entry, status: target.status });
            }
        }
    };
    const selectedNodes = new Set([start]), selectedEdges = new Set(), expanded = new Set();
    let frontier = [file];
    if (args.reverse) {
        const input = await inventory(root, deadline, 20_000);
        bounded ||= input.bounded;
        const files = input.files.filter(source => inside(scope, source) && (family(source) === family(file) || ["TypeScript", "JavaScript"].includes(family(source)) && ["TypeScript", "JavaScript"].includes(family(file))));
        totalFiles = input.total;
        for (const source of files) {
            try {
                checkDeadline(deadline);
                const info = statSync(source);
                if (prefilterBytes + info.size > maximumPrefilterBytes) {
                    bounded = true;
                    break;
                }
                const text = readSource(source);
                prefilterBytes += Buffer.byteLength(text);
                prefilteredFiles++;
                prefilterStates.set(source, { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
                for (const clue of importClues(source, text)) {
                    checkDeadline(deadline);
                    const target = moduleFile(root, source, clue).file;
                    if (!target)
                        continue;
                    let sources = incoming.get(target);
                    if (!sources)
                        incoming.set(target, sources = new Set());
                    if (!sources.has(source)) {
                        if (indexedEdges >= 100_000) {
                            bounded = true;
                            break;
                        }
                        sources.add(source);
                        indexedEdges++;
                    }
                }
            }
            catch (error) {
                errors.push({ file: source, error: String(error instanceof Error ? error.message : error) });
                if (Date.now() >= deadline) {
                    bounded = true;
                    break;
                }
            }
            if (indexedEdges >= 100_000)
                break;
        }
    }
    for (let level = 0; level < depth && frontier.length; level++) {
        if (args.reverse) {
            const targets = new Set(frontier), sources = [...new Set(frontier.flatMap(target => [...(incoming.get(target) ?? [])]))];
            const rank = (source) => (/[\\/](?:__init__\.pyi?|index\.[cm]?[jt]sx?|(?:lib|mod)\.rs)$/.test(source) ? 2 : 0) + (frontier.some(target => dirname(source) === dirname(target)) ? 1 : 0);
            for (const source of sources.sort((a, b) => rank(b) - rank(a) || a.localeCompare(b))) {
                candidates.add(source);
                try {
                    await scan(source, targets);
                }
                catch (error) {
                    errors.push({ file: source, error: String(error instanceof Error ? error.message : error) });
                    if (Date.now() >= deadline) {
                        bounded = true;
                        break;
                    }
                }
            }
        }
        const next = [];
        for (const source of frontier) {
            if (expanded.has(source))
                continue;
            expanded.add(source);
            if (expanded.size > MAX_FILES) {
                bounded = true;
                break;
            }
            if (!args.reverse)
                try {
                    await scan(source);
                }
                catch (error) {
                    errors.push({ file: source, error: String(error instanceof Error ? error.message : error) });
                    bounded ||= Date.now() >= deadline;
                    continue;
                }
            const id = ids.get(`internal\0${source}`);
            for (const edge of edges.filter(edge => (args.reverse ? edge.to : edge.from) === id)) {
                selectedEdges.add(edge);
                selectedNodes.add(String(edge.from));
                selectedNodes.add(String(edge.to));
                const target = nodes.find(node => node.id === (args.reverse ? edge.from : edge.to));
                if (target?.file && !expanded.has(String(target.file)))
                    next.push(String(target.file));
            }
        }
        frontier = [...new Set(next)];
    }
    for (const [source, state] of prefilterStates) {
        const current = statSync(source);
        if (current.size !== state.size || current.mtimeMs !== state.mtimeMs || current.ctimeMs !== state.ctimeMs)
            throw new Error(`Source changed during dependency analysis: ${source}; retry`);
    }
    for (const [source, text] of snapshots) {
        if (!safeFile(root, source))
            throw new Error(`Source changed during dependency analysis: ${source}; retry`);
        const current = readText(source);
        readBytes += Buffer.byteLength(current);
        if (current !== text)
            throw new Error(`Source changed during dependency analysis: ${source}; retry`);
    }
    const allNodes = nodes.filter(node => selectedNodes.has(String(node.id))), allEdges = [...selectedEdges], limit = args.limit || Infinity;
    const shownEdges = allEdges.slice(0, limit), shownIds = new Set([start, ...shownEdges.flatMap(edge => [String(edge.from), String(edge.to)])]), shownNodes = allNodes.filter(node => shownIds.has(String(node.id)));
    const truncated = shownEdges.length < allEdges.length;
    const data = { success: errors.length === 0, provider: "ast-grep", evidence: "syntax", file, root, scope, direction: args.reverse ? "in" : "out", depth, nodes: shownNodes, edges: shownEdges, totalNodes: allNodes.length, shownNodes: shownNodes.length, totalEdges: allEdges.length, shownEdges: shownEdges.length, scannedFiles: scanned.size, ...(totalFiles === undefined ? {} : { inventoryFiles: totalFiles, prefilteredFiles, candidateFiles: candidates.size, prefilterBytes }), readBytes, maximumReadBytes, complete: !bounded && errors.length === 0, bounded, truncated, errors, hint: "Static module paths; package aliases, conditional loading, generated modules and custom search paths may require compiler/runtime checks. External/unresolved nodes remain explicit." + (bounded ? " Reverse scans use up to 20,000 inventory files, 64 MiB prefilter input, 200 AST files and 128 MiB total reads; use --cwd PACKAGE_DIRECTORY containing the target to narrow scope, or increase --timeout." : "") };
    return { code: errors.length ? 1 : 0, data, human: [`Dependencies (${data.direction}): ${shownEdges.length} of ${allEdges.length} edges`, ...shownEdges.map(edge => `${relative(root, String(nodes.find(node => node.id === edge.from)?.file ?? ""))}:${edge.line} → ${edge.specifier} (${edge.status})`), ...(bounded ? ["Analysis bounded; narrow the project scope or increase --timeout."] : []), ...errors.map(error => `${error.file}: ${error.error}`)].join("\n") };
}
export async function apiDiff(args) {
    if (!args.base || args.apply)
        throw new Error("api-diff is read-only; use --base REF [--file PATH]");
    const root = realpathSync(gitRoot(args.cwd)), deadline = Date.now() + args.timeout;
    if (!existsSync(join(root, ".git")))
        throw new Error("api-diff requires a Git workspace");
    const base = (await git(root, ["rev-parse", "--verify", "--end-of-options", `${args.base}^{commit}`], deadline)).trim();
    if (!/^[0-9a-f]{40,64}$/.test(base))
        throw new Error("Invalid Git base revision");
    const oldFiles = new Set((await git(root, ["ls-tree", "-r", "--name-only", "-z", base], deadline)).split("\0").filter(Boolean));
    const changed = [...new Set([...numstatFiles(await git(root, ["diff", "--numstat", "--no-renames", "--no-ext-diff", "--no-textconv", "-z", base, "--"], deadline)), ...(await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], deadline)).split("\0")].filter(Boolean))];
    let requested;
    if (args.file) {
        requested = relative(root, resolve(args.cwd, args.file));
        if (requested === ".." || requested.startsWith(`..${sep}`))
            throw new Error("API diff file must be inside the Git workspace");
        requested = requested.split(sep).join("/");
    }
    const candidates = changed.filter(name => EXTENSIONS.includes(extname(name)) && (!requested || name === requested));
    let bounded = candidates.length > MAX_FILES;
    const changes = [], errors = [], snapshots = new Map(), cache = new Map();
    for (const name of candidates.slice(0, MAX_FILES)) {
        const file = resolve(root, name);
        try {
            checkDeadline(deadline);
            if (!insideWorkspace(root, file) || existsSync(file) && !safeFile(root, file))
                throw new Error(`Unsafe API analysis path: ${file}`);
            const before = oldFiles.has(name) ? await git(root, ["cat-file", "blob", `${base}:${name}`], deadline) : "", after = existsSync(file) ? readText(file) : "";
            if (Buffer.byteLength(before) > MAX_FILE_BYTES)
                throw new Error(`Base file exceeds 16 MiB: ${file}`);
            snapshots.set(file, existsSync(file) ? after : undefined);
            const oldParsed = await parse(file, before, args, deadline), currentParsed = await parse(file, after, args, deadline);
            cache.set(file, currentParsed);
            const previous = surfaces(oldParsed), current = surfaces(currentParsed), keys = new Set([...previous, ...current].map(item => `${item.kind}\0${item.name}`));
            for (const key of keys) {
                const old = previous.filter(item => `${item.kind}\0${item.name}` === key), fresh = current.filter(item => `${item.kind}\0${item.name}` === key);
                if (JSON.stringify(old.map(item => [item.signature, item.visibility])) === JSON.stringify(fresh.map(item => [item.signature, item.visibility])))
                    continue;
                changes.push({ id: String(changes.length), file, name: (fresh[0] ?? old[0]).name, kind: (fresh[0] ?? old[0]).kind, change: !old.length ? "added" : !fresh.length ? "removed" : "modified", before: old, after: fresh, candidateCalls: [] });
            }
        }
        catch (error) {
            errors.push({ file, error: String(error instanceof Error ? error.message : error) });
            if (Date.now() >= deadline) {
                bounded = true;
                break;
            }
        }
    }
    const surfaceComplete = !bounded && errors.length === 0, surfaceErrors = errors.length;
    const scanInput = changes.length ? await inventory(root, deadline).catch(error => { errors.push({ error: String(error) }); return { files: [], bounded: true, total: 0 }; }) : { files: [], bounded: false, total: 0 };
    bounded ||= scanInput.bounded;
    let scannedFiles = 0;
    for (const file of scanInput.files) {
        try {
            checkDeadline(deadline);
            const text = snapshots.get(file) ?? readText(file);
            snapshots.set(file, text);
            const parsed = cache.get(file) ?? await parse(file, text, args, deadline);
            scannedFiles++;
            for (const call of parsed.nodes.filter(node => node.kind === "call")) {
                const callee = call.captures.CALLEE;
                if (!callee)
                    continue;
                const name = callee.text.match(/(?:r#)?([\p{L}_][\p{L}\p{N}_]*)\s*(?:::<[^>]*>)?$/u)?.[1];
                for (const change of changes.filter(change => String(change.name).split(".").at(-1) === name)) {
                    const calls = change.candidateCalls;
                    if (calls.length < 20)
                        calls.push({ file, ...point(text, callee.start), callee: callee.text, evidence: "same-name-call", verified: false });
                    else
                        change.callsBounded = true;
                }
            }
        }
        catch (error) {
            errors.push({ file, error: String(error instanceof Error ? error.message : error) });
            if (Date.now() >= deadline) {
                bounded = true;
                break;
            }
        }
    }
    for (const [file, text] of snapshots)
        if (text === undefined ? existsSync(file) : !safeFile(root, file) || readText(file) !== text)
            throw new Error(`Source changed during API analysis: ${file}; retry`);
    const selected = changes.slice(0, args.limit || Infinity), counts = { added: changes.filter(item => item.change === "added").length, removed: changes.filter(item => item.change === "removed").length, modified: changes.filter(item => item.change === "modified").length };
    const callsComplete = !scanInput.bounded && errors.length === surfaceErrors && !changes.some(change => change.callsBounded);
    const data = { success: errors.length === 0, provider: "ast-grep", evidence: "syntax", compatibility: "unverified", base, root, changes: selected, counts, total: changes.length, shown: selected.length, scannedFiles, changedFiles: candidates.length, surfaceComplete, callsComplete, callInventoryFiles: scanInput.total, complete: surfaceComplete && callsComplete, bounded: bounded || !callsComplete, truncated: selected.length < changes.length, errors, hint: "Public-looking syntax and same-name call candidates; type inference, aliases, cfg/features, decorators, macros and dynamic exports require compiler/runtime verification." };
    return { code: errors.length ? 1 : 0, data, human: [`API syntax diff: ${counts.added} added, ${counts.removed} removed, ${counts.modified} modified`, ...selected.map(item => `${relative(root, String(item.file))}: ${item.change} ${item.name}`), data.hint, ...errors.map(error => `${error.file ?? root}: ${error.error}`)].join("\n") };
}
