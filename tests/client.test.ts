import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspClient } from "../src/client.ts";
import { fileUri, type Server } from "../src/config.ts";

const roots: string[] = [];
function fixture(mode = "normal", name = "fixture") {
  const root = mkdtempSync(join(tmpdir(), "codex-lsp wire ")); roots.push(root);
  const trace = join(root, "wire.ndjson"); writeFileSync(trace, "");
  const server: Server = { name, root, command: process.execPath, resolvedCommand: process.execPath, args: [join(import.meta.dir, "fixtures/lsp-server.ts"), mode, trace], warmupTimeoutMs: 1000, settings: { python: { analysis: { typeCheckingMode: "strict" } } } };
  return { server, root, events: () => readFileSync(trace, "utf8").split("\n").slice(0, -1).filter(Boolean).map((s) => JSON.parse(s)) };
}
afterEach(async () => {
  await Promise.all([...LspClient.active].map((client) => client.close()));
  expect(LspClient.active.size).toBe(0);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("wire: fragmented Unicode responses and concurrent out-of-order IDs", async () => {
  const { server, events } = fixture("fragmented"), client = await LspClient.start(server, 1000);
  expect(await client.request("fixture/echo", { text: "中文😀" })).toEqual({ text: "中文😀" });
  const results = await Promise.all([client.request("fixture/reverse", { order: 1 }), client.request("fixture/reverse", { order: 2 })]);
  expect(results).toEqual([{ order: 1 }, { order: 2 }]);
  const reversed = events().filter((e) => e.direction === "send" && e.result?.order);
  expect(reversed.map((e) => e.result.order)).toEqual([2, 1]);
});
test("wire: server request IDs can collide with a pending client request", async () => {
  const { server, events } = fixture(), client = await LspClient.start(server, 1000);
  expect(await client.request("fixture/collision", {})).toBe("original response");
  await client.request("fixture/echo", {});
  const response = events().find((e) => e.direction === "receive" && !e.method && Array.isArray(e.result));
  expect(response.result).toEqual([{ typeCheckingMode: "strict" }]);
});
test("wire: timeout sends cancellation, ignores a late reply, and preserves the next request", async () => {
  const { server, events } = fixture(), client = await LspClient.start(server, 1000);
  await expect(client.request("fixture/late", {}, 20)).rejects.toThrow("timed out");
  expect(await client.request("fixture/echo", { next: true })).toEqual({ next: true });
  const trace = events(), request = trace.find((e) => e.direction === "receive" && e.method === "fixture/late");
  expect(trace.some((e) => e.direction === "receive" && e.method === "$/cancelRequest" && e.params.id === request.id)).toBe(true);
  expect(trace.some((e) => e.direction === "send" && e.id === request.id && e.result === "late response")).toBe(true);
});
test.each(["exit", "bad-json", "bad-length", ...(process.platform === "win32" ? [] : ["close-stdout"])])("wire: %s rejects every outstanding request and permits cleanup", async (fault) => {
  const { server } = fixture(), client = await LspClient.start(server, 1000);
  const results = await Promise.allSettled([client.request("fixture/stall", {}), client.request(`fixture/${fault}`, {})]);
  expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  for (const r of results) if (r.status === "rejected") expect(String(r.reason)).not.toContain("timed out");
  if (fault === "close-stdout") expect(() => process.kill(client.proc.pid, 0)).not.toThrow();
  await client.close();
  expect(() => process.kill(client.proc.pid, 0)).toThrow();
  await expect(client.request("fixture/echo", {})).rejects.toThrow();
});
test("wire: stderr bursts are drained and the error retains a bounded tail", async () => {
  const { server } = fixture(), client = await LspClient.start(server, 1000);
  await client.request("fixture/stderr", {});
  await Bun.sleep(20);
  const error = String(await client.request("fixture/exit", {}).catch((e) => String(e)));
  expect(error).toContain("fixture stderr tail");
  expect(error.length).toBeLessThan(8500);
});
test("lifecycle: failed initialization reaps the child and unregisters the client", async () => {
  const { server } = fixture("exit-init");
  await expect(LspClient.start(server, 1000)).rejects.toThrow("fixture initialization failed");
  expect(LspClient.active.size).toBe(0);
});
test("lifecycle: stalled initialization cancels and reaps the child", async () => {
  const { server, events } = fixture("stall-init"); server.warmupTimeoutMs = 150;
  await expect(LspClient.start(server, 150)).rejects.toThrow("initialize timed out");
  const trace = events(), pid = trace.find((e) => e.direction === "lifecycle").pid;
  expect(trace.some((e) => e.direction === "receive" && e.method === "$/cancelRequest")).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
  expect(LspClient.active.size).toBe(0);
});
test("lifecycle: a server ignoring shutdown and SIGTERM is forcibly reaped", async () => {
  const { server } = fixture("hang"), client = await LspClient.start(server, 1000);
  await client.close();
  expect(() => process.kill(client.proc.pid, 0)).toThrow();
  expect(LspClient.active.has(client)).toBe(false);
  await client.close();
});
test("lifecycle: concurrent closes await the same child cleanup", async () => {
  const { server } = fixture("hang"), client = await LspClient.start(server, 1000);
  const closing = client.close();
  try {
    expect(LspClient.active.has(client)).toBe(true);
    await client.close();
    expect(() => process.kill(client.proc.pid, 0)).toThrow();
  } finally { await closing; }
});
test.skipIf(process.platform === "win32")("CLI: SIGINT followed by SIGTERM still reaps a stubborn server", async () => {
  const { server, root, events } = fixture("hang"), file = join(root, "source.ts");
  mkdirSync(join(root, ".git")); mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, "fixture.project"), ""); writeFileSync(file, "const value = 1;\n");
  writeFileSync(join(root, ".codex/lsp.json"), JSON.stringify({ servers: { "typescript-language-server": { command: server.command, args: server.args, rootMarkers: ["fixture.project"] } } }));
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "request", "--file", file, "--method", "textDocument/hover", "--timeout", "5", "--json"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  let serverPid: number | undefined;
  let serverReaped = false;
  const waitFor = async (method: string) => {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const trace = events();
      serverPid ??= trace.find((e) => e.direction === "lifecycle")?.pid;
      if (trace.some((e) => e.direction === "receive" && e.method === method)) return;
      await Bun.sleep(5);
    }
    throw new Error(`Fixture did not receive ${method}`);
  };
  try {
    await waitFor("textDocument/hover"); proc.kill("SIGINT");
    await waitFor("shutdown"); proc.kill("SIGTERM");
    expect([130, 143]).toContain(await proc.exited);
    expect(serverPid).toBeNumber();
    expect(() => process.kill(serverPid!, 0)).toThrow();
    serverReaped = true;
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await proc.exited;
    if (serverPid && !serverReaped) { try { process.kill(serverPid, "SIGKILL"); } catch { /* Already reaped. */ } }
    await output;
  }
});
test("readiness: diagnostics for another URI never satisfy the target", async () => {
  const { server, root } = fixture(), client = await LspClient.start(server, 1000), uri = fileUri(join(root, "target.py"));
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri: uri + "-other", diagnostics: [] } });
  await expect(client.waitDiagnostics(uri, 50)).rejects.toThrow("file analysis");
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
  expect(await client.waitDiagnostics(uri)).toEqual([]);
});
test("readiness: unhealthy ready workspaces report the server reason", async () => {
  const { server } = fixture(), client = await LspClient.start(server, 1000);
  await client.request("fixture/notification", { method: "experimental/serverStatus", params: { quiescent: true, health: "error", message: "Cargo metadata failed" } });
  await expect(client.waitWorkspace()).rejects.toThrow("Cargo metadata failed");
});
test.each(["pull-malformed", "pull-missing"])("diagnostics: %s cannot be reported as verified", async (mode) => {
  const { server, root } = fixture(mode), client = await LspClient.start(server, 1000), uri = fileUri(join(root, "source.ts"));
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
  expect(await client.getDiagnostics(uri, 50)).toEqual({ diagnostics: [], verified: false });
});
test("diagnostics: malformed push diagnostics cannot establish readiness", async () => {
  const { server, root } = fixture(), client = await LspClient.start(server, 1000), uri = fileUri(join(root, "source.ts"));
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [null] } });
  expect(await client.getDiagnostics(uri, 50)).toEqual({ diagnostics: [], verified: false });
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [null] } });
  expect(await client.getDiagnostics(uri, 50)).toEqual({ diagnostics: [], verified: false });
});
test.each([
  { message: "missing range" },
  { message: "backwards range", range: { start: { line: 1, character: 2 }, end: { line: 0, character: 0 } } },
  { message: "invalid severity", severity: 99, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
])("diagnostics: reject malformed diagnostic fields %#", async (diagnostic) => {
  const { server, root } = fixture(), client = await LspClient.start(server, 1000), uri = fileUri(join(root, "source.ts"));
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [diagnostic] } });
  expect(await client.getDiagnostics(uri, 50)).toEqual({ diagnostics: [], verified: false });
});
test("diagnostics: retain valid errors including omitted optional severity", async () => {
  const { server, root } = fixture(), client = await LspClient.start(server, 1000), uri = fileUri(join(root, "source.ts"));
  const diagnostic = { message: "type error", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [diagnostic] } });
  expect(await client.getDiagnostics(uri)).toEqual({ diagnostics: [diagnostic], verified: true });
});
test("diagnostics: valid empty pull reports are verified", async () => {
  const { server, root } = fixture("pull-valid"), client = await LspClient.start(server, 1000);
  expect(await client.getDiagnostics(fileUri(join(root, "source.ts")))).toEqual({ diagnostics: [], verified: true });
});
test("diagnostics: unsupported pull requests fall back to published diagnostics", async () => {
  const { server, root } = fixture("pull-throws"), client = await LspClient.start(server, 1000), uri = fileUri(join(root, "source.ts"));
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
  expect(await client.getDiagnostics(uri)).toEqual({ diagnostics: [], verified: true });
});
test("wire: read-only workspace/applyEdit callbacks are refused", async () => {
  const { server, events } = fixture(), client = await LspClient.start(server, 1000);
  await client.request("fixture/callback", { method: "workspace/applyEdit", params: { edit: { changes: {} } } });
  const response = events().find((e) => e.direction === "receive" && e.id === "server-request" && !e.method);
  expect(response.result.applied).toBe(false);
});
test.each([false, true])("wire: authorized applyEdit callback reports its failure=%s", async (fails) => {
  const { server } = fixture(), client = await LspClient.start(server, 1000, true);
  let calls = 0;
  client.applyEdit = async () => { calls++; if (fails) throw new Error("injected edit failure"); };
  const reply = await client.request<{ result: { applied: boolean; failureReason?: string } }>("fixture/callback", { method: "workspace/applyEdit", params: { edit: { changes: {} } } });
  expect(calls).toBe(1); expect(reply.result.applied).toBe(!fails);
  if (fails) expect(reply.result.failureReason).toContain("injected edit failure");
});
test("wire: unknown client methods receive JSON-RPC MethodNotFound", async () => {
  const { server } = fixture(), client = await LspClient.start(server, 1000);
  const reply = await client.request<{ error: { code: number } }>("fixture/callback", { method: "unknown/clientMethod", params: {} });
  expect(reply.error.code).toBe(-32601);
});

test("readiness: malformed Rust status cannot satisfy a workspace wait", async () => {
  const { server } = fixture(), client = await LspClient.start(server, 1000);
  await client.request("fixture/notification", { method: "experimental/serverStatus", params: { quiescent: "true", health: "ok" } });
  await expect(client.waitWorkspace(50)).rejects.toThrow("workspace analysis");
});
test.each(["running", "finished", "unrelated"])("Rust diagnostics: %s check progress controls verification", async (state) => {
  const { server, root } = fixture("normal", "rust-analyzer"), client = await LspClient.start(server, 1000), uri = fileUri(join(root, "source.rs"));
  const notify = (method: string, params: unknown) => client.request("fixture/notification", { method, params });
  await notify("experimental/serverStatus", { quiescent: true, health: "ok" });
  await notify("textDocument/publishDiagnostics", { uri, diagnostics: [] });
  const token = state === "unrelated" ? "other/check" : "rustAnalyzer/checkOnSave/0";
  await notify("$/progress", { token, value: { kind: "begin" } });
  if (state !== "running") await notify("$/progress", { token, value: { kind: "end" } });
  expect(await client.getDiagnostics(uri, 160)).toEqual({ diagnostics: [], verified: state === "finished" });
});
test("diagnostics: cached reports from an exited server cannot remain verified", async () => {
  const { server, root } = fixture(), client = await LspClient.start(server, 1000), uri = fileUri(join(root, "source.ts"));
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
  await expect(client.request("fixture/exit", {})).rejects.toThrow();
  expect(await client.getDiagnostics(uri, 50)).toEqual({ diagnostics: [], verified: false });
});
test("wire: configuration sections and workspace folder callbacks preserve values", async () => {
  const { server } = fixture(), client = await LspClient.start(server, 1000);
  const config = await client.request<{ result: unknown }>("fixture/callback", { method: "workspace/configuration", params: { items: [{ section: "python.analysis.typeCheckingMode" }, { section: "missing" }, {}] } });
  expect(config.result).toEqual(["strict", null, server.settings]);
  const folders = await client.request<{ result: unknown }>("fixture/callback", { method: "workspace/workspaceFolders" });
  expect(folders.result).toEqual([{ uri: fileUri(server.root), name: server.root.split(/[\\/]/).at(-1) }]);
});
test("wire: dynamic diagnostics registration is honored and benign callbacks are acknowledged", async () => {
  const { server } = fixture(), client = await LspClient.start(server, 1000);
  await client.request("fixture/callback", { method: "client/registerCapability", params: { registrations: [{ method: "textDocument/diagnostic", registerOptions: { interFileDependencies: true } }] } });
  expect(client.capabilities.diagnosticProvider).toEqual({ interFileDependencies: true });
  for (const method of ["client/unregisterCapability", "window/workDoneProgress/create", "workspace/diagnostic/refresh"]) {
    const response = await client.request<{ result: unknown }>("fixture/callback", { method });
    expect(response.result).toBeNull();
  }
});
