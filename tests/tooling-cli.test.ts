import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { parseOptions } from "../src/cli.ts";
import { queryOptions } from "../src/batch.ts";
import { run } from "../src/commands.ts";
import { LspClient } from "../src/client.ts";
import { object } from "../src/config.ts";
import { outputData } from "../src/commands.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); });
after(() => restore());
afterEach(async () => {
  const leaked = LspClient.active.size;
  await Promise.all([...LspClient.active].map(client => client.close()));
  cleanWorkspaces(); assert.equal(leaked, 0);
});

test("tooling CLI: explicit providers and check/plan have narrow scopes", () => {
  assert.partialDeepStrictEqual(parseOptions(["format", "--file", "a.ts", "--tool", "prettier", "--check"]), { tool: "prettier", check: true });
  assert.partialDeepStrictEqual(parseOptions(["lint", "--changed", "--server", "eslint", "--plan", "lint.json"]), { server: "eslint", plan: "lint.json" });
  for (const argv of [
    ["format", "--tool", "prettier", "--server", "biome"], ["format", "--check", "--plan", "p.json"],
    ["lint", "--check"], ["hover", "--tool", "ruff"], ["setup", "--server", "ruff"],
    ["format", "--tool="], ["format", "--server="], ["diagnostics", "--plan", "p.json"],
  ]) assert.throws(() => parseOptions(argv), /tool|server|check|plan/);
  assert.deepEqual(parseOptions(["format", "--range", "1:1-2:1", "--file", "a.ts"]).range, { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } });
});

test("tooling CLI: batch selectors stay per row and plans cannot be smuggled into streams", () => {
  const args = parseOptions(["batch", "--input", "-"]);
  assert.partialDeepStrictEqual(queryOptions(args, { command: "format", file: "a.ts", tool: "prettier", check: true }), { tool: "prettier", server: undefined, check: true, plan: undefined });
  assert.partialDeepStrictEqual(queryOptions(args, { command: "lint", file: "a.ts", server: "eslint" }), { server: "eslint", tool: undefined });
  for (const row of [
    { command: "lint", file: "a.py", tool: "ruff", server: "ruff" },
    { command: "lint", file: "a.py", check: true }, { command: "lint", file: "a.py", plan: "p.json" },
    { command: "hover", file: "a.py", tool: "ruff" }, { command: "format", file: "a.py", check: "yes" },
  ]) assert.throws(() => queryOptions(args, row), /tool|server|check|plan/);
});

test("tooling CLI: selected diagnostics/capabilities/raw formatting use one LSP and remain read-only", async () => {
  const edits = [{ range, newText: "formatted" }];
  const w = workspace({ capabilities: { documentFormattingProvider: true }, responses: { "textDocument/formatting": edits } });
  w.configs.linter = { ...w.configs.fixture, isLinter: true }; w.saveConfig();
  await run(w.args("diagnostics", "--server", "linter"));
  assert.equal(w.events().filter(event => event.method === "initialize").length, 1);
  const capabilities = await run(w.args("capabilities", "--server", "linter"));
  assert.equal((capabilities.data.servers as unknown[]).length, 1);
  const result = await run(w.args("request", "--server", "linter", "--method", "textDocument/formatting", "--payload", '{"options":{"tabSize":2,"insertSpaces":true}}'));
  assert.deepEqual(result.data.result, edits);
  assert.equal(readFileSync(w.file, "utf8"), "value = 1\n");
  assert.deepEqual(object(w.events().find(event => event.method === "textDocument/formatting")?.params).options, { tabSize: 2, insertSpaces: true });
  await assert.rejects(run(w.args("request", "--method", "textDocument/formatting", "--server", "missing")), /named missing/);
});

test("tooling CLI: format batch reuses one provider and keeps check failures in individual rows", async () => {
  const w = workspace({ capabilities: { documentFormattingProvider: true }, responses: { "textDocument/formatting": [{ range, newText: "formatted" }] } });
  const input = join(w.root, "queries.jsonl");
  writeFileSync(input, [false, true].map(check => JSON.stringify({ command: "format", file: w.file, server: "fixture", check })).join("\n"));
  const result = await run({ ...parseOptions(["batch", "--input", input], w.root), timeout: 1000 });
  assert.equal(result.code, 1);
  assert.deepEqual((result.data.results as Record<string, unknown>[]).map(row => row.code), [0, 1]);
  assert.equal(w.events().filter(event => event.method === "initialize").length, 1);
  assert.equal(readFileSync(w.file, "utf8"), "value = 1\n");
});

test("tooling CLI: a range starting after line one reaches range formatting unchanged", async () => {
  const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } };
  const w = workspace({ capabilities: { documentRangeFormattingProvider: true }, responses: { "textDocument/rangeFormatting": [{ range, newText: "VALUE" }] } });
  writeFileSync(w.file, "value = 1\nvalue = 2\n");
  const result = await run(w.args("format", "--server", "fixture", "--range", "2:1-2:6"));
  assert.equal(result.data.verified, true); assert.equal(result.data.needsFormatting, true);
  assert.deepEqual(object(w.events().find(event => event.method === "textDocument/rangeFormatting")?.params).range, range);
  assert.equal(readFileSync(w.file, "utf8"), "value = 1\nvalue = 2\n");
});

test("tooling CLI: fields and budgets retain formatting/application verification state", () => {
  const data = outputData({ success: false, applied: true, applicationState: "applied", verification: "pending", toolVerification: "unverified", needsFormatting: true, files: [{ file: "/a.ts", diff: "x".repeat(6000) }] }, { fields: ["files"], budget: 800 });
  assert.partialDeepStrictEqual(data, { success: false, applied: true, applicationState: "applied", verification: "pending", toolVerification: "unverified", needsFormatting: true });
  assert.ok(JSON.stringify(data).length <= 800);
  assert.equal(data.truncated, true);
});
