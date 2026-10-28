import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { outputData, run, type Options } from "../src/commands.ts";
import { fileUri, type ObjectValue } from "../src/config.ts";
import { LspClient } from "../src/client.ts";
import { cleanWorkspaces, isolateGlobalConfig, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); }); after(() => restore());
afterEach(async () => { const active = LspClient.active.size; await Promise.all([...LspClient.active].map(client => client.close())); cleanWorkspaces(); assert.equal(active, 0); });
const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "renamed" };
function fixture() {
  const w = workspace(), other = join(w.root, "other.fixture"), plan = join(w.root, ".git/plan.json"); writeFileSync(other, "value = 2\n");
  execFileSync("git", ["init", "--quiet", w.root]); execFileSync("git", ["-C", w.root, "add", "."]);
  const index = readFileSync(join(w.root, ".git/index"));
  const stable = () => { assert.equal(readFileSync(w.file, "utf8"), "value = 1\n"); assert.equal(readFileSync(other, "utf8"), "value = 2\n"); assert.deepEqual(readFileSync(join(w.root, ".git/index")), index); };
  const args = (command: string, extra: Partial<Options> = {}): Options => ({ ...w.args(command), timeout: 3000, plan, ...extra });
  return { ...w, other, plan, index, stable, args };
}

test("workspace edit plans: multi-file rename is saved once, keeps source/index and applies without querying rename again", async () => {
  const w = fixture(); w.setScenario({ capabilities: { renameProvider: true }, diagnosticVersionFromDocument: true, responses: { "textDocument/rename": { changes: { [w.uri]: [edit], [fileUri(w.other)]: [edit] } } } });
  const preview = await run(w.args("rename", { newName: "renamed" })); assert.equal(preview.data.saved, true); assert.equal(preview.data.total, 2); w.stable();
  assert.equal(w.events().filter(row => row.method === "initialize").length, 1);
  const applied = await run(w.args("apply", { file: undefined })); assert.equal(applied.code, 0); assert.equal(applied.data.applied, true); assert.equal(applied.data.diagnosticVerification, "verified");
  const compact = outputData(applied.data, { budget: 1000 }); assert.ok(JSON.stringify(compact).length <= 1000); assert.equal(compact.applied, true); assert.equal(compact.diagnosticVerification, "verified");
  assert.equal(readFileSync(w.file, "utf8"), "renamed = 1\n"); assert.equal(readFileSync(w.other, "utf8"), "renamed = 2\n"); assert.deepEqual(readFileSync(join(w.root, ".git/index")), w.index);
  assert.equal(w.events().filter(row => row.method === "textDocument/rename").length, 1);
  await assert.rejects(run(w.args("apply", { file: undefined })), /applied/);
});

test("workspace edit plans: reviewed lazy refactor retains its original action index and pure text edits", async () => {
  const w = fixture(), lazy = { title: "Extract", kind: "refactor.extract", data: { key: "selected", opaque: [1, 2] } };
  w.setScenario({ capabilities: { codeActionProvider: { resolveProvider: true } }, responses: { "textDocument/codeAction": [{ title: "Other", kind: "quickfix" }, lazy] }, responsesByItem: { "codeAction/resolve": { selected: { ...lazy, edit: { changes: { [w.uri]: [edit] } } } } } });
  const preview = await run(w.args("code-actions", { query: "1", kind: "refactor.extract" })); assert.equal(preview.data.saved, true); w.stable();
  const plan = JSON.parse(readFileSync(w.plan, "utf8")); assert.equal(plan.actions[0].index, 1); assert.equal(plan.files[0].updated, "renamed = 1\n");
  const applied = await run(w.args("apply", { file: undefined })); assert.equal(applied.code, 0); assert.equal(applied.data.diagnosticVerification, "verified");
  assert.equal(w.events().filter(row => row.method === "textDocument/codeAction").length, 1); assert.equal(w.events().some(row => row.method === "workspace/executeCommand"), false);
});

test("workspace edit plans: command, disabled, outside-workspace, resource and stale edits fail without saving or source writes", async () => {
  for (const kind of ["command", "disabled", "outside", "resource", "version", "selection"] as const) {
    const w = fixture();
    const action: ObjectValue = { title: "Selected", kind: "refactor.extract", edit: { changes: { [w.uri]: [edit] } } };
    if (kind === "command") action.command = { command: "unsafe", title: "run" };
    if (kind === "disabled") action.disabled = { reason: "unavailable" };
    if (kind === "outside") action.edit = { changes: { [fileUri(join(w.root, "..", "outside.fixture"))]: [edit] } };
    if (kind === "resource") action.edit = { documentChanges: [{ kind: "delete", uri: w.uri }] };
    if (kind === "version") action.edit = { documentChanges: [{ textDocument: { uri: w.uri, version: 99 }, edits: [edit] }] };
    w.setScenario({ capabilities: { codeActionProvider: true }, responses: { "textDocument/codeAction": [action] } });
    await assert.rejects(run(w.args("code-actions", { query: kind === "selection" ? undefined : "0" })), /pure-text|unavailable|outside|Resource|stale|reviewed/);
    assert.equal(existsSync(w.plan), false); w.stable(); assert.equal(w.events().some(row => row.method === "workspace/executeCommand"), false);
  }
});

test("workspace edit plans: source changes after preview reject application without consuming the plan", async () => {
  const w = fixture(); w.setScenario({ responses: { "textDocument/rename": { changes: { [w.uri]: [edit] } } } });
  assert.equal((await run(w.args("rename", { newName: "renamed" }))).data.saved, true);
  writeFileSync(w.file, "external = 1\n"); await assert.rejects(run(w.args("apply", { file: undefined })), /Source changed/); assert.equal(readFileSync(w.file, "utf8"), "external = 1\n");
  writeFileSync(w.file, "value = 1\n"); assert.equal((await run(w.args("apply", { file: undefined }))).data.applied, true); assert.deepEqual(readFileSync(join(w.root, ".git/index")), w.index);
});

test("workspace edit plans: long plan paths and renamed warnings fit 1000 characters after application", async () => {
  const w = fixture(), parent = join(w.root, ".git", "real project rename validation with long artifact paths"), plan = join(parent, "reviewed-rename-plan.json"); mkdirSync(parent);
  const original = "value = 1\nkeep = 2\n", updated = "renamed = 1\nkeep = 2\n"; writeFileSync(w.file, original);
  const warning = { range: edit.range, severity: 2, code: 6133, message: "value is unused" }, hint = { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, severity: 4, code: 6385, message: "keep is deprecated" };
  w.setScenario({ diagnosticVersionFromDocument: true, diagnosticsByText: { [original]: [warning, hint], [updated]: [{ ...warning, message: "renamed is unused" }, hint] }, responses: { "textDocument/rename": { changes: { [w.uri]: [edit] } } } });
  assert.equal((await run(w.args("rename", { newName: "renamed", plan }))).data.saved, true); assert.equal(readFileSync(w.file, "utf8"), original);
  const applied = await run(w.args("apply", { file: undefined, plan })); assert.equal(applied.code, 0);
  const compact = outputData(applied.data, { budget: 1000 }); assert.ok(JSON.stringify(compact).length <= 1000); assert.equal(compact.applied, true); assert.equal(compact.diagnosticVerification, "verified");
  assert.equal(readFileSync(w.file, "utf8"), updated); assert.deepEqual(readFileSync(join(w.root, ".git/index")), w.index);
});
