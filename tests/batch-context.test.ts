import assert from "node:assert/strict";
import { after, afterEach, before, mock, test } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import childProcess from "node:child_process";
import { parseOptions } from "../src/cli.ts";
import { run } from "../src/commands.ts";
import { batchQueries } from "../src/batch.ts";
import { LspClient } from "../src/client.ts";
import { fileUri, object, MAX_FILES, MAX_FILE_BYTES } from "../src/config.ts";
import { selectFields } from "../src/output.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); });
after(() => restore());
afterEach(async () => {
  mock.restoreAll(); const leaked = LspClient.active.size;
  await Promise.all([...LspClient.active].map(client => client.close()));
  cleanWorkspaces(); assert.equal(leaked, 0, "every batch must close all its servers");
});
const capabilities = { hoverProvider: true, definitionProvider: true, typeDefinitionProvider: true, referencesProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true };
function input(w: ReturnType<typeof workspace>, rows: unknown[]) {
  const file = join(w.root, "queries.jsonl"); writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n"));
  return { ...parseOptions(["batch", "--input", file, "--json"], w.root), timeout: 400 };
}
const query = (command = "hover", file = "source.fixture") => ({ command, file });
const responses = { "textDocument/hover": { contents: "value" }, "textDocument/documentSymbol": [] };
const rows = (value: unknown) => value as Record<string, unknown>[];

test("batch: mixed file queries initialize once and open each document exactly once", async () => {
  const w = workspace({ capabilities, responses });
  const second = join(w.root, "second.fixture"); writeFileSync(second, "other = 2\n");
  const result = await run(input(w, [query(), query("symbols", "second.fixture"), query("inspect"), query("diagnostics")]));
  assert.partialDeepStrictEqual(result.data, { success: true, applied: false, total: 4, failed: 0 });
  assert.deepEqual(rows(result.data.results).map(row => [row.index, row.inputLine, row.command, row.code]), [[0, 1, "hover", 0], [1, 2, "symbols", 0], [2, 3, "inspect", 0], [3, 4, "diagnostics", 0]]);
  assert.ok(rows(result.data.results).every(row => row.line === 1)); assert.deepEqual(result.data.failedQueries, []);
  const events = w.events();
  for (const method of ["initialize", "shutdown"]) assert.equal(events.filter(e => e.method === method).length, 1);
  assert.deepEqual(events.filter(e => e.method === "textDocument/didOpen").map(e => object(object(e.params).textDocument).uri), [w.uri, fileUri(second)]);
  assert.equal(object(object(object(events.find(e => e.method === "initialize")?.params).capabilities).workspace).applyEdit, false);
});
test("batch: roots, configurations and lint servers keep separate lifetimes", async () => {
  const a = workspace({ capabilities, responses }), b = workspace({ capabilities, responses });
  a.configs.linter = { ...a.configs.fixture, isLinter: true }; a.saveConfig();
  const result = await run(input(a, [query("inspect"), query("inspect"), { ...query(), cwd: b.root }]));
  assert.equal(result.data.success, true);
  assert.equal(a.events().filter(e => e.method === "initialize").length, 2);
  assert.equal(b.events().filter(e => e.method === "initialize").length, 1);
});
test("batch: the active-server ceiling evicts the oldest session and reaps every child", async () => {
  const projects = Array.from({ length: 9 }, () => workspace({ responses })), first = projects[0];
  const start = LspClient.start; let maximum = 0;
  mock.method(LspClient, "start", async (...args: Parameters<typeof LspClient.start>) => {
    const client = await start(...args); maximum = Math.max(maximum, LspClient.active.size); return client;
  });
  const result = await run(input(first, [...projects, first].map(w => ({ ...query(), cwd: w.root }))));
  assert.equal(result.data.success, true); assert.equal(maximum, 8);
  assert.equal(first.events().filter(e => e.method === "initialize").length, 2);
  for (const w of projects) for (const event of w.events().filter(e => e.direction === "lifecycle")) assert.throws(() => process.kill(Number(event.pid), 0));
});
test("batch: a timeout cancels one query and the next query uses the same process", async () => {
  const w = workspace({ capabilities, stallMethods: ["textDocument/hover"] });
  const result = await run({ ...input(w, [query(), query("definition")]), timeout: 80 });
  assert.equal(result.code, 1); assert.equal(result.data.failed, 1);
  assert.deepEqual(rows(result.data.results).map(row => row.code), [2, 0]);
  assert.equal(w.events().filter(e => e.method === "initialize").length, 1);
  assert.ok(w.events().some(e => e.method === "$/cancelRequest"));
});
test("navigation: a request expiring at the retry deadline retains the command timeout explanation", async () => {
  const w = workspace(), request = LspClient.prototype.request;
  mock.method(LspClient.prototype, "request", function(this: LspClient, method: string, params: unknown, timeoutMs = this.timeoutMs) {
    if (method === "textDocument/definition") return new Promise((_, reject) => setTimeout(() => reject(new Error(`LSP request ${method} timed out after ${timeoutMs / 1000}s`)), timeoutMs + 5));
    return request.call(this, method, params, timeoutMs);
  });
  await assert.rejects(run({ ...w.args("definition"), timeout: 100 }), /Timed out waiting for definition/);
});
test("batch: a poisoned transport is replaced before the next query", async () => {
  const w = workspace({ capabilities, corruptUtf8: "textDocument/hover", responses: { "textDocument/hover": { contents: "INVALID_UTF8" } } });
  const result = await run(input(w, [query(), query("definition")]));
  assert.deepEqual(rows(result.data.results).map(row => row.code), [2, 0]);
  assert.match(String(rows(result.data.results)[0].error), /UTF-8/);
  assert.equal(w.events().filter(e => e.method === "initialize").length, 2);
  for (const event of w.events().filter(e => e.direction === "lifecycle")) assert.throws(() => process.kill(Number(event.pid), 0));
});
test("batch: per-query file failures retain later results and source-line identity", async () => {
  const w = workspace({ responses });
  const args = input(w, [query("hover", "missing.fixture"), query()]);
  writeFileSync(args.input!, "\n" + readFileSync(args.input!, "utf8").replace("\n", "\n\n"));
  const result = await run(args);
  assert.deepEqual(rows(result.data.results).map(row => [row.inputLine, row.line, row.code]), [[2, 1, 2], [4, 1, 0]]);
  assert.deepEqual(result.data.failedQueries, [{ index: 0, inputLine: 2, code: 2 }]); assert.equal(result.data.succeeded, 1);
  assert.match(String(result.data.hint), /Successful results remain available/);
  assert.deepEqual(selectFields(result.data, ["results"]).failedQueries, [{ index: 0, inputLine: 2, code: 2 }]);
  assert.equal(w.events().filter(e => e.method === "initialize").length, 1);
});
test("batch: workspace symbols reuse an already opened project", async () => {
  const w = workspace({ capabilities, responses });
  const result = await run(input(w, [query(), { ...query("symbols"), workspace: true, query: "value" }]));
  assert.equal(result.data.success, true);
  for (const method of ["initialize", "textDocument/didOpen", "shutdown"]) assert.equal(w.events().filter(e => e.method === method).length, 1);
});
test("batch: server edit callbacks cannot change files", async () => {
  const w = workspace(); w.setScenario({ capabilities, callbacks: { "textDocument/hover": { method: "workspace/applyEdit", params: { edit: { changes: { [w.uri]: [{ range, newText: "corrupted" }] } } } } } });
  const before = readFileSync(w.file);
  await run(input(w, [query(), query("symbols")]));
  assert.deepEqual(readFileSync(w.file), before);
  const callback = w.events().find(e => e.direction === "receive" && e.id === "server-request");
  assert.equal(object(callback?.result).applied, false);
});
test("batch: Rust checks are planned before the first shared server starts", async () => {
  const w = workspace({ capabilities, serverStatus: { quiescent: true, health: "ok" }, progress: [{ token: "rustAnalyzer/check", value: { kind: "begin", title: "cargo check" } }, { token: "rustAnalyzer/check", value: { kind: "end" } }], responses });
  w.configs["rust-analyzer"] = { ...w.configs.fixture, settings: { "rust-analyzer": { checkOnSave: false } } }; delete w.configs.fixture; w.saveConfig();
  assert.equal((await run(input(w, [query(), query("inspect"), query("diagnostics")]))).data.success, true);
  assert.equal(w.events().filter(e => e.method === "initialize").length, 1);
  assert.equal(object(object(object(w.events().find(e => e.method === "workspace/didChangeConfiguration")?.params).settings)["rust-analyzer"]).checkOnSave, true);
});
test("batch: concurrent source changes fail before querying a stale document", async () => {
  const w = workspace({ capabilities });
  w.setScenario({ capabilities, beforeResponse: { "textDocument/hover": { file: w.file, text: "external = 2\n" } }, responses });
  const result = await run(input(w, [query(), query("definition"), query("symbols")]));
  assert.deepEqual(rows(result.data.results).map(row => row.code), [0, 2, 0]);
  assert.match(String(rows(result.data.results)[1].error), /File changed/);
  assert.equal(w.events().filter(e => e.method === "textDocument/definition").length, 0);
  assert.equal(readFileSync(w.file, "utf8"), "external = 2\n");
});
for (const [label, value] of [
  ["array", []], ["null", null], ["write command", query("rename")], ["nested batch", query("batch")],
  ["unknown field", { ...query(), apply: true }], ["missing file", { command: "hover" }],
  ["string line", { ...query(), line: "2" }], ["negative column", { ...query(), column: -1 }],
  ["fractional limit", { ...query(), limit: 0.5 }], ["context type", { ...query("inspect"), context: "true" }],
  ["misplaced context", { ...query(), context: true }], ["misplaced workspace", { ...query(), workspace: true }],
  ["blank cwd", { ...query(), cwd: "" }], ["non-string symbol", { ...query(), symbol: 3 }],
  ["invalid fields", { ...query(), fields: "results[0]" }],
] as const) test(`batch input: ${label} is rejected before any server starts`, async () => {
  const w = workspace(), start = mock.method(LspClient, "start");
  await assert.rejects(run(input(w, [query(), value])), /Batch input line 2/);
  assert.equal(start.mock.callCount(), 0);
});
test("batch input: malformed JSON, empty files, invalid UTF-8 and query limits are explicit", async () => {
  const w = workspace(), args = input(w, []);
  for (const [value, error] of [[" ", /no queries/], ["{", /line 1/], [Buffer.from([0xff]), /encoded data|UTF-8/i], [Array.from({ length: MAX_FILES + 1 }, () => JSON.stringify(query())).join("\n"), /at most 200/]] as const) {
    writeFileSync(args.input!, value); await assert.rejects(run(args), error);
  }
  writeFileSync(args.input!, " ".repeat(MAX_FILE_BYTES + 1)); await assert.rejects(run(args), /exceeds/);
});
test("batch input: CRLF, BOM, spaces in paths, cwd and row limits are preserved", async () => {
  const w = workspace(), args = input(w, [{ ...query("inspect"), limit: 0, context: true }, query("symbols")]);
  writeFileSync(args.input!, "\ufeff\r\n" + readFileSync(args.input!, "utf8").replaceAll("\n", "\r\n"));
  const values = await batchQueries(args);
  assert.equal(values[0].line, 2); assert.equal(values[0].options.limit, 0); assert.equal(values[0].options.context, true);
  assert.equal(values[1].options.limit, 10); assert.equal(values[1].options.cwd, w.root);
});
test("batch CLI: stdin emits one JSON object and preserves query failures", () => {
  const w = workspace({ responses }), cli = join(import.meta.dirname, "../src/cli.js");
  const result = spawnSync(process.execPath, [cli, "batch", "--input", "-", "--cwd", w.root, "--json"], { input: [query("hover", "missing.fixture"), query()].map(row => JSON.stringify(row)).join("\n"), encoding: "utf8" });
  assert.equal(result.status, 1); const value = JSON.parse(result.stdout);
  assert.equal(value.total, 2); assert.deepEqual(rows(value.results).map(row => row.code), [2, 0]);
  assert.equal(result.stderr, "");
});
for (const signal of (process.platform === "win32" ? [] : ["SIGINT", "SIGTERM"] as const)) test(`batch CLI: ${signal} closes all shared servers`, async () => {
  const a = workspace({ responses }), b = workspace({ stallMethods: ["textDocument/hover"] });
  const args = input(a, [query(), { ...query(), cwd: b.root }]), trace = join(b.root, "wire.ndjson");
  const child = spawn(process.execPath, [join(import.meta.dirname, "../src/cli.js"), "batch", "--input", args.input!, "--timeout", "5", "--json"], { cwd: a.root, stdio: "ignore" });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  try {
    const deadline = Date.now() + 5000;
    while ((!existsSync(trace) || !readFileSync(trace, "utf8").includes('"method":"textDocument/hover"')) && Date.now() < deadline) await sleep(20);
    assert.ok(existsSync(trace) && readFileSync(trace, "utf8").includes('"method":"textDocument/hover"'));
    child.kill(signal); const code = await exited;
    if (process.platform !== "win32") assert.equal(code, signal === "SIGINT" ? 130 : 143);
    for (const w of [a, b]) for (const event of w.events().filter(e => e.direction === "lifecycle")) assert.throws(() => process.kill(Number(event.pid), 0));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    for (const w of [a, b]) if (existsSync(join(w.root, "wire.ndjson"))) for (const event of w.events().filter(e => e.direction === "lifecycle")) { try { process.kill(Number(event.pid), "SIGKILL"); } catch {} }
  }
});
test("new flags: unrelated commands and batch writes fail with guidance", async () => {
  for (const args of [["hover", "--context"], ["hover", "--input", "a"], ["batch", "--context"]]) assert.throws(() => parseOptions(args), /only available/);
  const w = workspace(); await assert.rejects(run(parseOptions(["batch"], w.root)), /requires --input/);
  await assert.rejects(run({ ...input(w, [query()]), apply: true }), /read-only/);
});
test("batch: per-row fields omit bulk diagnostics while preserving section state and failure summaries", async () => {
  const diagnostics = Array.from({ length: 20 }, () => ({ range, severity: 1, message: "existing project error ".repeat(100) }));
  const w = workspace({ capabilities, responses, diagnostics });
  const result = await run(input(w, [{ ...query("inspect"), context: true, fields: "results.context.snippets,results.diagnostics.counts" }, { ...query(), fields: "hover" }]));
  const selected = rows(result.data.results), inspection = object(selected[0].results);
  assert.equal(object(inspection.diagnostics).verified, true); assert.equal(object(inspection.diagnostics).hasErrors, true);
  assert.equal(object(inspection.diagnostics).checked, undefined); assert.ok(Array.isArray(object(inspection.context).snippets));
  assert.deepEqual(result.data.failedQueries, [{ index: 0, inputLine: 1, code: 1, failedSections: ["diagnostics"] }]);
  assert.equal(selected[1].hover, "value"); assert.equal(selected[1].code, 0);
  assert.ok(JSON.stringify(result.data).length < 4000); assert.equal(w.events().filter(e => e.method === "initialize").length, 1);
});

test("inspect context: nearby-line fallback merges repeated source/definition/type/reference declarations", async () => {
  const w = workspace(); w.setScenario({ capabilities, responses: { ...responses, "textDocument/definition": { uri: w.uri, range }, "textDocument/typeDefinition": { uri: w.uri, range }, "textDocument/references": [{ uri: w.uri, range }, { uri: w.uri, range }] } });
  const result = await run(w.args("inspect", "--context")), context = object(object(result.data.results).context), snippets = rows(context.snippets);
  assert.equal(result.data.success, true); assert.equal(snippets.length, 1);
  assert.deepEqual(snippets[0].roles, ["source", "definition", "type", "reference"]); assert.equal(snippets[0].provider, "lines");
  assert.ok(String(snippets[0].snippet).includes("value = 1"));
  assert.equal(w.events().filter(e => e.method === "initialize").length, 1);
  assert.equal(w.events().filter(e => e.method === "textDocument/typeDefinition").length, 1);
});
test("inspect context: source and definitions share one text budget with exact omission metadata", async () => {
  const w = workspace(), sibling = join(w.root, "sibling.fixture");
  const text = "value = '" + "😀".repeat(10000) + "'\n"; writeFileSync(w.file, text); writeFileSync(sibling, text);
  w.setScenario({ capabilities, responses: { ...responses, "textDocument/definition": { uri: fileUri(sibling), range } } });
  const result = await run(w.args("inspect", "--context")), context = object(object(result.data.results).context), snippets = rows(context.snippets);
  assert.equal(snippets.length, 2); assert.equal(context.textTruncated, true); assert.equal(context.truncated, true);
  assert.ok(snippets.reduce((sum, row) => sum + String(row.snippet).length, 0) <= 6000);
  for (const snippet of snippets) { assert.ok(String(snippet.snippet).isWellFormed()); assert.equal(object(snippet.characters).total, text.length); assert.equal(object(snippet.characters).shown, String(snippet.snippet).length); }
  const full = object(object((await run(w.args("inspect", "--context", "--limit", "0"))).data.results).context);
  assert.equal(full.truncated, false); assert.ok(rows(full.snippets).every(row => row.snippet === text));
});
test("inspect context: references are sampled by default and complete output is opt-in", async () => {
  const w = workspace(), refs = Array.from({ length: 8 }, (_, i) => { const file = join(w.root, `ref${i}.fixture`); writeFileSync(file, `use${i} = value\n`); return { uri: fileUri(file), range }; });
  w.setScenario({ capabilities, responses: { ...responses, "textDocument/references": refs } });
  const limited = object(object((await run(w.args("inspect", "--context"))).data.results).context);
  assert.equal(rows(limited.snippets).length, 4); assert.equal(limited.omittedLocations, 5); assert.equal(limited.truncated, true);
  const full = object(object((await run(w.args("inspect", "--context", "--limit", "0"))).data.results).context);
  assert.equal(rows(full.snippets).length, 9); assert.equal(full.omittedLocations, 0); assert.equal(full.truncated, false);
});
test("inspect context: unreadable definitions retain valid sections and errors identify their source", async () => {
  const w = workspace(); w.setScenario({ capabilities, responses: { ...responses, "textDocument/definition": { uri: fileUri(join(w.root, "missing.fixture")), range } } });
  const result = await run(w.args("inspect", "--context"));
  assert.equal(result.code, 1); assert.deepEqual(result.data.failedSections, ["context"]);
  assert.equal(object(object(result.data.results).hover).found, true);
  const context = object(object(result.data.results).context); assert.equal(rows(context.snippets).length, 1); assert.equal(rows(context.errors)[0].role, "definition");
});
test("inspect context: out-of-file and mid-surrogate locations cannot produce misleading snippets", async () => {
  const w = workspace(), sibling = join(w.root, "sibling.fixture"); writeFileSync(sibling, "😀target = 1\n");
  for (const start of [{ line: 9999, character: 0 }, { line: 0, character: 1 }]) {
    w.setScenario({ capabilities, responses: { ...responses, "textDocument/definition": { uri: fileUri(sibling), range: { start, end: start } } } });
    const context = object(object((await run(w.args("inspect", "--context"))).data.results).context);
    assert.equal(context.success, false); assert.ok(rows(context.snippets).every(row => row.file !== sibling));
    assert.match(String(rows(context.errors)[0].error), /outside the current source|UTF-16/);
  }
});
test("inspect context: concurrent changes discard stale source snippets without touching the external edit", async () => {
  const w = workspace(); w.setScenario({ capabilities, responses, beforeResponse: { "textDocument/hover": { file: w.file, text: "external = 2\n" } } });
  const result = await run(w.args("inspect", "--context")), context = object(object(result.data.results).context);
  assert.equal(result.data.success, false); assert.equal(rows(context.snippets).length, 0);
  assert.match(String(rows(context.errors)[0].error), /Source changed/); assert.equal(readFileSync(w.file, "utf8"), "external = 2\n");
});
test("inspect context: AST declarations are extracted and invalidated if a later extraction changes an earlier file", async () => {
  const w = workspace(), file = join(w.root, "first.ts"), sibling = join(w.root, "second.ts");
  const text = "export function value() { return 1; }\n";
  writeFileSync(file, text); writeFileSync(sibling, text);
  w.configs.fixture.fileTypes = [".ts"]; w.saveConfig();
  w.setScenario({ capabilities, responses: { ...responses, "textDocument/definition": { uri: fileUri(sibling), range } } });
  const bin = join(w.root, "node_modules/.bin"); mkdirSync(bin, { recursive: true }); writeFileSync(join(bin, process.platform === "win32" ? "ast-grep.cmd" : "ast-grep"), "", { mode: 0o755 });
  let calls = 0, mutate = false;
  mock.method(childProcess, "execFile", ((_command: string, _args: string[], _options: unknown, done: (error: Error | null, stdout: string, stderr: string) => void) => ({ stdin: { on() {}, end(source: string) {
    if (mutate && ++calls === 2) writeFileSync(file, "external change\n");
    queueMicrotask(() => done(null, JSON.stringify([{ text: source, ruleId: "snippet", range: { byteOffset: { start: 0, end: Buffer.byteLength(source) } } }]), ""));
  } } })) as never);
  const args = { ...w.args("inspect", "--context"), file };
  const first = object(object((await run(args)).data.results).context);
  assert.ok(rows(first.snippets).every(row => row.provider === "ast-grep" && row.snippet === text)); assert.equal(rows(first.snippets).length, 2);
  mutate = true;
  const second = object(object((await run(args)).data.results).context);
  assert.equal(second.success, false); assert.ok(rows(second.snippets).every(row => row.file !== file));
  assert.ok(rows(second.errors).some(row => String(row.error).includes("changed")));
});
