import childProcess from "node:child_process";
import { dirname, extname } from "node:path";
import { tmpdir } from "node:os";
import { object, resolveCommand } from "./config.js";
import { windowsCommand } from "./windows-command.js";
const INSTALL = "Install ast-grep: npm install --global @ast-grep/cli (https://ast-grep.github.io/guide/quick-start.html)";
const LANGUAGES = {
    ".rs": "Rust", ".py": "Python", ".pyi": "Python",
    ".ts": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript", ".tsx": "Tsx",
    ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "Jsx",
};
const DECLARATIONS = {
    Rust: ["function_item", "function_signature_item", "struct_item", "enum_item", "union_item", "impl_item", "trait_item", "mod_item", "type_item", "const_item", "static_item", "macro_definition"],
    Python: ["function_definition", "class_definition", "decorated_definition", "assignment"],
    TypeScript: ["function_declaration", "generator_function_declaration", "method_definition", "method_signature", "property_signature", "abstract_method_signature", "public_field_definition", "arrow_function", "function_expression", "generator_function", "class_declaration", "abstract_class_declaration", "interface_declaration", "type_alias_declaration", "enum_declaration", "lexical_declaration", "variable_declaration"],
    JavaScript: ["function_declaration", "generator_function_declaration", "method_definition", "field_definition", "arrow_function", "function_expression", "generator_function", "class_declaration", "lexical_declaration", "variable_declaration"],
};
const IDENTIFIERS = {
    Rust: ["identifier", "type_identifier", "field_identifier", "scoped_identifier", "scoped_type_identifier", "primitive_type", "self", "super", "crate"],
    Python: ["identifier", "attribute"],
    TypeScript: ["identifier", "property_identifier", "type_identifier", "nested_type_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern", "private_property_identifier", "predefined_type", "member_expression", "this", "super"],
};
function grammar(language) { return language === "Tsx" ? "TypeScript" : language === "Jsx" ? "JavaScript" : language; }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function symbolSpec(value) {
    const match = value.match(/^(.+)#(\d+)$/);
    return { name: match?.[1] ?? value, occurrence: match ? Math.max(1, Number(match[2])) : 1 };
}
function decodeNode(value, source) {
    const item = object(value), bytes = object(object(item.range).byteOffset);
    const start = Number(bytes.start), end = Number(bytes.end);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.length ||
        typeof item.text !== "string" || source.subarray(start, end).toString("utf8") !== item.text)
        throw new Error("Invalid ast-grep source range");
    return { text: item.text, start, end };
}
function point(source, offset) {
    const prefix = source.subarray(0, offset).toString("utf8"), newline = prefix.lastIndexOf("\n");
    return { line: prefix.split("\n").length - 1, character: prefix.length - newline - 1 };
}
export function syntaxTool(root, globalOnly = false) {
    const command = resolveCommand("ast-grep", root, globalOnly);
    return { available: !!command, command: command ?? null, ...(!command ? { hint: INSTALL } : {}) };
}
async function scan(path, text, mode, symbol, globalOnly = false) {
    const language = LANGUAGES[extname(path).toLowerCase()];
    if (!language)
        return undefined;
    const { command } = syntaxTool(dirname(path), globalOnly);
    if (!command)
        return undefined;
    const rules = [];
    const family = grammar(language);
    const identifiers = IDENTIFIERS[family] ?? IDENTIFIERS.TypeScript.filter(kind => !["type_identifier", "nested_type_identifier", "predefined_type"].includes(kind));
    if (symbol)
        rules.push({ id: "symbol", language, rule: { all: [
                    { any: identifiers.map(kind => ({ kind })) },
                    { regex: `(?i)^${escapeRegex(symbolSpec(symbol).name)}$` },
                ] } });
    if (mode === "call")
        rules.push({ id: "call", language, rule: {
                any: (language === "Python" ? ["call"] : language === "Rust" ? ["call_expression"] : ["call_expression", "new_expression"]).map(kind => ({ kind })),
                all: [
                    language === "Python" || language === "Rust"
                        ? { has: { field: "function", pattern: "$CALLEE" } }
                        : { any: [{ has: { field: "function", pattern: "$CALLEE" } }, { has: { field: "constructor", pattern: "$CALLEE" } }] },
                    { has: { field: "arguments", pattern: "$ARGS" } },
                ],
            } });
    const declarations = DECLARATIONS[family];
    if (mode === "snippet")
        rules.push({ id: "snippet", language, rule: { any: declarations.map(kind => ({ kind })) } });
    const args = ["scan", "--stdin", "--inline-rules", rules.map(rule => JSON.stringify(rule)).join("\n---\n"), "--json=compact"];
    const invocation = process.platform === "win32" && /\.(cmd|bat)$/i.test(command)
        ? windowsCommand(command, args) : { command, args, windowsVerbatimArguments: false };
    const stdout = await new Promise((resolve, reject) => {
        const proc = childProcess.execFile(invocation.command, invocation.args, {
            cwd: tmpdir(), encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 * 1024,
            windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        }, (error, stdout, stderr) => {
            if (error)
                reject(new Error(`ast-grep failed: ${String(stderr || error.message).slice(0, 1000)}; ${INSTALL}`));
            else
                resolve(stdout);
        });
        proc.stdin?.on("error", () => { });
        proc.stdin?.end(text);
    });
    const values = JSON.parse(stdout);
    if (!Array.isArray(values))
        throw new Error("Invalid ast-grep response: expected an array");
    const source = Buffer.from(text);
    return values.map(value => {
        const item = object(value), single = object(object(item.metaVariables).single);
        return { ...decodeNode(item, source), rule: String(item.ruleId), captures: Object.fromEntries(Object.entries(single).map(([key, value]) => [key, decodeNode(value, source)])) };
    });
}
function selectSymbol(matches, source, line, spec) {
    const { name, occurrence } = symbolSpec(spec), all = matches.filter(match => match.rule === "symbol")
        .sort((a, b) => a.start - b.start);
    const onLine = all.filter(match => point(source, match.start).line === line - 1);
    const exact = onLine.filter(match => match.text === name), candidates = exact.length ? exact : onLine;
    if (!candidates.length) {
        const nearest = [...new Set(all.map(match => point(source, match.start).line + 1))]
            .sort((a, b) => Math.abs(a - line) - Math.abs(b - line) || a - b).slice(0, 5);
        throw new Error(`Symbol "${name}" not found on line ${line}; comments and string contents are excluded${nearest.length ? `; nearest matching lines: ${nearest.join(", ")}` : "; no matching code identifier"}`);
    }
    if (occurrence > candidates.length)
        throw new Error(`Symbol "${name}" occurrence ${occurrence} is out of bounds on line ${line} (found ${candidates.length})`);
    return candidates[occurrence - 1];
}
export async function syntaxPosition(path, text, line, symbol, call = false, globalOnly = false) {
    if (!symbol && !call)
        return undefined;
    const matches = await scan(path, text, call ? "call" : "symbol", symbol, globalOnly);
    if (!matches) {
        if (call && LANGUAGES[extname(path).toLowerCase()])
            throw new Error(`Automatic signature-help requires ast-grep. ${INSTALL}; alternatively pass --column inside the call's arguments`);
        return undefined;
    }
    const source = Buffer.from(text);
    if (!call)
        return point(source, selectSymbol(matches, source, line, symbol).start);
    const calls = matches.filter(match => match.rule === "call" && match.captures.CALLEE && match.captures.ARGS);
    const contains = (match, node) => match.captures.CALLEE.start <= node.start && node.end <= match.captures.CALLEE.end;
    // Count callable occurrences, excluding type annotations and same-name argument values.
    const callableSymbols = matches.filter(match => match.rule === "symbol" && calls.some(call => contains(call, match)));
    const noCall = () => new Error(`No matching call on this line; select a call site with --symbol NAME, or pass --column inside its arguments${extname(path) === ".rs" ? "; Rust macro token trees may require explicit columns, and the server may have no semantic signature for the template" : ""}`);
    let anchor;
    if (symbol) {
        selectSymbol(matches, source, line, symbolSpec(symbol).name);
        if (!callableSymbols.some(match => point(source, match.start).line === line - 1))
            throw noCall();
        anchor = selectSymbol(callableSymbols, source, line, symbol);
    }
    const selected = calls.filter(match => anchor ? contains(match, anchor) : point(source, match.captures.CALLEE.start).line === line - 1)
        .sort((a, b) => (a.captures.CALLEE.end - a.captures.CALLEE.start) - (b.captures.CALLEE.end - b.captures.CALLEE.start));
    if (!selected.length)
        throw noCall();
    if (!symbol && selected.length !== 1)
        throw new Error("Multiple calls on this line; select --symbol NAME (NAME#2 for repeated calls), or pass --column inside the intended call's arguments");
    return point(source, selected[0].captures.ARGS.start + 1);
}
export async function syntaxSnippet(path, text, line, column, symbol, globalOnly = false) {
    const matches = await scan(path, text, "snippet", symbol, globalOnly);
    if (!matches)
        throw new Error(`snippet supports Rust, Python and JavaScript/TypeScript and requires ast-grep. ${INSTALL}`);
    const source = Buffer.from(text);
    const pos = symbol ? point(source, selectSymbol(matches, source, line, symbol).start) : { line: line - 1, character: (column ?? 1) - 1 };
    const lines = text.split("\n");
    const offset = Buffer.byteLength(lines.slice(0, pos.line).join("\n") + (pos.line ? "\n" : "") + lines[pos.line].slice(0, pos.character));
    const candidates = matches.filter(match => match.rule === "snippet" && match.start <= offset && offset < match.end)
        .sort((a, b) => (a.end - a.start) - (b.end - b.start));
    let selected = candidates[0];
    if (!selected)
        throw new Error("No enclosing declaration at this position; pass --symbol NAME on a declaration or a --column inside its body");
    if (LANGUAGES[extname(path).toLowerCase()] === "Python" && /^(?:async )?(?:def|class)\b/.test(selected.text))
        selected = candidates.find(match => match.end === selected.end && match.text.startsWith("@")) ?? selected;
    return { text: selected.text, start: point(source, selected.start), end: point(source, selected.end) };
}
