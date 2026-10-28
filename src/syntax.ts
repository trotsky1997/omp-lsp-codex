import childProcess from "node:child_process";
import { isUtf8 } from "node:buffer";
import { dirname, extname } from "node:path";
import { tmpdir } from "node:os";
import { object, resolveCommand, type ObjectValue } from "./config.ts";
import { windowsCommand } from "./windows-command.ts";
import { textPrefix } from "./output.ts";
import type { Position } from "./omp/types.ts";

const INSTALL = "Install ast-grep: npm install --global @ast-grep/cli (https://ast-grep.github.io/guide/quick-start.html)";
const LANGUAGES: Record<string, string> = {
  ".rs": "Rust", ".py": "Python", ".pyi": "Python",
  ".ts": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript", ".tsx": "Tsx",
  ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "Jsx",
};
const DECLARATIONS: Record<string, string[]> = {
  Rust: ["function_item", "function_signature_item", "struct_item", "enum_item", "union_item", "impl_item", "trait_item", "mod_item", "type_item", "const_item", "static_item", "macro_definition"],
  Python: ["function_definition", "class_definition", "decorated_definition", "assignment"],
  TypeScript: ["function_declaration", "generator_function_declaration", "method_definition", "method_signature", "property_signature", "abstract_method_signature", "public_field_definition", "arrow_function", "function_expression", "generator_function", "class_declaration", "abstract_class_declaration", "interface_declaration", "type_alias_declaration", "enum_declaration", "lexical_declaration", "variable_declaration"],
  JavaScript: ["function_declaration", "generator_function_declaration", "method_definition", "field_definition", "arrow_function", "function_expression", "generator_function", "class_declaration", "lexical_declaration", "variable_declaration"],
};
const IDENTIFIERS: Record<string, string[]> = {
  Rust: ["identifier", "type_identifier", "field_identifier", "scoped_identifier", "scoped_type_identifier", "primitive_type", "self", "super", "crate"],
  Python: ["identifier", "attribute"],
  TypeScript: ["identifier", "property_identifier", "type_identifier", "nested_type_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern", "private_property_identifier", "predefined_type", "member_expression", "this", "super"],
};
function grammar(language: string) { return language === "Tsx" ? "TypeScript" : language === "Jsx" ? "JavaScript" : language; }
export function syntaxLanguage(path: string) { return LANGUAGES[extname(path).toLowerCase()]; }
interface Node {
  text: string;
  start: number;
  end: number;
}
interface Match extends Node {
  rule: string;
  captures: Record<string, Node>;
}
function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function symbolSpec(value: string) {
  const match = value.match(/^(.+)#(\d+)$/);
  return { name: match?.[1] ?? value, occurrence: match ? Math.max(1, Number(match[2])) : 1 };
}
function decodeNode(value: unknown, source: Buffer): Node {
  const item = object(value), bytes = object(object(item.range).byteOffset);
  const start = bytes.start, end = bytes.end;
  if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.length ||
      typeof item.text !== "string" || !isUtf8(source.subarray(start, end)) || source.subarray(start, end).toString("utf8") !== item.text)
    throw new Error("Invalid ast-grep source range");
  return { text: item.text, start, end };
}
function point(source: Buffer, offset: number): Position {
  const prefix = source.subarray(0, offset).toString("utf8"), newline = prefix.lastIndexOf("\n");
  return { line: prefix.split("\n").length - 1, character: prefix.length - newline - 1 };
}
export function syntaxTool(root: string, globalOnly = false) {
  const command = resolveCommand("ast-grep", root, globalOnly);
  return { available: !!command, command: command ?? null, ...(!command ? { hint: INSTALL } : {}) };
}
async function scan(path: string, text: string, mode: "symbol" | "call" | "snippet" | "lookup", symbol?: string, globalOnly = false): Promise<Match[] | undefined> {
  const language = syntaxLanguage(path);
  if (!language) return undefined;
  const { command } = syntaxTool(dirname(path), globalOnly);
  if (!command) return undefined;
  const rules: ObjectValue[] = [];
  const family = grammar(language);
  const identifiers = IDENTIFIERS[family] ?? IDENTIFIERS.TypeScript.filter(kind => !["type_identifier", "nested_type_identifier", "predefined_type"].includes(kind));
  if (symbol) rules.push({ id: "symbol", language, rule: { all: [
    { any: identifiers.map(kind => ({ kind })) },
    { regex: `(?i)^${escapeRegex(symbolSpec(symbol).name)}$` },
  ] } });
  if (mode === "call") rules.push({ id: "call", language, rule: {
    any: (language === "Python" ? ["call"] : language === "Rust" ? ["call_expression"] : ["call_expression", "new_expression"]).map(kind => ({ kind })),
    all: [
      language === "Python" || language === "Rust"
        ? { has: { field: "function", pattern: "$CALLEE" } }
        : { any: [{ has: { field: "function", pattern: "$CALLEE" } }, { has: { field: "constructor", pattern: "$CALLEE" } }] },
      { has: { field: "arguments", pattern: "$ARGS" } },
    ],
  } });
  const declarations = DECLARATIONS[family];
  if (mode === "lookup") {
    rules.push({ id: "lookup", language, rule: { all: [
      { any: [...declarations, ...(["TypeScript", "JavaScript"].includes(family) ? ["variable_declarator"] : [])].map(kind => ({ kind })) },
      { has: { field: "name", pattern: "$NAME", stopBy: "end" } },
    ] } });
    if (family === "Rust") rules.push({ id: "owner", language, rule: { all: [{ kind: "impl_item" }, { has: { field: "type", pattern: "$NAME", stopBy: "end" } }] } });
    if (family === "Python") rules.push({ id: "binding", language, rule: { all: [{ kind: "assignment" }, { has: { field: "left", pattern: "$NAME", stopBy: "end" } }] } });
  }
  if (mode === "snippet") rules.push({ id: "snippet", language, rule: { any: declarations.map(kind => ({ kind })) } });
  if (mode === "snippet" && language === "Rust") rules.push(
    { id: "attribute", language, rule: { kind: "attribute_item" } },
    { id: "trivia", language, rule: { any: [{ kind: "line_comment" }, { kind: "block_comment" }] } },
  );
  const args = ["scan", "--stdin", "--inline-rules", rules.map(rule => JSON.stringify(rule)).join("\n---\n"), "--json=compact"];
  const invocation = process.platform === "win32" && /\.(cmd|bat)$/i.test(command)
    ? windowsCommand(command, args) : { command, args, windowsVerbatimArguments: false };
  const stdout = await new Promise<string>((resolve, reject) => {
    const proc = childProcess.execFile(invocation.command, invocation.args, {
      cwd: tmpdir(), encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`ast-grep failed: ${String(stderr || error.message).slice(0, 1000)}; ${INSTALL}`));
      else resolve(stdout);
    });
    proc.stdin?.on("error", error => {
      proc.kill("SIGKILL");
      reject(new Error(`ast-grep input failed: ${String(error).slice(0, 1000)}`));
    });
    proc.stdin?.end(text);
  });
  const values: unknown = JSON.parse(stdout);
  if (!Array.isArray(values)) throw new Error("Invalid ast-grep response: expected an array");
  const source = Buffer.from(text);
  return values.map(value => {
    const item = object(value), single = object(object(item.metaVariables).single);
    const node = decodeNode(item, source);
    if (typeof item.ruleId !== "string" || !rules.some(rule => rule.id === item.ruleId)) throw new Error("Invalid ast-grep rule result");
    const captures = Object.fromEntries(
      Object.entries(single).map(([key, value]) => [key, decodeNode(value, source)]),
    );
    if (Object.values(captures).some(capture => capture.start < node.start || capture.end > node.end)) throw new Error("Invalid ast-grep capture range");
    if (item.ruleId === "call" && (!captures.CALLEE?.text || !captures.ARGS || captures.CALLEE.end > captures.ARGS.start ||
        !(captures.ARGS.text.startsWith("(") || ["TypeScript", "JavaScript"].includes(family) && captures.ARGS.text.startsWith("`"))))
      throw new Error("Invalid ast-grep call captures");
    return { ...node, rule: item.ruleId, captures };
  });
}
export async function syntaxLookup(path: string, text: string, spec: string, globalOnly = false) {
  const matches = await scan(path, text, "lookup", undefined, globalOnly);
  if (!matches) throw new Error(`Symbol lookup requires a supported grammar and ast-grep. ${INSTALL}`);
  const source = Buffer.from(text), { name, occurrence } = symbolSpec(spec), parts = name.split(/::|\./), leaf = parts.at(-1)!;
  const names = (node: Match) => (node.captures.NAME?.text ?? "").replace(/<.*$/s, "").split("::").at(-1)!;
  const candidates = matches.filter(node => ["lookup", "binding"].includes(node.rule) && names(node).toLowerCase() === leaf.toLowerCase()).map(node => {
    const parents = matches.filter(parent => parent.start <= node.start && parent.end >= node.end && (parent.start < node.start || parent.end > node.end)).sort((a, b) => a.start - b.start || b.end - a.end);
    const qualified = [...parents.map(names), names(node)].filter(Boolean).join(".");
    return { file: path, symbol: qualified, ...point(source, node.captures.NAME.start) };
  }).filter(node => parts.length === 1 || node.symbol.toLowerCase() === parts.join(".").toLowerCase() || node.symbol.toLowerCase().endsWith("." + parts.join(".").toLowerCase())).sort((a, b) => a.line - b.line || a.character - b.character);
  const exact = candidates.filter(node => node.symbol.split(".").at(-1) === leaf), selected = exact.length ? exact : candidates;
  const unique = [...new Map(selected.map(node => [`${node.line}:${node.character}`, node])).values()];
  const chosen = /#\d+$/.test(spec) ? unique[occurrence - 1] : unique.length === 1 ? unique[0] : undefined;
  return { position: chosen ? { line: chosen.line, character: chosen.character } : undefined, candidates: unique.map(({ character, line, ...node }) => ({ ...node, line: line + 1, column: character + 1 })) };
}

function selectSymbol(matches: Match[], source: Buffer, line: number, spec: string): Node {
  const { name, occurrence } = symbolSpec(spec), all = matches.filter(match => match.rule === "symbol")
    .sort((a, b) => a.start - b.start);
  const onLine = all.filter(match => point(source, match.start).line === line - 1);
  const exact = onLine.filter(match => match.text === name), candidates = exact.length ? exact : onLine;
  if (!candidates.length) {
    const nearest = [...new Set(all.map(match => point(source, match.start).line + 1))]
      .sort((a, b) => Math.abs(a - line) - Math.abs(b - line) || a - b).slice(0, 5);
    throw new Error(`Symbol "${name}" not found on line ${line}; comments and string contents are excluded${nearest.length ? `; nearest matching lines: ${nearest.join(", ")}` : "; no matching code identifier"}`);
  }
  if (occurrence > candidates.length) throw new Error(`Symbol "${name}" occurrence ${occurrence} is out of bounds on line ${line} (found ${candidates.length})`);
  return candidates[occurrence - 1];
}
export async function syntaxPosition(path: string, text: string, line: number, symbol?: string, call = false, globalOnly = false): Promise<Position | undefined> {
  if (!symbol && !call) return undefined;
  const matches = await scan(path, text, call ? "call" : "symbol", symbol, globalOnly);
  if (!matches) {
    if (call && LANGUAGES[extname(path).toLowerCase()]) throw new Error(`Automatic signature-help requires ast-grep. ${INSTALL}; alternatively pass --column inside the call's arguments`);
    return undefined;
  }
  const source = Buffer.from(text);
  if (!call) return point(source, selectSymbol(matches, source, line, symbol!).start);
  const calls = matches.filter(match => match.rule === "call" && match.captures.CALLEE && match.captures.ARGS);
  const contains = (match: Match, node: Node) => match.captures.CALLEE.start <= node.start && node.end <= match.captures.CALLEE.end;
  // Count callable occurrences, excluding type annotations and same-name argument values.
  const callableSymbols = matches.filter(match => match.rule === "symbol" && calls.some(call => contains(call, match)));
  const noCall = () => {
    const here = [...new Set(calls.filter(call => point(source, call.captures.CALLEE.end).line === line - 1)
      .map(call => textPrefix(call.captures.CALLEE.text.replace(/\s+/g, " "), 80)))].slice(0, 5);
    const nearby = callableSymbols.map(node => {
      const row = point(source, node.start).line + 1;
      const callee = calls.filter(call => contains(call, node)).sort((a, b) =>
        (a.captures.CALLEE.end - a.captures.CALLEE.start) - (b.captures.CALLEE.end - b.captures.CALLEE.start))[0].captures.CALLEE.text;
      return { row, label: `${row} (${textPrefix(callee.replace(/\s+/g, " "), 80)})` };
    }).sort((a, b) => Math.abs(a.row - line) - Math.abs(b.row - line) || a.row - b.row);
    const hints = [...new Set(nearby.map(item => item.label))].slice(0, here.length ? 1 : 5);
    return new Error(`No matching call on line ${line}${here.length ? `; calls here: ${here.join(", ")}` : ""}; ${hints.length ? `call-name matches: ${hints.join(", ")}; select a call site with --line` : "select a real call site with --symbol NAME (comments and string contents are excluded)"}, or pass --column inside its arguments${syntaxLanguage(path) === "Rust" && !hints.length ? "; Rust macro token trees may require explicit columns, and the server may have no semantic signature for the template" : ""}`);
  };
  let anchor: Node | undefined;
  if (symbol) {
    if (!callableSymbols.some(match => point(source, match.start).line === line - 1)) throw noCall();
    anchor = selectSymbol(callableSymbols, source, line, symbol);
  }
  const selected = calls.filter(match => anchor ? contains(match, anchor) : point(source, match.captures.CALLEE.start).line === line - 1)
    .sort((a, b) => (a.captures.CALLEE.end - a.captures.CALLEE.start) - (b.captures.CALLEE.end - b.captures.CALLEE.start));
  if (!selected.length) throw noCall();
  if (!symbol && selected.length !== 1) throw new Error("Multiple calls on this line; select --symbol NAME (NAME#2 for repeated calls), or pass --column inside the intended call's arguments");
  return point(source, selected[0].captures.ARGS.start + 1);
}
export async function syntaxSnippet(path: string, text: string, line: number, column?: number, symbol?: string, globalOnly = false) {
  const matches = await scan(path, text, "snippet", symbol, globalOnly);
  if (!matches) throw new Error(`snippet supports Rust, Python and JavaScript/TypeScript and requires ast-grep. ${INSTALL}`);
  const source = Buffer.from(text);
  const pos = symbol ? point(source, selectSymbol(matches, source, line, symbol).start) : { line: line - 1, character: (column ?? 1) - 1 };
  const lines = text.split("\n");
  const offset = Buffer.byteLength(lines.slice(0, pos.line).join("\n") + (pos.line ? "\n" : "") + lines[pos.line].slice(0, pos.character));
  const candidates = matches.filter(match => match.rule === "snippet" && match.start <= offset && offset < match.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start));
  let selected = candidates[0];
  if (!selected) throw new Error("No enclosing declaration at this position; pass --symbol NAME on a declaration or a --column inside its body");
  if (syntaxLanguage(path) === "Python" && /^(?:async )?(?:def|class)\b/.test(selected.text))
    selected = candidates.find(match => match.end === selected.end && match.text.startsWith("@")) ?? selected;
  if (syntaxLanguage(path) === "Rust") {
    let cursor = selected.start;
    const prefix = matches.filter(match => ["attribute", "trivia"].includes(match.rule) && match.end <= selected.start)
      .sort((a, b) => b.end - a.end);
    for (const node of prefix) {
      if (source.subarray(node.end, cursor).toString("utf8").trim()) break;
      cursor = node.start;
      if (node.rule === "attribute") selected = { ...selected, start: node.start, text: source.subarray(node.start, selected.end).toString("utf8") };
    }
  }
  return { text: selected.text, start: point(source, selected.start), end: point(source, selected.end) };
}
