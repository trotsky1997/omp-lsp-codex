import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LspClient } from "../src/client.ts";
import { run } from "../src/commands.ts";
import { configPaths, fileUri, object } from "../src/config.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
beforeAll(() => { restore = isolateGlobalConfig(); });
afterAll(() => restore());
afterEach(async () => {
  const leaked = LspClient.active.size;
  await Promise.all([...LspClient.active].map((client) => client.close()));
  cleanWorkspaces(); expect(leaked).toBe(0);
});

test.each([undefined, '{"position":{"line":0,"character":2}}'])("signatureHelp: read-only requests fill file context with payload=%s", async (payload) => {
  const result = { signatures: [{ label: "value(name: string): void" }], activeSignature: 0 };
  const w = workspace({ responses: { "textDocument/signatureHelp": result } });
  const response = await run(w.args("request", "--method", "textDocument/signatureHelp", ...(payload ? ["--payload", payload] : [])));
  expect(response.data).toMatchObject({ applied: false, result });
  const params = object(w.events().find((e) => e.method === "textDocument/signatureHelp")?.params);
  expect(params.textDocument).toEqual({ uri: w.uri }); expect(params.position).toEqual({ line: 0, character: payload ? 2 : 0 });
  const caps = object(object(w.events().find((e) => e.method === "initialize")?.params).capabilities);
  expect(object(caps.workspace).applyEdit).toBe(false);
});
test("raw requests: explicit text document URI is retained while missing context is filled", async () => {
  const w = workspace(), uri = fileUri(join(w.root, "other.fixture"));
  await run(w.args("request", "--method", "textDocument/hover", "--payload", JSON.stringify({ textDocument: { uri }, position: { line: 2, character: 3 } })));
  expect(w.events().find((e) => e.method === "textDocument/hover")?.params).toEqual({ textDocument: { uri }, position: { line: 2, character: 3 } });
});
test.each(["null", "[]", "1"])("raw requests: invalid document payload %s fails before startup", async (payload) => {
  const w = workspace(), start = spyOn(LspClient, "start");
  try { await expect(run(w.args("request", "--method", "textDocument/hover", "--payload", payload))).rejects.toThrow("object"); expect(start).not.toHaveBeenCalled(); }
  finally { start.mockRestore(); }
});
test("setup: marker-free project works from a nested file and an external cwd", async () => {
  const w = workspace(); rmSync(join(w.root, ".git"), { recursive: true }); rmSync(join(w.root, "fixture.project"));
  await run({ ...w.args("setup", "--project"), languages: ["fixture"] });
  const saved = JSON.parse(readFileSync(w.configPath, "utf8")); expect(saved.servers.fixture.rootMarkers).toContain(".codex/lsp.json");
  mkdirSync(join(w.root, "src")); const target = join(w.root, "src/source.fixture"); renameSync(w.file, target);
  expect(configPaths(join(w.root, "src"))[1]).toBe(w.configPath);
  const args = { ...w.args("status"), file: target, cwd: tmpdir() };
  expect((await run(args)).data.servers).toMatchObject([{ name: "fixture", root: w.root }]);
  expect((await run({ ...args, command: "doctor" })).data.success).toBe(true);
});
test("setup: selecting a disabled server explicitly enables it", async () => {
  const w = workspace(); w.configs.fixture.disabled = true; w.saveConfig();
  await run({ ...w.args("setup", "--project"), languages: ["fixture"] });
  expect((await run(w.args("status"))).data.servers).toMatchObject([{ name: "fixture" }]);
});
test("setup: a path supplied to the project flag gives an actionable error without writes", async () => {
  const w = workspace(), before = readFileSync(w.configPath);
  await expect(run({ ...w.args("setup", "--project"), languages: ["fixture", "."] })).rejects.toThrow("takes no path");
  expect(readFileSync(w.configPath)).toEqual(before);
});
test("configuration: parse errors identify the exact file before server startup", async () => {
  const w = workspace(), start = spyOn(LspClient, "start"); writeFileSync(w.configPath, '{"servers":{');
  try {
    await expect(run(w.args("status"))).rejects.toThrow(`Cannot read LSP configuration ${w.configPath}:`);
    expect(start).not.toHaveBeenCalled();
  } finally { start.mockRestore(); }
});
test.each([undefined, "--symbol", "--column"])("code actions: line/point range selection with %s", async (flag) => {
  const w = workspace({ responses: { "textDocument/codeAction": [] } }); writeFileSync(w.file, "  value = 1\r\n");
  await run(w.args("code-actions", ...(flag ? [flag, flag === "--symbol" ? "value" : "3"] : [])));
  const actionRange = object(w.events().find((e) => e.method === "textDocument/codeAction")?.params).range;
  expect(actionRange).toEqual(flag ? { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } } : { start: { line: 0, character: 0 }, end: { line: 0, character: 11 } });
});
test("code actions: delayed initial diagnostics reach the request context", async () => {
  const diagnostic = { range, message: "missing import", severity: 1 };
  const w = workspace({ diagnostics: [diagnostic], diagnosticDelay: 40, responses: { "textDocument/codeAction": [] } });
  await run(w.args("code-actions"));
  expect(object(object(w.events().find((e) => e.method === "textDocument/codeAction")?.params).context).diagnostics).toEqual([diagnostic]);
});
test("navigation: a verified empty hover is a not-found result", async () => {
  const w = workspace({ responses: { "textDocument/hover": null } });
  expect((await run(w.args("hover"))).data).toMatchObject({ success: true, found: false });
});
test("diagnostics: a shared deadline bounds pull failure and push fallback", async () => {
  const w = workspace({ capabilities: { diagnosticProvider: true }, diagnostics: false, stallMethods: ["textDocument/diagnostic"] });
  const client = await LspClient.start({ ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath }, 2000);
  try {
    await client.open(w.file);
    const wait = spyOn(client, "waitDiagnostics").mockRejectedValue(new Error("No push result"));
    const result = await client.getDiagnostics(w.uri, 80);
    expect(result).toEqual({ diagnostics: [], verified: false });
    expect(wait.mock.calls[0][1]).toBeLessThanOrEqual(5); wait.mockRestore();
    await client.request("fixture/echo", {});
    expect(w.events().some((e) => e.method === "$/cancelRequest")).toBe(true);
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
  expect(response.data).toMatchObject({ success: true, applied: false, results: {
    hover: { found: true, hover: "fixture value" }, definition: { found: true },
    references: { total: 2, shown: 1, truncated: true }, symbols: { total: 1 },
    diagnostics: { verified: true }, rename: { applied: false, total: 1 },
  } });
  const events = w.events();
  for (const method of ["initialize", "textDocument/didOpen", "shutdown", "textDocument/rename"])
    expect(events.filter((e) => e.method === method)).toHaveLength(1);
  expect(object(object(object(events.find((e) => e.method === "initialize")?.params).capabilities).workspace).applyEdit).toBe(false);
  expect(readFileSync(w.file, "utf8")).toBe(before);
});
test.each(["--apply", "--changed", "--workspace"])("inspect: rejects %s before server startup", async (flag) => {
  const w = workspace(), start = spyOn(LspClient, "start");
  try { await expect(run(w.args("inspect", flag))).rejects.toThrow("read-only"); expect(start).not.toHaveBeenCalled(); }
  finally { start.mockRestore(); }
});
test("inspect: unsupported capabilities are explicit and independent sections survive a server error", async () => {
  const w = workspace({ capabilities: { hoverProvider: true }, errors: { "textDocument/hover": { code: -32603, message: "hover failed" } } });
  const response = await run(w.args("inspect"));
  expect(response.code).toBe(1);
  expect(response.data).toMatchObject({ success: false, failedSections: ["hover"], results: {
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
  expect(object(object(response.data.results).diagnostics).verified).toBe(true);
  const reply = w.events().find((e) => e.direction === "receive" && e.id === "server-request");
  expect(object(reply?.result).applied).toBe(false);
  expect(readFileSync(w.file, "utf8")).toBe(before);
});
test("inspect: includes other configured diagnostic servers without restarting the navigation server", async () => {
  const w = workspace({ capabilities: inspectCapabilities, responses: { "textDocument/hover": { contents: "value" } } });
  w.configs.linter = { ...w.configs.fixture, isLinter: true }; w.saveConfig();
  expect((await run(w.args("inspect"))).data.success).toBe(true);
  expect(w.events().filter((e) => e.method === "initialize")).toHaveLength(2);
  expect(w.events().filter((e) => e.method === "textDocument/didOpen")).toHaveLength(2);
});
test("inspect: timed-out queries cancel and later sections still complete", async () => {
  const w = workspace({ capabilities: inspectCapabilities, stallMethods: ["textDocument/hover"] });
  const result = await run({ ...w.args("inspect"), timeout: 80 });
  expect(result.data).toMatchObject({ success: false, failedSections: ["hover"], results: { diagnostics: { verified: true } } });
  expect(w.events().some((e) => e.method === "$/cancelRequest")).toBe(true);
});
test("inspect: Rust compiler checks are enabled in its single server session", async () => {
  const w = workspace({ capabilities: {}, serverStatus: { quiescent: true, health: "ok" }, progress: [
    { token: "rustAnalyzer/check", value: { kind: "begin", title: "cargo check" } },
    { token: "rustAnalyzer/check", value: { kind: "end" } },
  ] });
  w.configs["rust-analyzer"] = { ...w.configs.fixture }; delete w.configs.fixture; w.saveConfig();
  expect((await run(w.args("inspect"))).data.success).toBe(true);
  const events = w.events(); expect(events.filter((e) => e.method === "initialize")).toHaveLength(1);
  const settings = object(object(events.find((e) => e.method === "workspace/didChangeConfiguration")?.params).settings);
  expect(object(settings["rust-analyzer"]).checkOnSave).toBe(true);
});
test("inspect: a concurrent source edit leaves diagnostics unverified and preserves the external edit", async () => {
  const w = workspace(); w.setScenario({ capabilities: { hoverProvider: true }, beforeResponse: { "textDocument/hover": { file: w.file, text: "external change\n" } }, responses: { "textDocument/hover": { contents: "old value" } } });
  const result = await run(w.args("inspect"));
  expect(result.data).toMatchObject({ success: false, failedSections: ["diagnostics"], results: { diagnostics: { verified: false } } });
  expect(readFileSync(w.file, "utf8")).toBe("external change\n");
});
