import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/commands.ts";
import { parseOptions } from "../src/cli.ts";
import { LspClient } from "../src/client.ts";
import { loadBaseline, saveBaseline } from "../src/baseline.ts";
import { MAX_FILE_BYTES, object } from "../src/config.ts";
import { cleanWorkspaces, isolateGlobalConfig, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); }); after(() => restore());
afterEach(async () => { const leaked = LspClient.active.size; await Promise.all([...LspClient.active].map(c => c.close())); cleanWorkspaces(); assert.equal(leaked, 0); });
const diagnostic = (line: number, message: string, severity = 1) => ({ range: { start: { line, character: 0 }, end: { line, character: 1 } }, message, severity, code: "E1", source: "fixture" });

test("baseline: complete capture ignores preview limits and classifies moved/new/resolved issues", async () => {
  const w = workspace({ diagnostics: [diagnostic(0, "existing"), diagnostic(1, "fix me", 2)] }), baseline = join(w.root, "before.json");
  writeFileSync(w.file, "old = bad\nwarn = bad\n");
  const before = await run(w.args("diagnostics", "--save-baseline", baseline, "--limit", "1"));
  assert.equal(before.code, 1); assert.equal(before.data.baselineSaved, baseline);
  assert.equal(loadBaseline(baseline).files[0].issues.length, 2);
  writeFileSync(w.file, "\nold = bad\nnew = bad\n");
  w.setScenario({ diagnostics: [diagnostic(1, "existing"), diagnostic(2, "introduced")] });
  const result = await run(w.args("diagnostics", "--baseline", baseline)), comparison = object(result.data.comparison);
  assert.equal(result.code, 1); assert.equal(comparison.verified, true); assert.deepEqual(comparison.counts, { new: 1, resolved: 1, existing: 1 });
  assert.equal(comparison.newErrors, 1);
  assert.partialDeepStrictEqual((object(comparison.existing).issues as unknown[])[0], { line: 2, previousLine: 1, message: "existing" });
});
test("baseline: existing errors stay visible while a verified zero-new-error comparison succeeds", async () => {
  const w = workspace({ diagnostics: [diagnostic(0, "existing")] }), baseline = join(w.root, "before.json");
  await run(w.args("diagnostics", "--save-baseline", baseline));
  const result = await run({ ...parseOptions(["diagnostics", "--baseline", baseline], w.root), timeout: 400 });
  assert.equal(result.code, 0); assert.equal(result.data.success, true); assert.equal(result.data.hasErrors, true);
  assert.equal(object(result.data.counts).errors, 1); assert.equal(object(result.data.comparison).newErrors, 0);
});
test("baseline: multiset matching retains duplicate diagnostics on identical source lines", async () => {
  const w = workspace({ diagnostics: [diagnostic(0, "same"), diagnostic(1, "same")] }), baseline = join(w.root, "before.json");
  writeFileSync(w.file, "same\n same\n"); await run(w.args("diagnostics", "--save-baseline", baseline));
  w.setScenario({ diagnostics: [diagnostic(0, "same")] });
  const result = await run(w.args("diagnostics", "--baseline", baseline));
  assert.deepEqual(object(result.data.comparison).counts, { new: 0, resolved: 1, existing: 1 });
});
test("baseline: diagnostics with different provider codes remain separate issues", async () => {
  const w = workspace({ diagnostics: [diagnostic(0, "same"), { ...diagnostic(0, "same"), code: "E2" }] }), baseline = join(w.root, "before.json");
  const result = await run(w.args("diagnostics", "--save-baseline", baseline));
  assert.equal(object(result.data.counts).errors, 2); assert.equal(loadBaseline(baseline).files[0].issues.length, 2);
});
test("baseline: changed analysis configuration is unverified and cannot claim resolutions", async () => {
  const w = workspace({ diagnostics: [diagnostic(0, "old")] }), baseline = join(w.root, "before.json");
  await run(w.args("diagnostics", "--save-baseline", baseline));
  w.configs.fixture.settings = { environment: "different" }; w.saveConfig(); w.setScenario({ diagnostics: [] });
  const result = await run(w.args("diagnostics", "--baseline", baseline)), comparison = object(result.data.comparison);
  assert.equal(result.code, 1); assert.equal(comparison.verified, false); assert.equal(comparison.configurationMatches, false); assert.equal(comparison.resolved, undefined);
});
test("baseline: uncovered files and foreign workspaces stay explicit", async () => {
  const w = workspace(), baseline = join(w.root, "before.json"), sibling = join(w.root, "other.fixture");
  await run(w.args("diagnostics", "--save-baseline", baseline)); writeFileSync(sibling, "other = 1\n");
  const result = await run({ ...w.args("diagnostics", "--baseline", baseline), file: sibling });
  assert.deepEqual(object(result.data.comparison).unbaselinedFiles, [sibling]); assert.equal(result.code, 1);
  const foreign = workspace();
  await assert.rejects(run(foreign.args("diagnostics", "--baseline", baseline)), /workspace mismatch/);
  assert.equal(existsSync(join(foreign.root, "wire.ndjson")), false);
});
test("baseline: unverified analysis preserves the previous snapshot and never resolves old issues", async () => {
  const w = workspace({ diagnostics: [diagnostic(0, "old")] }), baseline = join(w.root, "before.json");
  await run(w.args("diagnostics", "--save-baseline", baseline)); const before = readFileSync(baseline);
  w.setScenario({ diagnostics: false });
  const compared = await run({ ...w.args("diagnostics", "--baseline", baseline), timeout: 60 });
  assert.equal(object(compared.data.comparison).verified, false); assert.equal(object(compared.data.comparison).resolved, undefined);
  await assert.rejects(run({ ...w.args("diagnostics", "--save-baseline", baseline), timeout: 60 }), /unverified/);
  assert.deepEqual(readFileSync(baseline), before);
});
test("baseline: saving cannot overwrite arbitrary JSON or analyzed source", async () => {
  const w = workspace(), destination = join(w.root, "important.json"); writeFileSync(destination, '{"important":true}\n');
  await assert.rejects(run(w.args("diagnostics", "--save-baseline", destination)), /Invalid diagnostics baseline/);
  assert.equal(readFileSync(destination, "utf8"), '{"important":true}\n');
  await assert.rejects(run(w.args("diagnostics", "--save-baseline", w.file)), /\.json artifact/);
});
test("baseline: malformed provider ranges cannot produce a saved snapshot", async () => {
  const w = workspace({ diagnostics: [diagnostic(999, "bad range")] }), destination = join(w.root, "before.json");
  await assert.rejects(run(w.args("diagnostics", "--save-baseline", destination)), /outside the baseline source/);
  assert.equal(existsSync(destination), false);
});
test("baseline: output protects JSON source and cannot exceed its own reader limit", () => {
  const w = workspace(), source = join(w.root, "source.json"), destination = join(w.root, "oversized.json"); writeFileSync(source, "{}\n");
  const snapshot = { schema: 1 as const, root: w.root, servers: [], files: [{ file: source, issues: [] }] };
  assert.throws(() => saveBaseline(source, snapshot), /cannot overwrite analyzed source/); assert.equal(readFileSync(source, "utf8"), "{}\n");
  const oversized = { ...snapshot, files: [{ file: w.file, issues: [{ anchor: "0".repeat(64), diagnostic: { ...diagnostic(0, "x".repeat(MAX_FILE_BYTES)), severity: 1 as const } }] }] };
  assert.throws(() => saveBaseline(destination, oversized), /exceeds 16 MiB/); assert.equal(existsSync(destination), false);
});
test("baseline: malformed or incomplete JSON snapshots fail before language-server initialization", async () => {
  const w = workspace(), destination = join(w.root, "before.json");
  for (const value of ["{", JSON.stringify({ verified: true, checked: [], truncated: true }), JSON.stringify({ schema: 1, root: w.root, servers: [], files: [{ file: join(w.root, "x"), issues: [{ anchor: "0".repeat(64), diagnostic: { message: "bad", range: null } }] }] })]) {
    writeFileSync(destination, value); await assert.rejects(run(w.args("diagnostics", "--baseline", destination)));
  }
  assert.equal(existsSync(join(w.root, "wire.ndjson")), false);
});
test("baseline flags: empty paths and unrelated commands are rejected", () => {
  assert.throws(() => parseOptions(["hover", "--baseline", "before.json"]), /only available/);
  assert.throws(() => parseOptions(["diagnostics", "--baseline="]), /nonempty/);
});
