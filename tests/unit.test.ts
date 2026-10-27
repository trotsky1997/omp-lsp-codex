import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableServers, fileUri, inside, readOverrides, resolveCommand, uriFile } from "../src/config.ts";
import { position } from "../src/commands.ts";
import { MessageFramer, encodeMessageFrame } from "../src/omp/message-framing.ts";
import { applyTextEditsToString } from "../src/omp/text-edits.ts";
import { bestEntry, safeDocUrl, symbolAt } from "../src/devdocs.ts";
import type { TextEdit } from "../src/omp/types.ts";

const roots: string[] = [];
function temp() { const root = mkdtempSync(join(tmpdir(), "codex-lsp unit ")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const edit = (start: number, end: number, newText: string): TextEdit => ({ range: { start: { line: 0, character: start }, end: { line: 0, character: end } }, newText });

test("framing: deterministic chunk splits preserve coalesced Unicode messages", () => {
  const messages = Array.from({ length: 24 }, (_, id) => ({ id, result: `中文😀\r\n${id}` }));
  const wire = Buffer.concat(messages.map(encodeMessageFrame));
  for (let seed = 1; seed <= 32; seed++) {
    let state = seed, offset = 0;
    const framer = new MessageFramer(Buffer.alloc(0)), result: unknown[] = [];
    while (offset < wire.length) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const next = offset + 1 + state % 83;
      framer.push(wire.subarray(offset, next));
      result.push(...[...framer.drain(() => { throw new Error("Unexpected resync"); })].map((s) => JSON.parse(s)));
      offset = next;
    }
    assert.deepStrictEqual(result, messages);
    assert.strictEqual(framer.remainder().length, 0);
  }
});
test("framing: a partial body can be handed to a fresh reader", () => {
  const frame = encodeMessageFrame({ result: "😀" });
  const first = new MessageFramer(frame.subarray(0, frame.length - 2));
  assert.deepStrictEqual([...first.drain(() => {})], []);
  const resumed = new MessageFramer(first.remainder());
  resumed.push(frame.subarray(frame.length - 2));
  assert.deepStrictEqual([...resumed.drain(() => {})].map((s) => JSON.parse(s)), [{ result: "😀" }]);
});
test("framing: stdout noise resynchronizes once", () => {
  const framer = new MessageFramer(Buffer.concat([Buffer.from("debug output\r\n\r\n"), encodeMessageFrame({ id: 1, result: null })]));
  const skipped: string[] = [];
  assert.deepStrictEqual([...framer.drain((s) => skipped.push(s))].map((s) => JSON.parse(s)), [{ id: 1, result: null }]);
  assert.deepStrictEqual(skipped, ["debug output"]);
});
for (const [caseIndex, caseValue] of (["-1", "NaN", "1.5", "1e3", "9007199254740992", "268435457", "1\r\nContent-Length: 1"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = (length) => {
  const framer = new MessageFramer(Buffer.from(`Content-Length: ${length}\r\n\r\n`));
  assert.throws(() => [...framer.drain(() => {})]);
  assert.throws(() => framer.push(encodeMessageFrame({})));
  assert.strictEqual(framer.remainder().length, 0);
};
  test("framing: reject length %s and retain failure".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("framing: unterminated headers have a fixed limit", () => {
  const framer = new MessageFramer(Buffer.alloc(16384, 65));
  assert.throws(() => [...framer.drain(() => {})], (error) => error instanceof Error && error.message.includes(String("header exceeds")));
});

test("text edits: preserve input and apply same-position inserts in array order", () => {
  const edits = [edit(1, 1, "A"), edit(1, 1, "B"), edit(2, 3, "!")];
  const original = structuredClone(edits);
  assert.strictEqual(applyTextEditsToString("xyz", edits), "xABy!");
  assert.deepStrictEqual(edits, original);
});
test("text edits: deduplicate replacements, allow adjacent ranges", () => {
  assert.strictEqual(applyTextEditsToString("abcd", [edit(0, 2, "A"), edit(0, 2, "A"), edit(2, 4, "B")]), "AB");
});
test("text edits: reject conflicting overlaps and snippet edits", () => {
  assert.throws(() => applyTextEditsToString("abcd", [edit(0, 3, "A"), edit(2, 4, "B")]), (error) => error instanceof Error && error.message.includes(String("overlapping")));
  assert.throws(() => applyTextEditsToString("abcd", [{ ...edit(0, 1, "$1"), insertTextFormat: 2 } as TextEdit]), (error) => error instanceof Error && error.message.includes(String("snippet")));
});
test("text edits: multiline replacement and Unicode offsets", () => {
  assert.strictEqual(applyTextEditsToString("ab\ncd\nef", [{ range: { start: { line: 0, character: 1 }, end: { line: 2, character: 1 } }, newText: "X\nY" }]), "aX\nYf");
  assert.strictEqual(applyTextEditsToString("😀hello", [edit(2, 7, "world")]), "😀world");
});
test("positions: occurrence, word boundaries and UTF-16 columns", async () => {
  const path = join(temp(), "symbols.ts"), text = '😀 helloLong hello(hello);\n';
  writeFileSync(path, text);
  assert.deepStrictEqual(await position(path, text, { line: 1, symbol: "hello#2" }), { line: 0, character: 19 });
  await assert.rejects(position(path, text, { line: 1, symbol: "hello#3" }), (error) => error instanceof Error && error.message.includes(String("out of bounds")));
  await assert.rejects(position(path, text, { line: 1, column: 2 }), (error) => error instanceof Error && error.message.includes(String("surrogate")));
  await assert.rejects(position(path, text, { line: 0 }), (error) => error instanceof Error && error.message.includes(String("outside")));
  await assert.rejects(position(path, text, { line: 1, column: 999 }), (error) => error instanceof Error && error.message.includes(String("outside")));
});
test("positions: invalid anchors give usable UTF-16 ranges for CRLF, empty lines and surrogate pairs", async () => {
  const path = join(temp(), "columns.ts"), text = "😀x\r\n\r\n";
  writeFileSync(path, text);
  await assert.rejects(position(path, text, { line: 4, column: 1 }), /valid lines: 1-3/);
  await assert.rejects(position(path, text, { line: 1, column: 5 }), /valid columns: 1-4 \(UTF-16\)/);
  await assert.rejects(position(path, text, { line: 2, column: 2 }), /valid columns: 1-1 \(UTF-16\)/);
  await assert.rejects(position(path, text, { line: 1, column: 2 }), /use column 1 or 3/);
  assert.deepEqual(await position(path, text, { line: 1, column: 4 }), { line: 0, character: 3 });
  assert.deepEqual(await position(path, text, { line: 2, column: 1 }), { line: 1, character: 0 });
});
for (const [caseIndex, caseValue] of ([null, [], { servers: [] }, { servers: { invalid: null } }].map((value) => ({ value }))).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = ({ value }) => {
  const path = join(temp(), "lsp.json"); writeFileSync(path, JSON.stringify(value));
  assert.throws(() => readOverrides(path));
};
  test("config: reject invalid overrides %#".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("config: roots and URI round trips include spaces and Unicode", () => {
  const root = temp(), path = join(root, "中文 #%.ts");
  assert.strictEqual(uriFile(fileUri(path)), path);
  assert.strictEqual(uriFile("https://example.invalid/file"), undefined);
  assert.strictEqual(inside(root, join(root, "nested", "file")), true);
  assert.strictEqual(inside(root, `${root}-other`), false);
});
test("config: hooks cannot resolve project-local commands through PATH", () => {
  const root = temp(), bin = join(root, "node_modules", ".bin"); mkdirSync(bin, { recursive: true });
  const executable = join(bin, "fixture-server"); writeFileSync(executable, "fixture"); chmodSync(executable, 0o700);
  const before = process.env.PATH;
  try {
    process.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${before}`;
    assert.strictEqual(resolveCommand("fixture-server", root), executable);
    assert.strictEqual(resolveCommand("fixture-server", root, true), undefined);
  } finally { process.env.PATH = before; }
});
test("config: discover .venv and preserve an explicit analysis interpreter", () => {
  const root = temp(), directory = join(root, ".venv", process.platform === "win32" ? "Scripts" : "bin");
  mkdirSync(directory, { recursive: true }); writeFileSync(join(root, "pyproject.toml"), "");
  const python = join(directory, process.platform === "win32" ? "python.exe" : "python"); writeFileSync(python, "fixture"); chmodSync(python, 0o700);
  const config = { command: process.execPath, rootMarkers: ["pyproject.toml"], settings: { python: { analysis: { typeCheckingMode: "strict" } } } };
  assert.deepStrictEqual(availableServers({ pyright: config }, root)[0].settings?.python, { ...config.settings.python, pythonPath: python });
  const explicit = { ...config, settings: { python: { pythonPath: "chosen-interpreter" } } };
  assert.deepStrictEqual(availableServers({ pyright: explicit }, root)[0].settings?.python, explicit.settings.python);
  assert.strictEqual(Object.hasOwn(config.settings.python, "pythonPath"), false);
});
test("references: exact symbols outrank suffix matches and unrelated names", () => {
  const entries = [{ name: "Option::is_none", path: "option.html" }, { name: "is_none()", path: "exact.html" }];
  assert.strictEqual(bestEntry(entries, "is_none")?.path, "exact.html");
  assert.strictEqual(bestEntry(entries, "none"), undefined);
  assert.strictEqual(bestEntry([null, { name: "x" }], "x"), undefined);
  assert.strictEqual(symbolAt("Option::is_none()", 0, 10), "Option::is_none");
});
for (const [caseIndex, caseValue] of (["../escape", "%2e%2e/escape", "a\\..\\..\\escape", "https://outside.invalid", "//outside.invalid", "a\npath"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = (path) => {
  assert.strictEqual(safeDocUrl("rust", path), undefined);
};
  test("references: reject unsafe documentation path %s".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("references: documentation URLs preserve fragments and escape Markdown delimiters", () => {
  assert.strictEqual(safeDocUrl("rust", "std/option.html#method.is_none"), "https://devdocs.io/rust/std/option.html#method.is_none");
  assert.strictEqual(safeDocUrl("rust", "item(with space).html"), "https://devdocs.io/rust/item%28with%20space%29.html");
});
