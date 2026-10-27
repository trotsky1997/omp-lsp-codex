import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { saveEditPlan, applyPlan, type EditPlanInput } from "../src/fixes.ts";
import { type Options, type Result } from "../src/commands.ts";
import { object } from "../src/config.ts";
import { cleanWorkspaces, isolateGlobalConfig, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); }); after(() => restore());
afterEach(() => cleanWorkspaces());
type Workspace = ReturnType<typeof workspace>;
const args = (w: Workspace, values: Partial<Options> = {}): Options => ({ ...w.args("hover"), command: "format", plan: join(w.root, "format.json"), timeout: 2000, ...values });
const input = (w: Workspace, values: Partial<EditPlanInput> = {}): EditPlanInput => ({ kind: "format", files: [{ file: w.file, original: readFileSync(w.file, "utf8"), updated: "value = 2\n" }], verification: { command: "format", tool: "fixture" }, ...values });
const applying = (w: Workspace): Options => args(w, { command: "apply", file: undefined });
const ok = async (): Promise<Result> => ({ data: { verified: true, hasErrors: false }, human: "verified" });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

test("edit plans: formatter preview preserves source/index and secure save applies without a diagnostics baseline", async () => {
  const w = workspace(); execFileSync("git", ["init", "--quiet", w.root]); execFileSync("git", ["-C", w.root, "add", "."]);
  const index = readFileSync(join(w.root, ".git/index")), original = readFileSync(w.file, "utf8"), source = input(w);
  const preview = await saveEditPlan(args(w, { plan: undefined }), source);
  assert.equal(preview.data.saved, false); assert.equal(preview.data.applied, false); assert.equal(preview.data.total, 1);
  assert.match(String((preview.data.files as Record<string, unknown>[])[0].diff), /-value = 1\n\+value = 2/);
  assert.equal(existsSync(join(w.root, "format.json")), false); assert.equal(readFileSync(w.file, "utf8"), original);
  assert.equal((await saveEditPlan(args(w), source)).data.saved, true);
  const stored = JSON.parse(readFileSync(join(w.root, "format.json"), "utf8")); assert.equal(stored.baseline, undefined);
  let calls = 0;
  const applied = await applyPlan(applying(w), async (files, baseline, verification) => {
    calls++; assert.deepEqual(files, [w.file]); assert.equal(baseline, undefined); assert.deepEqual(verification, source.verification);
    assert.equal(readFileSync(w.file, "utf8"), "value = 2\n"); return ok();
  });
  assert.equal(calls, 1); assert.equal(applied.code, 0); assert.equal(applied.data.applied, true); assert.equal(applied.data.toolVerification, "verified");
  assert.equal(applied.data.diagnosticVerification, undefined); assert.equal(applied.data.verification, "pending");
  assert.deepEqual(readFileSync(join(w.root, ".git/index")), index);
  await assert.rejects(applyPlan(applying(w), ok), /applied/);
});

test("edit plans: native formatter verification receives actual post-apply bytes and preserves applied state on non-idempotence", async () => {
  const w = workspace(), source = input(w), events = join(w.root, "tool-events.jsonl"), executable = join(w.root, "formatter.cjs");
  writeFileSync(executable, 'const fs=require("node:fs");const text=fs.readFileSync(0,"utf8");fs.appendFileSync(process.argv[2],JSON.stringify({text,pid:process.pid})+"\\n");process.stdout.write(text.replace("2","3"));');
  await saveEditPlan(args(w), source);
  const result = await applyPlan(applying(w), async () => {
    const actual = readFileSync(w.file, "utf8"), processResult = spawnSync(process.execPath, [executable, events], { input: actual, encoding: "utf8", timeout: 5000 });
    assert.equal(processResult.status, 0, processResult.stderr);
    return { code: processResult.stdout === actual ? 0 : 1, data: { verified: true, hasErrors: processResult.stdout !== actual }, human: "formatter check" };
  });
  assert.equal(result.code, 1); assert.equal(result.data.applicationState, "applied"); assert.equal(result.data.toolVerification, "verified");
  assert.equal(object(result.data.toolResults).hasErrors, true); assert.equal(readFileSync(w.file, "utf8"), "value = 2\n");
  const event = JSON.parse(readFileSync(events, "utf8")); assert.equal(event.text, "value = 2\n"); assert.ok(event.pid > 0);
});

test("edit plans: changed or removed configuration guards stop apply before any source writes", async () => {
  for (const mode of ["modified", "removed"] as const) {
    const w = workspace(), config = join(w.root, "formatter.json"), original = "{\"indentWidth\":2}\n"; writeFileSync(config, original);
    await saveEditPlan(args(w), input(w, { guards: [{ file: config, sha256: sha(original) }] }));
    if (mode === "modified") writeFileSync(config, "{\"indentWidth\":4}\n"); else renameSync(config, config + ".old");
    let calls = 0;
    await assert.rejects(applyPlan(applying(w), async () => { calls++; return ok(); }), /Configuration changed/);
    assert.equal(calls, 0); assert.equal(readFileSync(w.file, "utf8"), "value = 1\n");
  }
  const created = workspace(), missing = join(created.root, "new-formatter.json");
  await saveEditPlan(args(created), input(created, { guards: [{ file: missing, sha256: null }] })); writeFileSync(missing, "{}\n");
  await assert.rejects(applyPlan(applying(created), ok), /Configuration changed/); assert.equal(readFileSync(created.file, "utf8"), "value = 1\n");
});

test("edit plans: source/config races, invalid guards and duplicate snapshots fail before saving", async () => {
  const w = workspace(), config = join(w.root, "formatter.json"); writeFileSync(config, "{}\n");
  await assert.rejects(saveEditPlan(args(w), input(w, { guards: [{ file: config, sha256: sha("old") }] })), /Configuration changed/);
  await assert.rejects(saveEditPlan(args(w), input(w, { guards: [{ file: config, sha256: "invalid" }] })), /Invalid.*guard/);
  const stale = input(w); writeFileSync(w.file, "user = 3\n"); await assert.rejects(saveEditPlan(args(w), stale), /Source changed/);
  const duplicate = input(w); duplicate.files.push(duplicate.files[0]); await assert.rejects(saveEditPlan(args(w), duplicate), /duplicate/);
  assert.equal(existsSync(join(w.root, "format.json")), false); assert.equal(readFileSync(w.file, "utf8"), "user = 3\n");
});

test("edit plans: empty/no-change previews create no artifact and verification failures preserve applied files", async () => {
  const w = workspace();
  const unchanged = await saveEditPlan(args(w), input(w, { files: [{ file: w.file, original: "value = 1\n", updated: "value = 1\n" }] }));
  assert.equal(unchanged.data.total, 0); assert.equal(unchanged.data.saved, false); assert.equal(existsSync(join(w.root, "format.json")), false);
  await assert.rejects(saveEditPlan(args(w), input(w, { verification: undefined })), /verification provider/);
  await saveEditPlan(args(w), input(w));
  const result = await applyPlan(applying(w), async () => { throw new Error("formatter disappeared"); });
  assert.equal(result.code, 1); assert.equal(result.data.applied, true); assert.equal(result.data.toolVerification, "failed"); assert.equal(result.data.applicationState, "applied");
  assert.equal(readFileSync(w.file, "utf8"), "value = 2\n");
});

test("edit plans: Unicode and CRLF snapshots round-trip without a language server", async () => {
  const w = workspace(), original = "😀value\r\n", updated = "😀 value\r\n"; writeFileSync(w.file, original);
  await saveEditPlan(args(w), input(w, { files: [{ file: w.file, original, updated }] }));
  assert.equal((await applyPlan(applying(w), ok)).code, 0); assert.equal(readFileSync(w.file, "utf8"), updated);
});

test("edit plans: directory aliases round-trip while artifact symlinks remain rejected", { skip: process.platform === "win32" }, async () => {
  const w = workspace(), real = join(w.root, "plans"), alias = join(w.root, "alias");
  mkdirSync(real); symlinkSync(real, alias, "dir");
  const plan = join(alias, "format.json"), saved = await saveEditPlan(args(w, { plan }), input(w));
  assert.equal(saved.data.plan, join(real, "format.json"));
  const link = join(real, "linked.json"); symlinkSync(join(real, "format.json"), link);
  await assert.rejects(applyPlan(args(w, { command: "apply", file: undefined, plan: link }), ok), /Unsafe/);
  assert.equal(readFileSync(w.file, "utf8"), "value = 1\n");
  const applied = await applyPlan(args(w, { command: "apply", file: undefined, plan }), ok);
  assert.equal(applied.code, 0); assert.equal(readFileSync(w.file, "utf8"), "value = 2\n");
});

test("edit plans: provider preflight rejection keeps source/index and receipt available for a safe retry", async () => {
  const w = workspace(); execFileSync("git", ["init", "--quiet", w.root]); execFileSync("git", ["-C", w.root, "add", "."]);
  const index = readFileSync(join(w.root, ".git/index")), planned = await saveEditPlan(args(w), input(w));
  let calls = 0;
  await assert.rejects(applyPlan(applying(w), async () => { calls++; return ok(); }, async (files, descriptor) => {
    assert.deepEqual(files, [w.file]); assert.equal(descriptor?.tool, "fixture"); throw new Error("Selected formatter executable changed");
  }), /executable changed/);
  assert.equal(calls, 0); assert.equal(readFileSync(w.file, "utf8"), "value = 1\n"); assert.deepEqual(readFileSync(join(w.root, ".git/index")), index);
  const receipt = join(homedir(), ".cache/codex-lsp/plans", String(planned.data.id) + ".json");
  assert.equal(JSON.parse(readFileSync(receipt, "utf8")).state, "planned"); assert.equal(existsSync(receipt + ".lock"), false);
  const applied = await applyPlan(applying(w), async () => ({ data: { verified: true, hasErrors: false, comparison: { verified: true, newErrors: 0 } }, human: "checked" }), async () => {});
  assert.equal(applied.code, 0); assert.equal(object(applied.data.comparison).newErrors, 0);
});
