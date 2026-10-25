import { afterEach, expect, test } from "bun:test";
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
    expect(result).toEqual(messages);
    expect(framer.remainder().length).toBe(0);
  }
});
test("framing: a partial body can be handed to a fresh reader", () => {
  const frame = encodeMessageFrame({ result: "😀" });
  const first = new MessageFramer(frame.subarray(0, frame.length - 2));
  expect([...first.drain(() => {})]).toEqual([]);
  const resumed = new MessageFramer(first.remainder());
  resumed.push(frame.subarray(frame.length - 2));
  expect([...resumed.drain(() => {})].map((s) => JSON.parse(s))).toEqual([{ result: "😀" }]);
});
test("framing: stdout noise resynchronizes once", () => {
  const framer = new MessageFramer(Buffer.concat([Buffer.from("debug output\r\n\r\n"), encodeMessageFrame({ id: 1, result: null })]));
  const skipped: string[] = [];
  expect([...framer.drain((s) => skipped.push(s))].map((s) => JSON.parse(s))).toEqual([{ id: 1, result: null }]);
  expect(skipped).toEqual(["debug output"]);
});
test.each(["-1", "NaN", "1.5", "1e3", "9007199254740992", "268435457", "1\r\nContent-Length: 1"])("framing: reject length %s and retain failure", (length) => {
  const framer = new MessageFramer(Buffer.from(`Content-Length: ${length}\r\n\r\n`));
  expect(() => [...framer.drain(() => {})]).toThrow();
  expect(() => framer.push(encodeMessageFrame({}))).toThrow();
  expect(framer.remainder().length).toBe(0);
});
test("framing: unterminated headers have a fixed limit", () => {
  const framer = new MessageFramer(Buffer.alloc(16384, 65));
  expect(() => [...framer.drain(() => {})]).toThrow("header exceeds");
});

test("text edits: preserve input and apply same-position inserts in array order", () => {
  const edits = [edit(1, 1, "A"), edit(1, 1, "B"), edit(2, 3, "!")];
  const original = structuredClone(edits);
  expect(applyTextEditsToString("xyz", edits)).toBe("xABy!");
  expect(edits).toEqual(original);
});
test("text edits: deduplicate replacements, allow adjacent ranges", () => {
  expect(applyTextEditsToString("abcd", [edit(0, 2, "A"), edit(0, 2, "A"), edit(2, 4, "B")])).toBe("AB");
});
test("text edits: reject conflicting overlaps and snippet edits", () => {
  expect(() => applyTextEditsToString("abcd", [edit(0, 3, "A"), edit(2, 4, "B")])).toThrow("overlapping");
  expect(() => applyTextEditsToString("abcd", [{ ...edit(0, 1, "$1"), insertTextFormat: 2 } as TextEdit])).toThrow("snippet");
});
test("text edits: multiline replacement and Unicode offsets", () => {
  expect(applyTextEditsToString("ab\ncd\nef", [{ range: { start: { line: 0, character: 1 }, end: { line: 2, character: 1 } }, newText: "X\nY" }])).toBe("aX\nYf");
  expect(applyTextEditsToString("😀hello", [edit(2, 7, "world")])).toBe("😀world");
});
test("positions: occurrence, word boundaries and UTF-16 columns", async () => {
  const path = join(temp(), "symbols.ts"), text = '😀 helloLong hello(hello);\n';
  writeFileSync(path, text);
  expect(await position(path, text, { line: 1, symbol: "hello#2" })).toEqual({ line: 0, character: 19 });
  await expect(position(path, text, { line: 1, symbol: "hello#3" })).rejects.toThrow("out of bounds");
  await expect(position(path, text, { line: 1, column: 2 })).rejects.toThrow("surrogate");
  await expect(position(path, text, { line: 0 })).rejects.toThrow("outside");
  await expect(position(path, text, { line: 1, column: 999 })).rejects.toThrow("outside");
});
test.each([null, [], { servers: [] }, { servers: { invalid: null } }].map((value) => ({ value })))("config: reject invalid overrides %#", ({ value }) => {
  const path = join(temp(), "lsp.json"); writeFileSync(path, JSON.stringify(value));
  expect(() => readOverrides(path)).toThrow();
});
test("config: roots and URI round trips include spaces and Unicode", () => {
  const root = temp(), path = join(root, "中文 #%.ts");
  expect(uriFile(fileUri(path))).toBe(path);
  expect(uriFile("https://example.invalid/file")).toBeUndefined();
  expect(inside(root, join(root, "nested", "file"))).toBe(true);
  expect(inside(root, `${root}-other`)).toBe(false);
});
test("config: hooks cannot resolve project-local commands through PATH", () => {
  const root = temp(), bin = join(root, "node_modules", ".bin"); mkdirSync(bin, { recursive: true });
  const executable = join(bin, "fixture-server"); writeFileSync(executable, "fixture"); chmodSync(executable, 0o700);
  const before = process.env.PATH;
  try {
    process.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${before}`;
    expect(resolveCommand("fixture-server", root)).toBe(executable);
    expect(resolveCommand("fixture-server", root, true)).toBeUndefined();
  } finally { process.env.PATH = before; }
});
test("config: discover .venv and preserve an explicit analysis interpreter", () => {
  const root = temp(), directory = join(root, ".venv", process.platform === "win32" ? "Scripts" : "bin");
  mkdirSync(directory, { recursive: true }); writeFileSync(join(root, "pyproject.toml"), "");
  const python = join(directory, process.platform === "win32" ? "python.exe" : "python"); writeFileSync(python, "fixture"); chmodSync(python, 0o700);
  const config = { command: process.execPath, rootMarkers: ["pyproject.toml"], settings: { python: { analysis: { typeCheckingMode: "strict" } } } };
  expect(availableServers({ pyright: config }, root)[0].settings?.python).toEqual({ ...config.settings.python, pythonPath: python });
  const explicit = { ...config, settings: { python: { pythonPath: "chosen-interpreter" } } };
  expect(availableServers({ pyright: explicit }, root)[0].settings?.python).toEqual(explicit.settings.python);
  expect(config.settings.python).not.toHaveProperty("pythonPath");
});
test("references: exact symbols outrank suffix matches and unrelated names", () => {
  const entries = [{ name: "Option::is_none", path: "option.html" }, { name: "is_none()", path: "exact.html" }];
  expect(bestEntry(entries, "is_none")?.path).toBe("exact.html");
  expect(bestEntry(entries, "none")).toBeUndefined();
  expect(bestEntry([null, { name: "x" }], "x")).toBeUndefined();
  expect(symbolAt("Option::is_none()", 0, 10)).toBe("Option::is_none");
});
test.each(["../escape", "%2e%2e/escape", "a\\..\\..\\escape", "https://outside.invalid", "//outside.invalid", "a\npath"])("references: reject unsafe documentation path %s", (path) => {
  expect(safeDocUrl("rust", path)).toBeUndefined();
});
test("references: documentation URLs preserve fragments and escape Markdown delimiters", () => {
  expect(safeDocUrl("rust", "std/option.html#method.is_none")).toBe("https://devdocs.io/rust/std/option.html#method.is_none");
  expect(safeDocUrl("rust", "item(with space).html")).toBe("https://devdocs.io/rust/item%28with%20space%29.html");
});
