import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { parseOptions } from "../src/cli.ts";
import { run } from "../src/commands.ts";
import { LspClient } from "../src/client.ts";
import { object } from "../src/config.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); }); after(() => restore());
afterEach(async () => { const leaked = LspClient.active.size; await Promise.all([...LspClient.active].map(client => client.close())); cleanWorkspaces(); assert.equal(leaked, 0); });
async function selectedPlan() {
  const w = workspace(), plan = join(w.root, "selected.json");
  w.configs.linter = { ...w.configs.fixture, isLinter: true }; w.saveConfig();
  w.setScenario({ capabilities: { codeActionProvider: true }, diagnosticVersionFromDocument: true,
    diagnosticsByText: { "value = 1\n": [{ range, message: "Fix value", severity: 1 }], "fixed = 1\n": [] },
    responses: { "textDocument/codeAction": [{ title: "Fix value", kind: "quickfix", isPreferred: true, edit: { changes: { [w.uri]: [{ range, newText: "fixed" }] } } }] } });
  const result = await run({ ...w.args("fix", "--server", "linter", "--kind", "quickfix", "--plan", plan), timeout: 2000 });
  assert.equal(result.data.saved, true);
  const applying = { ...parseOptions(["apply", "--plan", plan], w.root), timeout: 2000 };
  return { w, applying };
}

test("selected fix providers: apply verifies the captured server without adding unrelated semantic diagnostics", async () => {
  const { w, applying } = await selectedPlan();
  w.configs.extra = { ...w.configs.fixture, settings: { unrelated: true } }; w.saveConfig();
  const result = await run(applying);
  assert.equal(result.code, 0, JSON.stringify(result.data)); assert.equal(result.data.diagnosticVerification, "verified");
  assert.equal(result.data.applied, true); assert.equal(readFileSync(w.file, "utf8"), "fixed = 1\n");
  assert.equal(w.events().filter(event => event.method === "initialize").length, 2);
});

test("selected fix providers: a changed captured provider stops apply before source writes", async () => {
  const { w, applying } = await selectedPlan();
  w.configs.linter.settings = { changed: true }; w.saveConfig();
  await assert.rejects(run(applying), /Fix provider configuration changed/);
  assert.equal(readFileSync(w.file, "utf8"), "value = 1\n");
  assert.equal(w.events().filter(event => event.method === "initialize").length, 1);
});

test("selected fix providers: Biome full-document EOF actions work through fix and selected code-actions", async () => {
  for (const command of ["fix", "code-actions"]) {
    const w = workspace(), plan = join(w.root, "eof.json"), kind = "source.fixAll.biome";
    w.setScenario({ capabilities: { codeActionProvider: { codeActionKinds: [kind] } }, responses: {
      "textDocument/codeAction": [{ title: "Fix all", kind, edit: { changes: { [w.uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }, newText: "fixed = 1\n" }] } } }],
    } });
    if (command === "fix") {
      assert.equal((await run({ ...w.args(command, "--kind", "source.fixAll", "--plan", plan), timeout: 2000 })).data.saved, true);
      assert.equal(readFileSync(w.file, "utf8"), "value = 1\n");
      assert.equal((await run({ ...parseOptions(["apply", "--plan", plan], w.root), timeout: 2000 })).code, 0);
    } else assert.equal((await run(w.args(command, "--kind", "source.fixAll", "--query", "0", "--apply"))).data.applied, true);
    assert.equal(readFileSync(w.file, "utf8"), "fixed = 1\n");
    assert.deepEqual(object(object(w.events().find(event => event.method === "textDocument/codeAction")?.params).context).only, [kind]);
  }
});
