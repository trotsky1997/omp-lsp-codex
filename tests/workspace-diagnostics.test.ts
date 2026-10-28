import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run, type Options } from "../src/commands.ts";
import { fileUri, object, type ObjectValue } from "../src/config.ts";
import { LspClient } from "../src/client.ts";
import { cleanWorkspaces, isolateGlobalConfig, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); }); after(() => restore());
afterEach(async () => { const active = LspClient.active.size; await Promise.all([...LspClient.active].map(client => client.close())); cleanWorkspaces(); assert.equal(active, 0); });
const diagnostic = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, code: "type", message: "Unchanged caller is incompatible" };
function fixture() {
  const w = workspace(), other = join(w.root, "caller.fixture"); writeFileSync(other, "value = 2\n");
  execFileSync("git", ["init", "--quiet", w.root]); execFileSync("git", ["-C", w.root, "add", "."]);
  const index = readFileSync(join(w.root, ".git/index"));
  const report = { items: [{ uri: w.uri, version: null, kind: "full", items: [] }, { uri: fileUri(other), version: null, kind: "full", items: [diagnostic] }] };
  const set = (extra: ObjectValue = {}) => w.setScenario({ capabilities: { diagnosticProvider: { identifier: "fixture", workspaceDiagnostics: true } }, responses: { "workspace/diagnostic": report }, ...extra });
  set();
  const args = (extra: Partial<Options> = {}): Options => ({ ...w.args("diagnostics"), file: undefined, workspace: true, timeout: 3000, ...extra });
  const stable = () => { assert.equal(readFileSync(w.file, "utf8"), "value = 1\n"); assert.equal(readFileSync(other, "utf8"), "value = 2\n"); assert.deepEqual(readFileSync(join(w.root, ".git/index")), index); };
  return { ...w, other, report, set, args, stable };
}

test("workspace diagnostics: reports unopened callers, preserves scope metadata and sends a single workspace request", async () => {
  const w = fixture(), result = await run(w.args());
  assert.equal(result.code, 1); assert.equal(result.data.verified, true); assert.equal(object(result.data.counts).errors, 1); assert.equal((result.data.checked as ObjectValue[]).length, 2);
  assert.equal(object(result.data.coverage).complete, true); assert.equal(w.events().filter(row => row.method === "workspace/diagnostic").length, 1);
  assert.deepEqual(object(w.events().find(row => row.method === "workspace/diagnostic")?.params), { previousResultIds: [], identifier: "fixture" });
  assert.equal(w.events().some(row => row.method === "textDocument/didOpen" || row.method === "textDocument/didChange"), false); w.stable();
});

test("workspace diagnostics: unsupported providers stay unverified and never issue the unsupported request", async () => {
  const w = fixture(); w.set({ capabilities: { diagnosticProvider: { workspaceDiagnostics: false } } });
  const result = await run(w.args()); assert.equal(result.code, 1); assert.equal(result.data.verified, false); assert.equal(object(result.data.coverage).complete, false); assert.match(result.human, /does not advertise/);
  assert.equal(w.events().some(row => row.method === "workspace/diagnostic"), false); w.stable();
});

test("workspace diagnostics: TypeScript native-check guidance cannot match the short Python ty server name", async () => {
  const w = fixture(); w.configs["typescript-language-server"] = { ...w.configs.fixture }; w.configs.fixture.disabled = true; w.saveConfig();
  w.set({ capabilities: {} });
  const result = await run(w.args({ server: "typescript-language-server" })); assert.equal(result.data.verified, false); assert.match(result.human, /tsc --noEmit/); assert.doesNotMatch(result.human, /pyright|Python checker/); w.stable();
});

test("workspace diagnostics: malformed, stale, incomplete and outside-root reports cannot verify a workspace", async () => {
  for (const report of [
    { items: null }, { items: [{ uri: "untitled:example", kind: "full", items: [] }] },
    { items: [{ uri: "file:///outside.fixture", kind: "full", items: [] }] },
    { items: [{ uri: "file:///unused", kind: "unchanged", resultId: "old" }] },
  ]) {
    const w = fixture(); w.set({ responses: { "workspace/diagnostic": report } });
    const result = await run(w.args()); assert.equal(result.code, 1); assert.equal(result.data.verified, false); assert.equal(object(result.data.coverage).complete, false); w.stable();
  }
  for (const extra of [{ version: 1 }, { items: [{ ...diagnostic, range: { start: { line: 999, character: 0 }, end: { line: 999, character: 1 } } }] }]) {
    const w = fixture(); w.set({ responses: { "workspace/diagnostic": { items: [{ uri: w.uri, kind: "full", items: [], ...extra }] } } });
    const result = await run(w.args()); assert.equal(result.data.verified, false); w.stable();
  }
});

test("workspace diagnostics: partial provider coverage cannot replace a baseline or claim resolved issues", async () => {
  const w = fixture(), baseline = join(w.root, ".git/before.json"); await run(w.args({ server: "fixture", saveBaseline: baseline }));
  const saved = readFileSync(baseline), partialScenario = join(w.root, ".git/unsupported.json"), partialTrace = join(w.root, ".git/unsupported.ndjson");
  writeFileSync(partialScenario, JSON.stringify({ capabilities: {} }));
  w.configs.partial = { ...w.configs.fixture, args: [w.configs.fixture.args![0], "scenario", partialTrace, partialScenario] }; w.saveConfig();
  const result = await run(w.args({ baseline })); assert.equal(result.data.verified, false); assert.equal(object(result.data.comparison).verified, false); assert.equal(object(result.data.comparison).resolved, undefined);
  await assert.rejects(run(w.args({ saveBaseline: baseline })), /partial workspace baseline/); assert.deepEqual(readFileSync(baseline), saved); w.stable();
});

test("workspace diagnostics: stalled requests cancel and the raw method is available without apply", async () => {
  const w = fixture(); w.set({ stallMethods: ["workspace/diagnostic"] });
  const result = await run(w.args({ timeout: 1000 })); assert.equal(result.data.verified, false); assert.ok(w.events().some(row => row.method === "$/cancelRequest")); w.stable();
  w.set(); const raw = await run({ ...w.args(), command: "request", file: w.file, workspace: false, method: "workspace/diagnostic", payload: '{"previousResultIds":[]}', server: "fixture" });
  assert.equal(raw.data.applied, false); assert.equal(object(raw.data.result).items instanceof Array, true); w.stable();
});
