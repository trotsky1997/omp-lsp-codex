import assert from "node:assert/strict";
import { after, afterEach, before, mock, test } from "node:test";
import childProcess from "node:child_process";
import { Writable } from "node:stream";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MessageFramer, MessageFramingError, encodeMessageFrame } from "../src/omp/message-framing.ts";
import { syntaxPosition } from "../src/syntax.ts";
import { run } from "../src/commands.ts";
import { LspClient } from "../src/client.ts";
import { fileUri, uriFile } from "../src/config.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";

let root: string, restore: () => void;
before(() => {
  root = mkdtempSync(join(tmpdir(), "codex-lsp faults ")); restore = isolateGlobalConfig();
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", process.platform === "win32" ? "ast-grep.cmd" : "ast-grep"), "", { mode: 0o755 });
});
afterEach(async () => { mock.restoreAll(); await Promise.all([...LspClient.active].map(client => client.close())); cleanWorkspaces(); });
after(() => { restore(); rmSync(root, { recursive: true, force: true }); });
const frame = (body: Buffer) => Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
for (const bytes of [[0xff], [0x80], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe4, 0xb8]])
  test(`framing: invalid UTF-8 ${Buffer.from(bytes).toString("hex")} poisons only its reader`, () => {
    const bad = frame(Buffer.concat([Buffer.from('{"result":"'), Buffer.from(bytes), Buffer.from('"}') ]));
    for (let split = 1; split < bad.length; split++) {
      const reader = new MessageFramer(bad.subarray(0, split));
      assert.deepStrictEqual([...reader.drain(() => {})], []);
      reader.push(bad.subarray(split));
      let failure: unknown;
      assert.throws(() => [...reader.drain(() => {})], error => { failure = error; return error instanceof MessageFramingError && /UTF-8/.test(error.message); });
      assert.strictEqual(reader.remainder().length, 0);
      assert.throws(() => reader.push(encodeMessageFrame({ ok: true })), error => error === failure);
      assert.throws(() => [...reader.drain(() => {})], error => error === failure);
    }
    const good = new MessageFramer(encodeMessageFrame({ text: "中文😀�" }));
    assert.deepStrictEqual([...good.drain(() => {})].map(value => JSON.parse(value)), [{ text: "中文😀�" }]);
  });
test("framing: non-UTF-8 stdout noise remains recoverable before a valid body", () => {
  const reader = new MessageFramer(Buffer.concat([Buffer.from([0xff, 13, 10, 13, 10]), encodeMessageFrame({ ok: true })]));
  const noise: string[] = [];
  assert.deepStrictEqual([...reader.drain(value => noise.push(value))].map(value => JSON.parse(value)), [{ ok: true }]);
  assert.strictEqual(noise.length, 1);
});
function node(text: string, start: unknown, end: unknown) { return { text, range: { byteOffset: { start, end } } }; }
function inject(value: unknown) {
  mock.method(childProcess, "execFile", ((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    queueMicrotask(() => callback(null, JSON.stringify(value), ""));
    return { stdin: { on() {}, end() {} } };
  }) as never);
}
for (const [start, end] of [[null, 3], [false, 3], ["0", 3], [[], 3], [0, "3"], [0, [3]]])
  test(`AST: numeric-looking offsets ${JSON.stringify([start, end])} are rejected`, async () => {
    inject([{ ...node("foo", start, end), ruleId: "symbol" }]);
    await assert.rejects(syntaxPosition(join(root, "source.ts"), "foo();", 1, "foo"), /Invalid ast-grep source range/);
  });
test("AST: a source range splitting UTF-8 cannot masquerade as replacement characters", async () => {
  inject([{ ...node("��", 1, 3), ruleId: "symbol" }]);
  await assert.rejects(syntaxPosition(join(root, "source.ts"), "中foo();", 1, "foo"), /Invalid ast-grep source range/);
});
for (const ruleId of [null, 42, "unexpected"])
  test(`AST: an unexpected rule identity ${JSON.stringify(ruleId)} fails explicitly`, async () => {
    inject([{ ...node("foo", 0, 3), ruleId }]);
    await assert.rejects(syntaxPosition(join(root, "source.ts"), "foo();", 1, "foo"), /Invalid ast-grep rule/);
  });
for (const kind of ["missing", "outside", "reversed", "non-arguments"])
  test(`AST: ${kind} call captures cannot redirect a signature cursor`, async () => {
    const text = kind === "reversed" ? "() + foo()" : "foo(); bar()";
    const call = kind === "reversed" ? node(text, 0, text.length) : node("foo()", 0, 5);
    const callee = kind === "reversed" ? node("foo", 5, 8) : node("foo", 0, 3);
    const args = kind === "outside" ? node("()", 10, 12) : kind === "reversed" ? node("()", 0, 2) : kind === "non-arguments" ? node("foo", 0, 3) : node("()", 3, 5);
    inject([{ ...callee, ruleId: "symbol" }, { ...call, ruleId: "call", metaVariables: { single: kind === "missing" ? { CALLEE: callee } : { CALLEE: callee, ARGS: args } } }]);
    await assert.rejects(syntaxPosition(join(root, "source.ts"), text, 1, "foo", true), /Invalid ast-grep call|Invalid ast-grep capture/);
  });
test("AST: valid tagged-template arguments remain supported", async () => {
  inject([{ ...node("tag", 0, 3), ruleId: "symbol" }, { ...node("tag`x`", 0, 6), ruleId: "call", metaVariables: { single: { CALLEE: node("tag", 0, 3), ARGS: node("`x`", 3, 6) } } }]);
  assert.deepStrictEqual(await syntaxPosition(join(root, "source.ts"), "tag`x`", 1, "tag", true), { line: 0, character: 4 });
});
test("AST: failed stdin delivery rejects and terminates the parser", async () => {
  const kill = mock.fn(() => true);
  mock.method(childProcess, "execFile", ((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    setTimeout(() => callback(null, JSON.stringify([{ ...node("foo", 0, 3), ruleId: "symbol" }]), ""), 20);
    return { stdin: new Writable({ write(_chunk, _encoding, done) { done(Object.assign(new Error("injected EPIPE"), { code: "EPIPE" })); } }), kill };
  }) as never);
  await assert.rejects(syntaxPosition(join(root, "source.ts"), "foo();", 1, "foo"), /ast-grep input failed.*EPIPE/);
  assert.strictEqual(kill.mock.calls.length, 1);
});
for (const mode of ["hang", "ast-flood"])
  test(`AST subprocess: ${mode} is reaped without an external rescue`, async () => {
    const execute = childProcess.execFile, trace = join(root, `parser-${mode}.ndjson`);
    writeFileSync(trace, "");
    let child: ReturnType<typeof childProcess.execFile> | undefined, rescue: ReturnType<typeof setTimeout> | undefined, rescued = false;
    mock.method(childProcess, "execFile", ((_command: string, _args: string[], options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      child = execute(process.execPath, [join(import.meta.dirname, "fixtures/lsp-server.js"), mode, trace], { ...options, timeout: 1000, maxBuffer: mode === "ast-flood" ? 512 : 1024 }, callback);
      rescue = setTimeout(() => { rescued = true; child!.kill("SIGKILL"); }, 2500);
      return child;
    }) as never);
    try {
      await assert.rejects(syntaxPosition(join(root, "source.ts"), "foo();", 1, "foo"), mode === "ast-flood" ? /maxBuffer/ : /ast-grep failed/);
      assert.strictEqual(rescued, false, "the parser deadline/output limit must terminate a child ignoring SIGTERM");
      const pid = JSON.parse(readFileSync(trace, "utf8").trim().split("\n")[0]).pid;
      assert.throws(() => process.kill(pid, 0));
    } finally { clearTimeout(rescue); if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  });
test("workspace edit: corrupt UTF-8 on the wire cannot alter any file", async () => {
  const w = workspace();
  w.setScenario({ corruptUtf8: "textDocument/rename", responses: { "textDocument/rename": { changes: { [w.uri]: [{ range, newText: "INVALID_UTF8" }] } } } });
  const original = readFileSync(w.file), outcome = await run(w.args("rename", "--new-name", "renamed", "--apply")).then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
  assert.deepStrictEqual(readFileSync(w.file), original, "malformed transport data must never reach file writes");
  assert.match(String(outcome.error), /UTF-8/); assert.strictEqual(outcome.result, undefined);
});
for (const replacement of ["\ud800", "\udc00", "left\ud800right"])
  test(`workspace edit: escaped unpaired surrogate ${JSON.stringify(replacement)} cannot corrupt a file`, async () => {
    const w = workspace();
    w.setScenario({ responses: { "textDocument/rename": { changes: { [w.uri]: [{ range, newText: replacement }] } } } });
    const original = readFileSync(w.file), outcome = await run(w.args("rename", "--new-name", "renamed", "--apply")).then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
    assert.deepStrictEqual(readFileSync(w.file), original);
    assert.match(String(outcome.error), /Invalid LSP text edit/); assert.strictEqual(outcome.result, undefined);
  });
test("workspace edit: valid literal replacement characters and emoji are preserved", async () => {
  const w = workspace(), replacement = "中文�😀";
  w.setScenario({ responses: { "textDocument/rename": { changes: { [w.uri]: [{ range, newText: replacement }] } } } });
  const result = await run(w.args("rename", "--new-name", "renamed", "--apply"));
  assert.strictEqual(result.data.applied, true); assert.strictEqual(readFileSync(w.file, "utf8"), replacement + " = 1\n");
});
test("workspace edit: a surrogate URI cannot alias a real replacement-character filename", async () => {
  const w = workspace(), sibling = join(w.root, "�.fixture"); writeFileSync(sibling, "other = 2\n");
  const malformed = fileUri(sibling).replace("%EF%BF%BD", "\ud800");
  w.setScenario({ responses: { "textDocument/rename": { changes: { [w.uri]: [{ range, newText: "renamed" }], [malformed]: [{ range, newText: "renamed" }] } } } });
  const original = readFileSync(w.file), other = readFileSync(sibling);
  const outcome = await run(w.args("rename", "--new-name", "renamed", "--apply")).then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
  assert.deepStrictEqual(readFileSync(w.file), original); assert.deepStrictEqual(readFileSync(sibling), other);
  assert.match(String(outcome.error), /Unsupported edit URI/); assert.strictEqual(outcome.result, undefined);
});
test("file URI: malformed Unicode paths and URIs are rejected before URL normalization", () => {
  assert.throws(() => fileUri(join(root, "\ud800.fixture")), /Invalid Unicode file path/);
  assert.strictEqual(uriFile(fileUri(join(root, "�.fixture")).replace("%EF%BF%BD", "\udc00")), undefined);
  for (const uri of ['file:///tmp/a\tb.txt', 'file:///tmp/a\nb.txt', 'file:///tmp/name.txt ', 'file:///tmp/a\\b.txt'])
    assert.strictEqual(uriFile(uri), undefined);
  for (const name of ["line\nbreak.fixture", "space name.fixture", "trailing-space.fixture "])
    assert.strictEqual(uriFile(fileUri(join(root, name))), join(root, name));
});
test("workspace edit: a well-formed replacement-character URI remains writable", async () => {
  const w = workspace(), sibling = join(w.root, "�.fixture"); writeFileSync(sibling, "other = 2\n");
  const uri = fileUri(sibling); assert.strictEqual(uriFile(uri), sibling);
  w.setScenario({ responses: { "textDocument/rename": { changes: { [uri]: [{ range, newText: "renamed" }] } } } });
  assert.strictEqual((await run(w.args("rename", "--new-name", "renamed", "--apply"))).data.applied, true);
  assert.strictEqual(readFileSync(sibling, "utf8"), "renamed = 2\n");
});
