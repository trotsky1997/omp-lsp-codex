import assert from "node:assert/strict";
import { after, afterEach, before, mock, test } from "node:test";
import childProcess from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { position, run } from "../src/commands.ts";
import { parseOptions } from "../src/cli.ts";
import { resolveCommand, type ObjectValue } from "../src/config.ts";
import { syntaxLookup, syntaxPosition, syntaxSnippet } from "../src/syntax.ts";
import { LspClient } from "../src/client.ts";
import { cleanWorkspaces, isolateGlobalConfig, workspace } from "./fixtures/workspace.ts";

let root: string, restore: () => void;
before(() => { root = mkdtempSync(join(tmpdir(), "codex-lsp syntax ")); restore = isolateGlobalConfig(); });
after(() => { restore(); rmSync(root, { recursive: true, force: true }); });
afterEach(() => { mock.restoreAll(); cleanWorkspaces(); });
const installed = !!resolveCommand("ast-grep", tmpdir());
const real = { skip: installed ? false : "Install @ast-grep/cli for real syntax integration tests" };
function file(text: string, extension = "ts") { const path = join(root, `source.${extension}`); writeFileSync(path, text); return path; }

for (const [extension, source, expected] of [
  ["ts", '// Parser.parse\nclass Parser { parse() { return "😀" } }\nclass MyParser { parse() {} }\nnew Parser().parse()', { line: 1, character: 15 }],
  ["py", 'class Parser:\n    def parse(self):\n        return "😀"\n\nParser().parse()', { line: 1, character: 8 }],
  ["rs", 'struct Parser;\nimpl Parser { fn parse(&self) -> i32 { 1 } }', { line: 1, character: 17 }],
] as const) test(`lookup: ${extension} resolves qualified declarations without confusing calls or owner suffixes`, real, async () => {
  const path = file(source, extension), result = await syntaxLookup(path, source, extension === "rs" ? "Parser::parse" : "Parser.parse");
  assert.deepEqual(result.position, expected); assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].symbol, "Parser.parse"); assert.equal(readFileSync(path, "utf8"), source);
});

test("lookup: ambiguous names return candidates before LSP startup and explicit positions stay exact", real, async () => {
  const text = 'class A { parse() {} }\nclass B { parse() {} }\n', path = file(text);
  const result = await run(parseOptions(["inspect", "--file", path, "--symbol", "parse"], root));
  assert.equal(result.code, 1); assert.equal(result.data.reason, "ambiguous-symbol"); assert.equal(result.data.total, 2); assert.equal(LspClient.active.size, 0);
  const qualified = await run(parseOptions(["snippet", "--file", path, "--symbol", "B.parse"], root)); assert.equal(qualified.data.found, true); assert.match(String(qualified.data.snippet), /parse/); assert.equal((qualified.data.range as { start: { line: number } }).start.line, 2);
  const second = await syntaxLookup(path, text, "parse#2"); assert.equal(second.position?.line, 1);
  assert.deepEqual(await position(path, text, { line: 1, column: 1 }), { line: 0, character: 0 });
});

test("lookup: variable declarations rank over uses and Unicode offsets remain UTF-16", real, async () => {
  const source = 'const 汉字 = "😀"; const parse = () => 1;\nparse();'; const path = file(source);
  const result = await syntaxLookup(path, source, "parse"); assert.deepEqual(result.position, { line: 0, character: source.indexOf("parse") }); assert.equal(result.candidates.length, 1);
});

for (const [extension, text, line] of [
  ["ts", 'const s = "target"; /* target */ const 汉字 = "😀"; target(target);', 1],
  ["tsx", 'const s = "target"; /* target */ const 汉字 = "😀"; target(target);', 1],
  ["js", 'const s = "target"; /* target */ const 汉字 = "😀"; target(target);', 1],
  ["jsx", 'const s = "target"; /* target */ const 汉字 = "😀"; target(target);', 1],
  ["mts", 'const s = "target"; /* target */ const 汉字 = "😀"; target(target);', 1],
  ["cts", 'const s = "target"; /* target */ const 汉字 = "😀"; target(target);', 1],
  ["py", 's = "target"; 汉字 = "😀"; target(target) # target', 1],
  ["rs", 'fn main() { let s = "target"; /* target */ let 汉字 = "😀"; target(target); }', 1],
] as const) test(`syntax: ${extension} excludes comments/strings and preserves UTF-16`, real, async () => {
  const path = file(text, extension), expected = text.indexOf("target(target)");
  assert.deepStrictEqual(await position(path, text, { line, symbol: "target" }), { line: 0, character: expected });
  assert.deepStrictEqual(await position(path, text, { line, symbol: "target#2" }), { line: 0, character: expected + 7 });
  await assert.rejects(position(path, text, { line, symbol: "target#3" }), /out of bounds.*found 2/);
  assert.strictEqual(readFileSync(path, "utf8"), text);
});
test("syntax: nearby suggestions exclude comments and strings", real, async () => {
  const text = '// target\nconst s = "target";\n\nfunction target() {}\ntarget();';
  const path = file(text);
  await assert.rejects(position(path, text, { line: 1, symbol: "target" }), /nearest matching lines: 4, 5/);
});
test("syntax: source snapshots are used instead of rereading disk", real, async () => {
  const path = file("target();");
  assert.deepStrictEqual(await position(path, 'const s = "target"; target();', { line: 1, symbol: "target" }), { line: 0, character: 20 });
});
test("syntax: private fields and Unicode identifiers are literal anchors", real, async () => {
  const text = "class X { #私有 = 1; value() { return this.#私有; } }";
  const path = file(text);
  assert.deepStrictEqual(await position(path, text, { line: 1, symbol: "#私有#2" }), { line: 0, character: text.lastIndexOf("#私有") });
});
for (const [extension, text, line, name, cursor] of [
  ["ts", 'expect(foo<number>("x", bar(1)));', 1, "foo", '("x"'],
  ["ts", 'expect(new Foo("x"));', 1, "Foo", '("x"'],
  ["ts", 'class X { field: Foo = this.register(new Foo("x")); }', 1, "Foo", '("x"'],
  ["ts", 'class X { field: Foo<T> = this.register(new Foo<T>("x")); }', 1, "Foo", '("x"'],
  ["ts", 'const value: Foo = Foo("x", Foo);', 1, "Foo", '("x"'],
  ["ts", 'foo("x")();', 1, "foo", '("x"'],
  ["py", 'expect(foo("x", bar(1)))', 1, "foo", '("x"'],
  ["rs", 'fn main() { expect(foo::<u32>(42, bar(1))); }', 1, "foo", "(42"],
  ["ts", 'foo\r\n(\r\n  "😀"\r\n);', 1, "foo", "(\r\n"],
  ["ts", 'foo\n            (\n  "😀"\n);', 1, "foo", "(\n"],
] as const) test(`signature: ${extension} selects ${name} argument cursor`, real, async () => {
  const path = file(text, extension), offset = text.indexOf(cursor) + 1, prefix = text.slice(0, offset).split("\n");
  assert.deepStrictEqual(await position(path, text, { command: "signature-help", line, symbol: name }), { line: prefix.length - 1, character: prefix.at(-1)!.length });
  assert.deepStrictEqual(await position(path, text, { command: "signature-help", line: 1, column: 2 }), { line: 0, character: 1 });
});
test("signature: ambiguous calls and declaration anchors fail before LSP starts", real, async () => {
  const text = 'function foo() {}\nexpect(foo());'; const path = file(text);
  await assert.rejects(position(path, text, { command: "signature-help", line: 2 }), /Multiple calls.*--symbol/);
  await assert.rejects(position(path, text, { command: "signature-help", line: 1, symbol: "foo" }), /No matching call.*call site/);
});
test("signature: occurrence counts callable names and leaves Rust macro limits explicit", real, async () => {
  const text = 'const v: Foo = [Foo("x"), Foo("y", Foo)];', path = file(text);
  assert.deepStrictEqual(await position(path, text, { command: "signature-help", line: 1, symbol: "Foo#2" }), { line: 0, character: text.indexOf('("y"') + 1 });
  const rust = 'macro_rules! x { () => { deserializer.deserialize_seq(visitor) }; }', rs = file(rust, "rs");
  await assert.rejects(position(rs, rust, { command: "signature-help", line: 1, symbol: "deserialize_seq" }), /Rust macro token trees.*--column|--column.*Rust macro token trees/);
});
test("signature: wrong anchors suggest actual named calls and exclude declarations/comments", real, async () => {
  const text = 'function target() {}\n// target()\nconst value: target = outer(target("x"));';
  const path = file(text);
  for (const line of [1, 2]) await assert.rejects(position(path, text, { command: "signature-help", line, symbol: "target" }), error => {
    assert.ok(error instanceof Error); assert.ok(error.message.includes("call-name matches: 3 (target)"));
    assert.ok(!error.message.includes("1 (target)")); assert.ok(!error.message.includes("2 (target)"));
    return true;
  });
});
test("signature: wrong names show the current call and a bounded alternative", real, async () => {
  const text = 'connection.createQueryRunner();\nconnection.createQueryBuilder();\nconnection.createQueryBuilder();\nconnection.createQueryBuilder();';
  const path = file(text);
  await assert.rejects(position(path, text, { command: "signature-help", line: 1, symbol: "createQueryBuilder" }), error => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes("calls here: connection.createQueryRunner"));
    assert.ok(error.message.includes("call-name matches: 2 (connection.createQueryBuilder)"));
    assert.ok(!error.message.includes("3 (connection.createQueryBuilder)")); return true;
  });
});
test("signature: large call-name suggestion lists keep five nearest locations", real, async () => {
  const text = "function target() {}\n" + Array.from({ length: 60 }, () => "receiver.target(42);").join("\n"), path = file(text);
  await assert.rejects(position(path, text, { command: "signature-help", line: 1, symbol: "target" }), error => {
    assert.ok(error instanceof Error);
    assert.strictEqual(error.message.match(/\d+ \(receiver\.target\)/g)?.length, 5);
    assert.ok(error.message.includes("6 (receiver.target)")); assert.ok(!error.message.includes("7 (receiver.target)"));
    assert.ok(error.message.length < 400); return true;
  });
});
test("signature: instrumented LSP receives the target arguments, including UTF-16", real, async () => {
  const w = workspace({ responses: { "textDocument/signatureHelp": { signatures: [{ label: "foo(value: string)" }] } } });
  const text = 'const 汉字 = "😀"; expect(foo("x"));', path = join(w.root, "source.ts");
  writeFileSync(path, text); w.configs.fixture.fileTypes = [".ts"]; w.saveConfig();
  const result = await run({ ...w.args("signature-help"), file: path, symbol: "foo" });
  assert.strictEqual(result.data.found, true);
  const event = w.events().find(event => event.method === "textDocument/signatureHelp");
  assert.deepStrictEqual((event?.params as ObjectValue).position, { line: 0, character: text.indexOf('("x"') + 1 });
  assert.strictEqual(readFileSync(path, "utf8"), text);
});
test("signature: empty server results report the actual automatic cursor without requesting another guess", real, async () => {
  const w = workspace(), text = 'const 汉字 = "😀"; outer(inner("x"));', path = join(w.root, "source.ts");
  writeFileSync(path, text); w.configs.fixture.fileTypes = [".ts"]; w.saveConfig();
  const result = await run({ ...w.args("signature-help"), file: path, symbol: "inner" });
  const column = text.indexOf('("x"') + 2;
  assert.partialDeepStrictEqual(result.data, { success: true, found: false, cursor: { line: 1, column, automatic: true } });
  assert.ok(String(result.data.hint).includes(`Automatic argument cursor 1:${column}`));
  assert.ok(String(result.data.hint).includes("returned no signature"));
  assert.ok(!String(result.data.hint).includes("Place the cursor"));
  const events = w.events().filter(event => event.method === "textDocument/signatureHelp");
  assert.strictEqual(events.length, 1);
  assert.deepStrictEqual((events[0].params as ObjectValue).position, { line: 0, character: column - 1 });
});
for (const [extension, text, line, symbol, expected] of [
  ["ts", 'class X {\n  method() {\n    return 1;\n  }\n}', 2, "method", 'method() {\n    return 1;\n  }'],
  ["py", 'class X:\n    def method(self):\n        return 1\n', 2, "method", 'def method(self):\n        return 1'],
  ["rs", 'impl X {\n    fn method(&self) -> i32 {\n        1\n    }\n}', 2, "method", 'fn method(&self) -> i32 {\n        1\n    }'],
] as const) test(`snippet: ${extension} extracts the smallest enclosing declaration`, real, async () => {
  const path = file(text, extension);
  assert.strictEqual((await syntaxSnippet(path, text, line, undefined, symbol)).text, expected);
  const result = await run(parseOptions(["snippet", "--file", path, "--line", String(line), "--symbol", symbol, "--limit", "1"], root));
  assert.strictEqual(result.data.provider, "ast-grep"); assert.strictEqual(result.data.truncated, true);
  assert.strictEqual(String(result.data.snippet).split("\n").length, 1);
  assert.ok(String(result.data.hint).includes("--limit 0"));
  const full = await run(parseOptions(["snippet", "--file", path, "--line", String(line), "--symbol", symbol, "--limit", "0"], root));
  assert.strictEqual(full.data.snippet, expected); assert.strictEqual(full.data.truncated, false);
  assert.strictEqual(readFileSync(path, "utf8"), text);
});
test("snippet: starts at indentation, bounds text and never starts an LSP", real, async () => {
  const start = mock.method(LspClient, "start", async () => { throw new Error("snippet must not start a language server"); });
  const text = 'class X {\n  method() { return "' + "x".repeat(7000) + '"; }\n}', path = file(text);
  const result = await run(parseOptions(["snippet", "--file", path, "--line", "2"], root));
  assert.ok(String(result.data.snippet).startsWith("method()"));
  assert.ok(String(result.data.snippet).length <= 6000); assert.strictEqual(result.data.truncated, true);
  await assert.rejects(run(parseOptions(["snippet", "--file", path, "--line", "2", "--apply"], root)), /read-only/);
  assert.strictEqual(start.mock.calls.length, 0);
});
test("snippet: Rust attributes and interleaved comments remain attached to their declaration", real, async () => {
  const text = '/// Long documentation stays outside the declaration.\n#[cfg(feature = "用户")]\n// Attribute context.\n#[must_use]\npub fn target() -> u32 { 42 }\n';
  const path = file(text, "rs"), selected = await syntaxSnippet(path, text, 5, undefined, "target");
  assert.strictEqual(selected.text, text.slice(text.indexOf("#[cfg"), text.lastIndexOf("\n")));
  assert.deepStrictEqual(selected.start, { line: 1, character: 0 });
});
for (const prefix of ['#[must_use]\nfn previous() {}\n\n', '#![allow(unused)]\n', '/// Documentation without outer attributes.\n'])
  test(`snippet: Rust does not attach another item's attributes or leading documentation (${prefix.split("\n")[0]})`, real, async () => {
    const declaration = 'pub fn target() -> u32 { 42 }', text = prefix + declaration, path = file(text, "rs");
    assert.strictEqual((await syntaxSnippet(path, text, prefix.split("\n").length, undefined, "target")).text, declaration);
  });
for (const isWorkspace of [false, true]) test(`symbols: exact names rank first before truncation (workspace=${isWorkspace})`, async () => {
  const w = workspace(), names = ["queryset", "QuerySetDetails", "QuerySet", "queryset", "Queryset"];
  const values = names.map(name => ({ name, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, location: { uri: w.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } }));
  w.setScenario({ capabilities: { workspaceSymbolProvider: true }, responses: { "textDocument/documentSymbol": values, "workspace/symbol": values } });
  const args = w.args("symbols", "--query", "QuerySet", ...(isWorkspace ? ["--workspace"] : []));
  const selected = await run({ ...args, limit: 1 });
  assert.partialDeepStrictEqual(selected.data, { total: 5, shown: 1, truncated: true });
  assert.strictEqual((selected.data.symbols as ObjectValue[])[0].name, "QuerySet");
  const full = await run({ ...args, limit: 0 });
  assert.deepStrictEqual((full.data.symbols as ObjectValue[]).map(item => item.name), ["QuerySet", "queryset", "queryset", "Queryset", "QuerySetDetails"]);
});
test("snippet: Python method decorators remain part of the declaration", real, async () => {
  const text = "class X:\n    @classmethod\n    @validate\n    def method(cls):\n        return 1\n", path = file(text, "py");
  const selected = await syntaxSnippet(path, text, 4, undefined, "method");
  assert.ok(selected.text.startsWith("@classmethod\n    @validate\n    def method"));
  assert.deepStrictEqual(selected.start, { line: 1, character: 4 });
});
for (const [extension, text, symbol, expected] of [
  ["rs", "trait X { fn method(&self); }", "method", "fn method(&self);"],
  ["ts", "interface X { method(): void; value: number; }", "method", "method(): void"],
  ["ts", "class X { readonly emitter: Foo = new Foo(); }", "emitter", "readonly emitter: Foo = new Foo()"],
  ["js", "class X { value = 1; }", "value", "value = 1"],
] as const) test(`snippet: ${extension} member ${symbol} avoids reading the whole container`, real, async () => {
  const path = file(text, extension);
  assert.strictEqual((await syntaxSnippet(path, text, 1, undefined, symbol)).text, expected);
});
test("syntax: missing ast-grep keeps textual navigation and explains automatic features", async () => {
  const text = "foo();", path = file(text), oldPath = process.env.PATH;
  process.env.PATH = root;
  try {
    assert.deepStrictEqual(await position(path, text, { line: 1, symbol: "foo" }), { line: 0, character: 0 });
    await assert.rejects(position(path, text, { command: "signature-help", line: 1, symbol: "foo" }), /npm install --global @ast-grep\/cli.*--column/);
    await assert.rejects(syntaxSnippet(path, text, 1), /npm install --global @ast-grep\/cli/);
  } finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
});
test("syntax: unsupported languages retain textual positions", async () => {
  const path = file("foo();", "fixture");
  assert.strictEqual(await syntaxPosition(path, "foo();", 1, "foo"), undefined);
  assert.deepStrictEqual(await position(path, "foo();", { line: 1, symbol: "foo" }), { line: 0, character: 0 });
});
for (const scenario of ["failure", "malformed", "bad-range"] as const) test(`syntax: injected ${scenario} is bounded and fails explicitly`, real, async () => {
  let input = "";
  mock.method(childProcess, "execFile", ((_command: string, args: string[], options: ObjectValue, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    assert.ok(args.includes("--stdin")); assert.strictEqual(options.timeout, 5000); assert.strictEqual(options.maxBuffer, 64 * 1024 * 1024);
    queueMicrotask(() => callback(scenario === "failure" ? new Error("injected timeout") : null,
      scenario === "bad-range" ? JSON.stringify([{ text: "foo", range: { byteOffset: { start: 999, end: 1002 } } }]) : "{", ""));
    return { stdin: { on() {}, end(text: string) { input = text; } } };
  }) as never);
  const path = file("foo();");
  await assert.rejects(syntaxPosition(path, "foo();", 1, "foo"), scenario === "failure" ? /ast-grep failed.*injected timeout/ : scenario === "bad-range" ? /Invalid ast-grep source range/ : SyntaxError);
  assert.strictEqual(input, "foo();");
});
