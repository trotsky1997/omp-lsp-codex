import assert from "node:assert/strict";
import { before, after, afterEach, test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseOptions } from "../src/cli.ts";
import { run } from "../src/commands.ts";
import { parseRange } from "../src/range.ts";
import { LspClient } from "../src/client.ts";
import { object } from "../src/config.ts";
import { queryOptions } from "../src/batch.ts";
import { cleanWorkspaces, isolateGlobalConfig, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); }); after(() => restore());
afterEach(async () => { const leaked = LspClient.active.size; await Promise.all([...LspClient.active].map(client => client.close())); cleanWorkspaces(); assert.equal(leaked, 0); });

test("range actions: multiline selection and kind prefix preserve original action indexes and preview is read-only", async () => {
  const w = workspace(); writeFileSync(w.file, "const x = 1;\r\n😀value();\r\nreturn x;\r\n");
  const edit = { changes: { [w.uri]: [{ range: { start: { line: 2, character: 0 }, end: { line: 2, character: 6 } }, newText: "yield" }] } };
  w.setScenario({ manualCodeActions: true, responses: { "textDocument/codeAction": [
    { title: "fix", kind: "quickfix" }, { title: "extract", kind: "refactor.extract.function", edit },
    { title: "inline", kind: "refactor.inline" }, { title: "legacy", command: "unsafe" },
  ] } });
  const args = w.args("code-actions", "--range", "2:1-3:7", "--kind", "refactor.extract", "--query", "1");
  const result = await run(args);
  assert.equal(result.data.total, 1); assert.equal((result.data.actions as { index: number }[])[0].index, 1);
  assert.equal(object(result.data.editPreview).fileCount, 1); assert.equal(result.data.applied, false);
  assert.match(readFileSync(w.file, "utf8"), /return x/);
  const params = object(w.events().find(event => event.method === "textDocument/codeAction")?.params);
  assert.deepEqual(params.range, parseRange("2:1-3:7")); assert.deepEqual(object(params.context).only, ["refactor.extract"]);
  assert.equal(object(params.context).triggerKind, 1);
  assert.equal(w.events().some(event => event.method === "workspace/executeCommand" || event.method === "textDocument/didChange"), false);
  const applied = await run({ ...args, apply: true });
  assert.equal(applied.data.applied, true); assert.equal(applied.data.verification, "pending");
  assert.match(readFileSync(w.file, "utf8"), /yield x/);
});

test("range actions: bad end, CRLF terminator and split Unicode fail before server startup", async () => {
  const w = workspace(); writeFileSync(w.file, "😀x\r\nvalue\r\n");
  for (const [range, error] of [["1:1-9:1", /valid lines/], ["1:1-1:5", /valid columns: 1-4/], ["1:1-1:2", /surrogate pair/]] as const)
    await assert.rejects(run(w.args("code-actions", "--range", range)), error);
  assert.equal(existsSync(join(w.root, "wire.ndjson")), false);
});

test("ranges: CLI and JSONL validate syntax, scope, integer bounds and conflicting anchors", () => {
  const w = workspace();
  for (const range of ["0:1-1:1", "1:0-2:1", "2:1-1:1", "1:1-1:0", "1:1:2:2", "9007199254740992:1-9007199254740993:1"])
    assert.throws(() => parseRange(range), /range/);
  for (const args of [["hover", "--range", "1:1-1:2"], ["code-actions", "--range", "1:1-1:2", "--line", "1"], ["hover", "--kind", "quickfix"], ["inlay-hints", "--range", "1:1-1:2", "--symbol", "value"]])
    assert.throws(() => parseOptions(args), /range|kind/);
  const base = parseOptions(["batch", "--input", "-"], w.root);
  const row = queryOptions(base, { command: "code-actions", file: w.file, range: "1:1-1:5", kind: "refactor.extract" });
  assert.deepEqual(row.range, parseRange("1:1-1:5"));
  for (const value of [{ command: "hover", file: w.file, range: "1:1-1:2" }, { command: "code-actions", file: w.file, range: "1:1-1:2", column: 1 }, { command: "code-actions", file: w.file, kind: "" }])
    assert.throws(() => queryOptions(base, value), /range|kind/);
});

test("range actions: optional TypeScript rename UI after applying extraction returns a target without another edit", async () => {
  const w = workspace(), target = { textDocument: { uri: w.uri }, position: { line: 0, character: 0 } };
  const edit = { changes: { [w.uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "newFunction" }] } };
  w.setScenario({ responses: { "textDocument/codeAction": [{ title: "Extract", kind: "refactor.extract.function", edit, command: { command: "fixture.extract" } }] },
    callbacks: { "workspace/executeCommand": { method: "_typescript.rename", params: target } } });
  const result = await run(w.args("code-actions", "--range", "1:1-1:6", "--kind", "refactor.extract", "--query", "0", "--apply"));
  assert.equal(result.data.applied, true); assert.equal(result.data.verification, "pending");
  assert.deepEqual(result.data.renameTarget, { file: w.file, line: 1, column: 1 });
  assert.equal(readFileSync(w.file, "utf8"), "newFunction = 1\n");
  const reply = w.events().findLast(event => event.direction === "receive" && event.id === "server-request");
  assert.equal(reply?.error, undefined); assert.equal(reply?.result, null);
  assert.equal(w.events().filter(event => event.method === "textDocument/didChange").length, 1);
});
