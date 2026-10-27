import assert from "node:assert/strict";
import { after, afterEach, before, test, mock } from "node:test";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LspClient } from "../src/client.ts";
import { run } from "../src/commands.ts";
import { configPaths, fileUri, object } from "../src/config.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); });
after(() => restore());
afterEach(async () => {
  const leaked = LspClient.active.size;
  await Promise.all([...LspClient.active].map((client) => client.close()));
  cleanWorkspaces(); assert.strictEqual(leaked, 0);
});

for (const [caseIndex, caseValue] of ([undefined, '{"position":{"line":0,"character":2}}']).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (payload) => {
  const result = { signatures: [{ label: "value(name: string): void" }], activeSignature: 0 };
  const w = workspace({ responses: { "textDocument/signatureHelp": result } });
  const response = await run(w.args("request", "--method", "textDocument/signatureHelp", ...(payload ? ["--payload", payload] : [])));
  assert.partialDeepStrictEqual(response.data, { applied: false, result });
  const params = object(w.events().find((e) => e.method === "textDocument/signatureHelp")?.params);
  assert.deepStrictEqual(params.textDocument, { uri: w.uri }); assert.deepStrictEqual(params.position, { line: 0, character: payload ? 2 : 0 });
  const caps = object(object(w.events().find((e) => e.method === "initialize")?.params).capabilities);
  assert.strictEqual(object(caps.workspace).applyEdit, false);
};
  test("signatureHelp: read-only requests fill file context with payload=%s".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("raw requests: explicit text document URI is retained while missing context is filled", async () => {
  const w = workspace(), uri = fileUri(join(w.root, "other.fixture"));
  await run(w.args("request", "--method", "textDocument/hover", "--payload", JSON.stringify({ textDocument: { uri }, position: { line: 2, character: 3 } })));
  assert.deepStrictEqual(w.events().find((e) => e.method === "textDocument/hover")?.params, { textDocument: { uri }, position: { line: 2, character: 3 } });
});
for (const [caseIndex, caseValue] of (["null", "[]", "1"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (payload) => {
  const w = workspace(), start = mock.method(LspClient, "start");
  try { await assert.rejects(run(w.args("request", "--method", "textDocument/hover", "--payload", payload)), (error) => error instanceof Error && error.message.includes(String("object"))); assert.strictEqual(start.mock.callCount(), 0); }
  finally { start.mock.restore(); }
};
  test("raw requests: invalid document payload %s fails before startup".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("setup: marker-free project works from a nested file and an external cwd", async () => {
  const w = workspace(); rmSync(join(w.root, ".git"), { recursive: true }); rmSync(join(w.root, "fixture.project"));
  await run({ ...w.args("setup", "--project"), languages: ["fixture"] });
  const saved = JSON.parse(readFileSync(w.configPath, "utf8")); assert.ok((saved.servers.fixture.rootMarkers).includes(".codex/lsp.json"));
  mkdirSync(join(w.root, "src")); const target = join(w.root, "src/source.fixture"); renameSync(w.file, target);
  assert.strictEqual(configPaths(join(w.root, "src"))[1], w.configPath);
  const args = { ...w.args("status"), file: target, cwd: tmpdir() };
  assert.partialDeepStrictEqual((await run(args)).data.servers, [{ name: "fixture", root: w.root }]);
  assert.strictEqual((await run({ ...args, command: "doctor" })).data.success, true);
});
test("setup: selecting a disabled server explicitly enables it", async () => {
  const w = workspace(); w.configs.fixture.disabled = true; w.saveConfig();
  await run({ ...w.args("setup", "--project"), languages: ["fixture"] });
  assert.partialDeepStrictEqual((await run(w.args("status"))).data.servers, [{ name: "fixture" }]);
});
test("setup: a path supplied to the project flag gives an actionable error without writes", async () => {
  const w = workspace(), before = readFileSync(w.configPath);
  await assert.rejects(run({ ...w.args("setup", "--project"), languages: ["fixture", "."] }), (error) => error instanceof Error && error.message.includes(String("takes no path")));
  assert.deepStrictEqual(readFileSync(w.configPath), before);
});
test("configuration: parse errors identify the exact file before server startup", async () => {
  const w = workspace(), start = mock.method(LspClient, "start"); writeFileSync(w.configPath, '{"servers":{');
  try {
    await assert.rejects(run(w.args("status")), (error) => error instanceof Error && error.message.includes(String(`Cannot read LSP configuration ${w.configPath}:`)));
    assert.strictEqual(start.mock.callCount(), 0);
  } finally { start.mock.restore(); }
});
for (const [caseIndex, caseValue] of ([undefined, "--symbol", "--column"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (flag) => {
  const w = workspace({ responses: { "textDocument/codeAction": [] } }); writeFileSync(w.file, "  value = 1\r\n");
  await run(w.args("code-actions", ...(flag ? [flag, flag === "--symbol" ? "value" : "3"] : [])));
  const actionRange = object(w.events().find((e) => e.method === "textDocument/codeAction")?.params).range;
  assert.deepStrictEqual(actionRange, flag ? { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } } : { start: { line: 0, character: 0 }, end: { line: 0, character: 11 } });
};
  test("code actions: line/point range selection with %s".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("code actions: delayed initial diagnostics reach the request context", async () => {
  const diagnostic = { range, message: "missing import", severity: 1 };
  const w = workspace({ diagnostics: [diagnostic], diagnosticDelay: 40, responses: { "textDocument/codeAction": [] } });
  await run(w.args("code-actions"));
  assert.deepStrictEqual(object(object(w.events().find((e) => e.method === "textDocument/codeAction")?.params).context).diagnostics, [diagnostic]);
});
test("navigation: a verified empty hover is a not-found result", async () => {
  const w = workspace({ responses: { "textDocument/hover": null } });
  assert.partialDeepStrictEqual((await run(w.args("hover"))).data, { success: true, found: false });
});
test("diagnostics: a shared deadline bounds pull failure and push fallback", async () => {
  const w = workspace({ capabilities: { diagnosticProvider: true }, diagnostics: false, stallMethods: ["textDocument/diagnostic"] });
  const client = await LspClient.start({ ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath }, 2000);
  try {
    await client.open(w.file);
    const wait = mock.method(client, "waitDiagnostics", async () => { throw new Error("No push result"); });
    const result = await client.getDiagnostics(w.uri, 80);
    assert.deepStrictEqual(result, { diagnostics: [], verified: false });
    assert.ok(Number(wait.mock.calls[0]!.arguments[1]) <= 5); wait.mock.restore();
    await client.request("fixture/echo", {});
    assert.strictEqual(w.events().some((e) => e.method === "$/cancelRequest"), true);
  } finally { await client.close(); }
});

const inspectCapabilities = { hoverProvider: true, definitionProvider: true, referencesProvider: true, documentSymbolProvider: true, renameProvider: true };
test("inspect: related queries and rename preview share one read-only process and open document", async () => {
  const w = workspace(), before = readFileSync(w.file, "utf8");
  w.setScenario({ capabilities: inspectCapabilities, responses: {
    "textDocument/hover": { contents: "fixture value" },
    "textDocument/definition": { uri: w.uri, range },
    "textDocument/references": [{ uri: w.uri, range }, { uri: w.uri, range }],
    "textDocument/documentSymbol": [{ name: "value", kind: 12, range, selectionRange: range }],
    "textDocument/rename": { changes: { [w.uri]: [{ range, newText: "renamed" }] } },
  } });
  const response = await run(w.args("inspect", "--symbol", "value", "--new-name", "renamed", "--limit", "1"));
  assert.partialDeepStrictEqual(response.data, { success: true, applied: false, results: {
    hover: { found: true, hover: "fixture value" }, definition: { found: true },
    references: { total: 2, shown: 1, truncated: true }, symbols: { total: 1 },
    diagnostics: { verified: true }, rename: { applied: false, total: 1 },
  } });
  const events = w.events();
  for (const method of ["initialize", "textDocument/didOpen", "shutdown", "textDocument/rename"])
    assert.strictEqual((events.filter((e) => e.method === method)).length, 1);
  assert.strictEqual(object(object(object(events.find((e) => e.method === "initialize")?.params).capabilities).workspace).applyEdit, false);
  assert.strictEqual(readFileSync(w.file, "utf8"), before);
});
for (const [caseIndex, caseValue] of (["--apply", "--changed", "--workspace"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (flag) => {
  const w = workspace(), start = mock.method(LspClient, "start");
  try { await assert.rejects(run(w.args("inspect", flag)), (error) => error instanceof Error && error.message.includes(String("read-only"))); assert.strictEqual(start.mock.callCount(), 0); }
  finally { start.mock.restore(); }
};
  test("inspect: rejects %s before server startup".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("inspect: unsupported capabilities are explicit and independent sections survive a server error", async () => {
  const w = workspace({ capabilities: { hoverProvider: true }, errors: { "textDocument/hover": { code: -32603, message: "hover failed" } } });
  const response = await run(w.args("inspect"));
  assert.strictEqual(response.code, 1);
  assert.partialDeepStrictEqual(response.data, { success: false, failedSections: ["hover"], results: {
    hover: { success: false, error: "LSP error -32603: hover failed" },
    definition: { supported: false }, references: { supported: false },
    symbols: { supported: false }, diagnostics: { verified: true, success: true },
  } });
});
test("inspect: server applyEdit callbacks cannot write and later sections still run", async () => {
  const w = workspace(), before = readFileSync(w.file, "utf8");
  w.setScenario({ capabilities: inspectCapabilities, callbacks: {
    "textDocument/hover": { method: "workspace/applyEdit", params: { edit: { changes: { [w.uri]: [{ range, newText: "changed" }] } } } },
  } });
  const response = await run(w.args("inspect"));
  assert.strictEqual(object(object(response.data.results).diagnostics).verified, true);
  const reply = w.events().find((e) => e.direction === "receive" && e.id === "server-request");
  assert.strictEqual(object(reply?.result).applied, false);
  assert.strictEqual(readFileSync(w.file, "utf8"), before);
});
test("inspect: includes other configured diagnostic servers without restarting the navigation server", async () => {
  const w = workspace({ capabilities: inspectCapabilities, responses: { "textDocument/hover": { contents: "value" } } });
  w.configs.linter = { ...w.configs.fixture, isLinter: true }; w.saveConfig();
  assert.strictEqual((await run(w.args("inspect"))).data.success, true);
  assert.strictEqual((w.events().filter((e) => e.method === "initialize")).length, 2);
  assert.strictEqual((w.events().filter((e) => e.method === "textDocument/didOpen")).length, 2);
});
test("inspect: timed-out queries cancel and later sections still complete", async () => {
  const w = workspace({ capabilities: inspectCapabilities, stallMethods: ["textDocument/hover"] });
  const result = await run({ ...w.args("inspect"), timeout: 80 });
  assert.partialDeepStrictEqual(result.data, { success: false, failedSections: ["hover"], results: { diagnostics: { verified: true } } });
  assert.strictEqual(w.events().some((e) => e.method === "$/cancelRequest"), true);
});
test("inspect: Rust compiler checks are enabled in its single server session", async () => {
  const w = workspace({ capabilities: {}, serverStatus: { quiescent: true, health: "ok" }, progress: [
    { token: "rustAnalyzer/check", value: { kind: "begin", title: "cargo check" } },
    { token: "rustAnalyzer/check", value: { kind: "end" } },
  ] });
  w.configs["rust-analyzer"] = { ...w.configs.fixture, settings: { "rust-analyzer": { checkOnSave: false, cargo: { features: ["sync"], noDefaultFeatures: true } } } }; delete w.configs.fixture; w.saveConfig();
  assert.strictEqual((await run(w.args("inspect"))).data.success, true);
  const events = w.events(); assert.strictEqual((events.filter((e) => e.method === "initialize")).length, 1);
  const settings = object(object(events.find((e) => e.method === "workspace/didChangeConfiguration")?.params).settings);
  assert.strictEqual(object(settings["rust-analyzer"]).checkOnSave, true);
  assert.deepStrictEqual(object(settings["rust-analyzer"]).cargo, { features: ["sync"], noDefaultFeatures: true });
  assert.strictEqual(object(w.configs["rust-analyzer"].settings?.["rust-analyzer"]).checkOnSave, false);
});
test("inspect: a concurrent source edit leaves diagnostics unverified and preserves the external edit", async () => {
  const w = workspace(); w.setScenario({ capabilities: { hoverProvider: true }, beforeResponse: { "textDocument/hover": { file: w.file, text: "external change\n" } }, responses: { "textDocument/hover": { contents: "old value" } } });
  const result = await run(w.args("inspect"));
  assert.partialDeepStrictEqual(result.data, { success: false, failedSections: ["diagnostics"], results: { diagnostics: { verified: false } } });
  assert.strictEqual(readFileSync(w.file, "utf8"), "external change\n");
});
