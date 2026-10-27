import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOptions } from "../src/cli.ts";
import { queryOptions } from "../src/batch.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); }); after(() => restore()); afterEach(() => cleanWorkspaces());
const cli = join(dirname(fileURLToPath(import.meta.url)), "../src/cli.js");

test("global budget: all JSON commands accept budgets and streaming rows inherit a session maximum", () => {
  for (const command of ["hover", "references", "symbols", "diagnostics", "complete", "callers", "next", "api-diff", "dependencies", "fix", "apply", "batch", "session"])
    assert.equal(parseOptions([command, "--budget", "1000"]).budget, 1000);
  const base = parseOptions(["session", "--stdio", "--budget", "800"]);
  assert.equal(queryOptions(base, { command: "hover", file: "source.ts" }, true).budget, 800);
  assert.equal(queryOptions(base, { command: "hover", file: "source.ts", budget: 1200 }, true).budget, 1200);
  assert.equal(queryOptions(base, { command: "hover", file: "source.ts", budget: 1200 }).budget, 1200);
  assert.throws(() => parseOptions(["hook", "--budget", "800"]), /hooks emit their own protocol/);
});

test("global budget: native hover, reference pages and completion fit complete output envelopes", () => {
  const w = workspace(); w.setScenario({ capabilities: { hoverProvider: true, referencesProvider: true, completionProvider: {} }, responses: {
    "textDocument/hover": { contents: "😀long hover ".repeat(10000) },
    "textDocument/references": Array.from({ length: 100 }, () => ({ uri: w.uri, range })),
    "textDocument/completion": { isIncomplete: false, items: Array.from({ length: 100 }, (_, id) => ({ label: `item${id}`, detail: "detail ".repeat(2000) })) },
  } });
  for (const flags of [["hover"], ["references", "--page-size", "80"], ["complete"]]) {
    const child = spawnSync(process.execPath, [cli, ...flags, "--file", w.file, "--budget", "1200"], { cwd: w.root, encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 0, child.stdout + child.stderr); assert.ok(child.stdout.trimEnd().length <= 1200);
    const data = JSON.parse(child.stdout); assert.equal(data.budget.characters, child.stdout.trimEnd().length); assert.equal(data.truncated, true);
    if (flags[0] === "references") assert.ok(data.nextCursor);
  }
});

test("global budget: long backend errors keep their exit status and fit the requested envelope", () => {
  const w = workspace(); w.setScenario({ capabilities: { hoverProvider: true }, errors: { "textDocument/hover": { code: -32603, message: "specific cause " + "😀details ".repeat(10000) } } });
  const child = spawnSync(process.execPath, [cli, "hover", "--file", w.file, "--budget", "512"], { cwd: w.root, encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 2); assert.ok(child.stdout.trimEnd().length <= 512); const data = JSON.parse(child.stdout);
  assert.equal(data.success, false); assert.match(data.error, /specific cause/); assert.equal(data.errorTruncated, true);
});

test("global budget: batch keeps every row status while sharing one backend", () => {
  const w = workspace(); w.setScenario({ capabilities: { hoverProvider: true }, responses: { "textDocument/hover": { contents: "details ".repeat(10000) } } });
  const input = [0, 1].map(() => JSON.stringify({ command: "hover", file: w.file })).join("\n");
  const child = spawnSync(process.execPath, [cli, "batch", "--input", "-", "--budget", "1500"], { cwd: w.root, input, encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stdout + child.stderr); const data = JSON.parse(child.stdout); assert.ok(child.stdout.trimEnd().length <= 1500);
  assert.deepEqual(data.results.map((row: Record<string, unknown>) => row.code), [0, 0]); assert.equal(data.succeeded, 2);
  assert.equal(w.events().filter(event => event.method === "initialize").length, 1);
});

test("global budget: diagnostics across providers cannot accumulate unbounded payloads or report verified emptiness", () => {
  const w = workspace({ diagnostics: [{ range, severity: 1, message: "cause " + "x".repeat(9 * 1024 * 1024) }] });
  w.configs.second = { ...w.configs.fixture }; w.saveConfig();
  const child = spawnSync(process.execPath, [cli, "diagnostics", "--file", w.file, "--budget", "1800"], { cwd: w.root, encoding: "utf8", timeout: 20000 });
  assert.equal(child.status, 1, child.stdout.slice(0, 2000) + child.stderr); assert.ok(child.stdout.trimEnd().length <= 1800);
  const data = JSON.parse(child.stdout); assert.equal(data.verified, false); assert.equal(data.hasErrors, true);
  assert.ok(data.checked.some((row: Record<string, unknown>) => (row.errors as string[]).some(error => error.includes("16 MiB aggregate limit"))));
});

test("read-only Git workflows: stale source timestamps never refresh index bytes or acquire optional locks", () => {
  const w = workspace(), source = join(w.root, "api.ts"); writeFileSync(source, "export function value() { return 42; }\n");
  const git = (args: string[]) => execFileSync("git", ["-C", w.root, ...args], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  git(["init", "--quiet"]); git(["config", "diff.autoRefreshIndex", "true"]); git(["add", "."]);
  git(["-c", "user.name=codex-lsp-fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + join(w.root, ".git/disabled-hooks"), "commit", "--quiet", "-m", "fixture"]);
  const index = readFileSync(join(w.root, ".git/index")), text = readFileSync(source);
  for (const flags of [["api-diff", "--base", "HEAD", "--file", source], ["impact", "--changed"], ["fix", "--changed", "--plan", join(w.root, "empty-plan.json")]]) {
    const later = new Date(Date.now() + 5000); utimesSync(source, later, later);
    const result = spawnSync(process.execPath, [cli, ...flags, "--json"], { cwd: w.root, env: { ...process.env, GIT_OPTIONAL_LOCKS: "1" }, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.deepEqual(readFileSync(join(w.root, ".git/index")), index, flags.join(" "));
    const data = JSON.parse(result.stdout);
    if (flags[0] === "api-diff") assert.equal(data.changedFiles, 0);
    if (flags[0] === "fix") { assert.equal(data.complete, true); assert.equal(data.saved, false); assert.deepEqual(data.skipped, []); }
    assert.deepEqual(readFileSync(source), text); assert.equal(existsSync(join(w.root, ".git/index.lock")), false);
  }
  renameSync(source, join(w.root, "moved.ts")); writeFileSync(join(w.root, "empty.ts"), ""); git(["add", "--all"]);
  const staged = readFileSync(join(w.root, ".git/index"));
  const renamed = spawnSync(process.execPath, [cli, "api-diff", "--base", "HEAD", "--json"], { cwd: w.root, encoding: "utf8", timeout: 10000 });
  assert.equal(renamed.status, 0, renamed.stdout + renamed.stderr);
  const data = JSON.parse(renamed.stdout); assert.equal(data.changedFiles, 3); assert.deepEqual(data.counts, { added: 1, removed: 1, modified: 0 });
  assert.deepEqual(readFileSync(join(w.root, ".git/index")), staged);
});
