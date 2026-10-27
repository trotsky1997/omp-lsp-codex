import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseOptions } from "../src/cli.ts";
import { diagnostics, type Options, type Result } from "../src/commands.ts";
import { applyPlan, fixPlan } from "../src/fixes.ts";
import { LspClient } from "../src/client.ts";
import { availableServers, fileServers, fileUri, loadConfig, object, type ObjectValue } from "../src/config.ts";
import { cleanWorkspaces, isolateGlobalConfig, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); }); after(() => restore());
afterEach(async () => { const leaked = LspClient.active.size; await Promise.all([...LspClient.active].map(client => client.close())); cleanWorkspaces(); assert.equal(leaked, 0); });
type Workspace = ReturnType<typeof workspace>;
const edit = (newText = "fixed", start = 0, end = 5, line = 0) => ({ range: { start: { line, character: start }, end: { line, character: end } }, newText });
const capabilities = { codeActionProvider: { resolveProvider: true }, hoverProvider: true };
const action = (w: Workspace, extra: ObjectValue = {}) => ({ title: "Fix all", kind: "source.fixAll", edit: { changes: { [w.uri]: [edit()] } }, ...extra });
const diagnostic = (line: number, message: string, severity: 1 | 2 = 1) => ({ range: { start: { line, character: 0 }, end: { line, character: 1 } }, message, severity, code: "fixture", source: "fixture" });
const args = (w: Workspace, values: Partial<Options> = {}): Options => ({ ...w.args("hover"), command: "fix", plan: join(w.root, "fixes.json"), timeout: 2000, ...values });
const applyArgs = (w: Workspace): Options => ({ ...args(w), command: "apply", file: undefined });

async function collect(w: Workspace, options = args(w)) {
  const clients = new Map<string, LspClient>();
  try {
    return await fixPlan(options, async file => {
      const server = fileServers(availableServers(loadConfig(dirname(file)), dirname(file)), file)[0];
      if (!server) throw new Error("No server for fixture");
      const key = server.name + server.root;
      let client = clients.get(key);
      if (!client) { client = await LspClient.start(server, 1200); clients.set(key, client); }
      const opened = await client.open(file); await client.ready(opened.uri);
      return { client, server, path: file, ...opened };
    });
  } finally { await Promise.all([...clients.values()].map(client => client.close())); }
}
const verify = (w: Workspace) => async (_files: string[], baseline: string) => diagnostics({ ...parseOptions(["diagnostics", "--baseline", baseline], w.root), timeout: 2000, limit: 0 });
function configure(w: Workspace, actions: unknown[]) { w.setScenario({ capabilities, responses: { "textDocument/codeAction": actions } }); }
function plan(w: Workspace) { return JSON.parse(readFileSync(join(w.root, "fixes.json"), "utf8")); }

test("fix plans: native multi-file fixes share a read-only server, dedupe edits, preserve index and apply once", async () => {
  const w = workspace(), other = join(w.root, "other.fixture"); writeFileSync(other, "other = 1\n");
  const wholeEdit = { changes: { [w.uri]: [edit(), edit()], [fileUri(other)]: [edit("second")] } };
  configure(w, [action(w, { edit: wholeEdit })]);
  execFileSync("git", ["init", "--quiet", w.root]);
  execFileSync("git", ["-C", w.root, "add", "."]);
  const index = readFileSync(join(w.root, ".git/index"));
  const result = await collect(w); assert.equal(result.data.saved, true); assert.equal(result.data.applied, false); assert.equal(result.data.total, 2);
  assert.equal(readFileSync(w.file, "utf8"), "value = 1\n"); assert.match(String((result.data.files as ObjectValue[])[0].diff), /--- a\/source.fixture/);
  assert.equal(plan(w).files[0].edits.length, 1); assert.equal(plan(w).files.length, 2);
  if (process.platform !== "win32") assert.equal(statSync(join(w.root, "fixes.json")).mode & 0o777, 0o600);
  const event = w.events().find(value => value.method === "initialize");
  assert.equal(object(object(object(event?.params).capabilities).workspace).applyEdit, false);
  assert.equal(w.events().filter(value => value.method === "initialize").length, 1);
  w.setScenario({ diagnostics: [] });
  const applied = await applyPlan(applyArgs(w), verify(w));
  assert.equal(applied.code, 0); assert.equal(applied.data.applied, true); assert.equal(applied.data.verification, "pending");
  assert.equal(applied.data.diagnosticVerification, "verified"); assert.deepEqual(object(applied.data.comparison).counts, { new: 0, resolved: 0, existing: 0 });
  assert.equal(readFileSync(w.file, "utf8"), "fixed = 1\n"); assert.equal(readFileSync(other, "utf8"), "second = 1\n");
  assert.deepEqual(readFileSync(join(w.root, ".git/index")), index);
  await assert.rejects(applyPlan(applyArgs(w), verify(w)), /already|applied/);
  assert.equal(w.events().some(value => value.method === "workspace/executeCommand" || value.method === "textDocument/didChange"), false);
});

test("fix plans: opaque resolve preserves the original payload and bounded edit-only action", async () => {
  const w = workspace(), opaque = { title: "lazy", kind: "source.fixAll", data: { key: "lazy", token: { opaque: [1, 2] } } };
  w.setScenario({ capabilities, responses: { "textDocument/codeAction": [opaque] }, responsesByItem: { "codeAction/resolve": { lazy: action(w, { title: "lazy", data: opaque.data }) } } });
  const result = await collect(w); assert.equal(result.data.saved, true);
  assert.deepEqual(w.events().find(event => event.method === "codeAction/resolve")?.params, opaque);
  assert.equal(w.events().filter(event => event.method === "codeAction/resolve").length, 1);
});

test("fix plans: default fixAll is scoped explicitly; command, disabled and ambiguous fixes are reported", async () => {
  const w = workspace();
  configure(w, [action(w, { title: "A" }), action(w, { title: "B", edit: { changes: { [w.uri]: [edit("other")] } } }), action(w, { title: "command", command: { title: "run", command: "unsafe" } }), action(w, { title: "disabled", disabled: { reason: "unavailable" } })]);
  const result = await collect(w); assert.equal(result.code, 1); assert.equal(result.data.saved, false);
  assert.equal((result.data.skipped as ObjectValue[]).some(value => value.needsSelection === true), true);
  assert.equal(existsSync(join(w.root, "fixes.json")), false); assert.equal(readFileSync(w.file, "utf8"), "value = 1\n");
  const request = object(w.events().find(event => event.method === "textDocument/codeAction")?.params);
  assert.deepEqual(object(request.context).only, ["source.fixAll"]); assert.equal(object(request.context).triggerKind, 1);
  assert.equal(w.events().some(event => event.method === "workspace/executeCommand"), false);
});

test("fix plans: one preferred quickfix is selected; unrelated refactors stay outside the plan", async () => {
  const w = workspace(); configure(w, [action(w, { title: "alternate", kind: "quickfix" }), action(w, { title: "preferred", kind: "quickfix", isPreferred: true }), action(w, { kind: "refactor.extract" })]);
  const result = await collect(w, args(w, { kind: "quickfix" })); assert.equal(result.data.saved, true);
  assert.deepEqual((result.data.actions as ObjectValue[]).map(item => item.title), ["preferred"]);
  const unpreferred = workspace(); configure(unpreferred, [action(unpreferred, { kind: "quickfix" })]);
  const manual = await collect(unpreferred, args(unpreferred, { kind: "quickfix" })); assert.equal(manual.data.saved, false);
  assert.equal((manual.data.skipped as ObjectValue[])[0].needsSelection, true);
});

test("fix plans: overlapping edits, stale edit versions and resource operations fail before source writes", async () => {
  for (const type of ["overlap", "version", "resource"] as const) {
    const w = workspace();
    const change = type === "overlap" ? { changes: { [w.uri]: [edit("one", 0, 5), edit("two", 2, 7)] } } : { documentChanges: [type === "version" ? { textDocument: { uri: w.uri, version: 9 }, edits: [edit()] } : { kind: "delete", uri: w.uri }] };
    configure(w, [action(w, { edit: change })]);
    await assert.rejects(collect(w), /overlap|version|Resource operations/); assert.equal(existsSync(join(w.root, "fixes.json")), false); assert.equal(readFileSync(w.file, "utf8"), "value = 1\n");
  }
});

test("fix plans: explicit reviewed selection persists an unpreferred action without guessing among files", async () => {
  const w = workspace(); configure(w, [action(w, { title: "alternative", kind: "quickfix" }), action(w, { title: "reviewed", kind: "quickfix", edit: { changes: { [w.uri]: [edit("chosen")] } } })]);
  const result = await collect(w, args(w, { kind: "quickfix", query: "1" }));
  assert.equal(result.data.saved, true); assert.deepEqual((result.data.actions as ObjectValue[]).map(item => item.title), ["reviewed"]);
  assert.equal(plan(w).files[0].updated, "chosen = 1\n"); assert.equal(readFileSync(w.file, "utf8"), "value = 1\n");
  await assert.rejects(collect(w, args(w, { file: undefined, changed: true, kind: "quickfix", query: "1" })), /indexes are ambiguous/);
  const missing = workspace(); configure(missing, [action(missing, { kind: "quickfix" })]);
  const rejected = await collect(missing, args(missing, { kind: "quickfix", query: "999" }));
  assert.equal(rejected.code, 1); assert.equal(rejected.data.saved, false); assert.equal((rejected.data.skipped as ObjectValue[])[0].needsSelection, true);
});

test("fix plans: CLI apply budgets sample diagnostic differences and keep actual edit state on rendering failures", async () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), "../src/cli.js");
  for (const maximum of [3000, 512]) {
    const w = workspace(), warnings = Array.from({ length: 50 }, (_, index) => diagnostic(0, `warning ${index}`, 2));
    w.setScenario({ capabilities, diagnostics: warnings, responses: { "textDocument/codeAction": [action(w)] } });
    assert.equal((await collect(w)).data.saved, true); w.setScenario({ diagnostics: warnings });
    const result = spawnSync(process.execPath, [cli, "apply", "--plan", join(w.root, "fixes.json"), "--budget", String(maximum)], { cwd: w.root, encoding: "utf8", timeout: 15000 });
    const data = JSON.parse(result.stdout); assert.ok(result.stdout.trimEnd().length <= maximum);
    assert.equal(data.applied, true); assert.equal(data.applicationState, "applied"); assert.equal(data.verification, "pending");
    assert.equal(readFileSync(w.file, "utf8"), "fixed = 1\n");
    if (maximum === 3000) { assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(data.comparison.counts.new, 50); assert.equal(data.comparison.counts.resolved, 50); }
    else { assert.equal(result.status, 2); assert.match(data.error, /Budget/); assert.match(data.hint, /after editing|retry the edit/); }
  }
});

test("fix plans: source changes during analysis or after planning preserve concurrent edits", async () => {
  const w = workspace(); configure(w, [action(w)]); await collect(w);
  writeFileSync(w.file, "user = 2\n");
  await assert.rejects(applyPlan(applyArgs(w), verify(w)), /Source changed since/); assert.equal(readFileSync(w.file, "utf8"), "user = 2\n");
  const changed = workspace(); changed.setScenario({ capabilities, responses: { "textDocument/codeAction": [action(changed)] }, beforeResponse: { "textDocument/codeAction": { file: changed.file, text: "external = 3\n" } } });
  await assert.rejects(collect(changed), /Source changed/); assert.equal(readFileSync(changed.file, "utf8"), "external = 3\n");
});

test("fix plans: tampered and moved plans fail before verification and leave source untouched", async () => {
  const w = workspace(); configure(w, [action(w)]); await collect(w);
  const path = join(w.root, "fixes.json"), before = readFileSync(path), changed = plan(w); changed.files[0].updated = "malicious\n"; writeFileSync(path, JSON.stringify(changed));
  let calls = 0; const denied = async (): Promise<Result> => { calls++; throw new Error("must not verify"); };
  await assert.rejects(applyPlan(applyArgs(w), denied), /modified|moved/); assert.equal(calls, 0);
  writeFileSync(path, before); const moved = join(w.root, "moved.json"); renameSync(path, moved);
  await assert.rejects(applyPlan({ ...applyArgs(w), plan: moved }, denied), /modified|moved/);
  assert.equal(readFileSync(w.file, "utf8"), "value = 1\n");
});

test("fix plans: foreign workspaces, symlink replacements and nested repositories are rejected", async () => {
  const w = workspace(), other = workspace(); configure(w, [action(w)]); await collect(w);
  await assert.rejects(applyPlan({ ...applyArgs(w), cwd: other.root }, verify(w)), /another workspace/);
  const original = join(w.root, "saved.fixture"); renameSync(w.file, original); symlinkSync(original, w.file);
  await assert.rejects(applyPlan(applyArgs(w), verify(w)), /symlink/); assert.equal(readFileSync(original, "utf8"), "value = 1\n");
  const nested = workspace(), directory = join(nested.root, "nested"); mkdirSync(directory); mkdirSync(join(directory, ".git"));
  const foreign = join(directory, "target.fixture"); writeFileSync(foreign, "other = 1\n"); configure(nested, [action(nested, { edit: { changes: { [fileUri(foreign)]: [edit()] } } })]);
  await assert.rejects(collect(nested), /outside the workspace/); assert.equal(readFileSync(foreign, "utf8"), "other = 1\n");
});

test("fix plans: existing artifacts, invalid output paths, unsafe permissions and concurrent applies are explicit", async () => {
  const w = workspace(); configure(w, [action(w)]); const path = join(w.root, "fixes.json");
  writeFileSync(path, "important\n"); await assert.rejects(collect(w), /already exists/); assert.equal(readFileSync(path, "utf8"), "important\n");
  await assert.rejects(collect(w, args(w, { plan: w.file })), /PATH.json/);
  const second = workspace(); configure(second, [action(second)]); await collect(second);
  if (process.platform !== "win32") { chmodSync(join(second.root, "fixes.json"), 0o644); await assert.rejects(applyPlan(applyArgs(second), verify(second)), /Unsafe/); chmodSync(join(second.root, "fixes.json"), 0o600); }
  const lock = join(homedir(), ".cache/codex-lsp/plans", plan(second).id + ".json.lock"); writeFileSync(lock, "busy", { mode: 0o600 });
  await assert.rejects(applyPlan(applyArgs(second), verify(second)), /already being applied/); assert.equal(readFileSync(second.file, "utf8"), "value = 1\n");
});

test("fix plans: diagnostics classify resolved, existing and new issues after apply", async () => {
  const w = workspace(); writeFileSync(w.file, "value = 1\nexisting = bad\nwarning = old\n");
  w.setScenario({ capabilities, diagnostics: [diagnostic(0, "fix me"), diagnostic(1, "existing"), diagnostic(2, "old warning", 2)], responses: { "textDocument/codeAction": [action(w)] } });
  await collect(w); w.setScenario({ diagnostics: [diagnostic(1, "existing"), diagnostic(2, "new warning", 2)] });
  const result = await applyPlan(applyArgs(w), verify(w)); assert.equal(result.code, 0);
  assert.deepEqual(object(result.data.comparison).counts, { new: 1, resolved: 2, existing: 1 }); assert.equal(object(result.data.comparison).newErrors, 0);
});

test("fix plans: new errors or unavailable verification keep successful edits and report pending project checks", async () => {
  const w = workspace(); configure(w, [action(w)]); await collect(w); w.setScenario({ diagnostics: [diagnostic(0, "new error")] });
  const result = await applyPlan(applyArgs(w), verify(w)); assert.equal(result.code, 1); assert.equal(result.data.applied, true); assert.equal(object(result.data.comparison).newErrors, 1);
  const failed = workspace(); configure(failed, [action(failed)]); await collect(failed);
  const verification = await applyPlan(applyArgs(failed), async () => { throw new Error("compiler unavailable"); });
  assert.equal(verification.code, 1); assert.equal(verification.data.applied, true); assert.equal(verification.data.diagnosticVerification, "failed"); assert.equal(verification.data.verification, "pending");
  assert.equal(readFileSync(failed.file, "utf8"), "fixed = 1\n"); await assert.rejects(applyPlan(applyArgs(failed), verify(failed)), /applied/);
});

test("fix plans: changed scope skips unsupported artifacts and only queries matching source files", async () => {
  const w = workspace(); configure(w, [action(w)]); execFileSync("git", ["init", "--quiet", w.root]);
  const result = await collect(w, args(w, { file: undefined, changed: true })); assert.equal(result.data.saved, true);
  assert.equal((result.data.skipped as ObjectValue[]).some(item => String(item.file).endsWith("scenario.json")), true);
  assert.equal(w.events().filter(event => event.method === "textDocument/codeAction").length, 1);
});

test("fix plans: valid Unicode and CRLF preserve bytes; split-surrogate edit ranges fail", async () => {
  const w = workspace(); writeFileSync(w.file, "😀value\r\n"); configure(w, [action(w, { edit: { changes: { [w.uri]: [edit("done", 2, 7)] } } })]);
  await collect(w); await applyPlan(applyArgs(w), verify(w)); assert.equal(readFileSync(w.file, "utf8"), "😀done\r\n");
  const bad = workspace(); writeFileSync(bad.file, "😀value\r\n"); configure(bad, [action(bad, { edit: { changes: { [bad.uri]: [edit("bad", 1, 2)] } } })]);
  await assert.rejects(collect(bad), /UTF-16/); assert.equal(readFileSync(bad.file, "utf8"), "😀value\r\n");
});

test("fix plans: excessive action lists and malformed/confirmation edits fail before artifacts are saved", async () => {
  const excessive = workspace(); configure(excessive, Array.from({ length: 201 }, () => action(excessive)));
  await assert.rejects(collect(excessive), /exceeds 200 actions/); assert.equal(existsSync(join(excessive.root, "fixes.json")), false);
  for (const value of [true, { changes: [], documentChanges: [] }, { changes: {}, changeAnnotations: { annotation: { needsConfirmation: true } } }]) {
    const w = workspace(); configure(w, [action(w, { edit: value })]);
    await assert.rejects(collect(w), /Invalid fix workspace edit|requires confirmation/); assert.equal(readFileSync(w.file, "utf8"), "value = 1\n");
  }
});

test("fix plans: provider callbacks cannot write source during read-only planning", async () => {
  const w = workspace();
  w.setScenario({ capabilities, callbacks: { "textDocument/codeAction": { method: "workspace/applyEdit", params: { edit: { changes: { [w.uri]: [edit("malicious")] } } } } } });
  await assert.rejects(collect(w), /applyEdit|code actions/);
  assert.equal(readFileSync(w.file, "utf8"), "value = 1\n"); assert.equal(existsSync(join(w.root, "fixes.json")), false);
  const reply = w.events().find(event => event.direction === "receive" && event.id === "server-request");
  assert.equal(object(reply?.result).applied, false);
});
