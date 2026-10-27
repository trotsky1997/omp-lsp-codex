import { setTimeout as delay } from "node:timers/promises";
import childProcess from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspClient } from "../src/client.ts";
import { fileUri, type Server } from "../src/config.ts";

const roots: string[] = [];
function fixture(mode = "normal", name = "fixture") {
  const root = mkdtempSync(join(tmpdir(), "codex-lsp wire ")); roots.push(root);
  const trace = join(root, "wire.ndjson"); writeFileSync(trace, "");
  const server: Server = { name, root, command: process.execPath, resolvedCommand: process.execPath, args: [join(dirname(fileURLToPath(import.meta.url)), "fixtures/lsp-server.js"), mode, trace], warmupTimeoutMs: 1000, settings: { python: { analysis: { typeCheckingMode: "strict" } } } };
  return { server, root, events: () => readFileSync(trace, "utf8").split("\n").slice(0, -1).filter(Boolean).map((s) => JSON.parse(s)) };
}
afterEach(async () => {
  await Promise.all([...LspClient.active].map((client) => client.close()));
  assert.strictEqual(LspClient.active.size, 0);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("wire: fragmented Unicode responses and concurrent out-of-order IDs", async () => {
  const { server, events } = fixture("fragmented"), client = await LspClient.start(server, 1000);
  assert.deepStrictEqual(await client.request("fixture/echo", { text: "中文😀" }), { text: "中文😀" });
  const results = await Promise.all([client.request("fixture/reverse", { order: 1 }), client.request("fixture/reverse", { order: 2 })]);
  assert.deepStrictEqual(results, [{ order: 1 }, { order: 2 }]);
  const reversed = events().filter((e) => e.direction === "send" && e.result?.order);
  assert.deepStrictEqual(reversed.map((e) => e.result.order), [2, 1]);
});
test("wire: server request IDs can collide with a pending client request", async () => {
  const { server, events } = fixture(), client = await LspClient.start(server, 1000);
  assert.strictEqual(await client.request("fixture/collision", {}), "original response");
  await client.request("fixture/echo", {});
  const response = events().find((e) => e.direction === "receive" && !e.method && Array.isArray(e.result));
  assert.deepStrictEqual(response.result, [{ typeCheckingMode: "strict" }]);
});
test("wire: timeout sends cancellation, ignores a late reply, and preserves the next request", async () => {
  const { server, events } = fixture(), client = await LspClient.start(server, 1000);
  await assert.rejects(client.request("fixture/late", {}, 20), (error) => error instanceof Error && error.message.includes(String("timed out")));
  assert.deepStrictEqual(await client.request("fixture/echo", { next: true }), { next: true });
  const trace = events(), request = trace.find((e) => e.direction === "receive" && e.method === "fixture/late");
  assert.strictEqual(trace.some((e) => e.direction === "receive" && e.method === "$/cancelRequest" && e.params.id === request.id), true);
  assert.strictEqual(trace.some((e) => e.direction === "send" && e.id === request.id && e.result === "late response"), true);
});
for (const [caseIndex, caseValue] of (["exit", "bad-json", "bad-length", "bad-utf8", ...(process.platform === "win32" ? [] : ["close-stdout"])]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (fault) => {
  const { server } = fixture(), client = await LspClient.start(server, 1000);
  const results = await Promise.allSettled([client.request("fixture/stall", {}), client.request(`fixture/${fault}`, {})]);
  assert.deepStrictEqual(results.map((r) => r.status), ["rejected", "rejected"]);
  for (const r of results) if (r.status === "rejected") assert.ok(!(String(r.reason)).includes("timed out"));
  if (fault === "close-stdout") assert.doesNotThrow(() => process.kill(client.proc.pid!, 0));
  await client.close();
  assert.throws(() => process.kill(client.proc.pid!, 0));
  await assert.rejects(client.request("fixture/echo", {}));
};
  test("wire: %s rejects every outstanding request and permits cleanup".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("wire: stderr bursts are drained and the error retains a bounded tail", async () => {
  const { server } = fixture(), client = await LspClient.start(server, 1000);
  await client.request("fixture/stderr", {});
  await delay(20);
  const error = String(await client.request("fixture/exit", {}).catch((e) => String(e)));
  assert.ok((error).includes("fixture stderr tail"));
  assert.ok(error.length < 8500);
});
test("lifecycle: failed initialization reaps the child and unregisters the client", async () => {
  const { server } = fixture("exit-init");
  await assert.rejects(LspClient.start(server, 1000), (error) => error instanceof Error && error.message.includes(String("fixture initialization failed")));
  assert.strictEqual(LspClient.active.size, 0);
});
test("lifecycle: stalled initialization cancels and reaps the child", async () => {
  const { server, events } = fixture("stall-init"); server.warmupTimeoutMs = 150;
  await assert.rejects(LspClient.start(server, 150), (error) => error instanceof Error && error.message.includes(String("initialize timed out")));
  const trace = events(), pid = trace.find((e) => e.direction === "lifecycle").pid;
  assert.strictEqual(trace.some((e) => e.direction === "receive" && e.method === "$/cancelRequest"), true);
  assert.throws(() => process.kill(pid, 0));
  assert.strictEqual(LspClient.active.size, 0);
});
test("lifecycle: a server ignoring shutdown and SIGTERM is forcibly reaped", async () => {
  const { server } = fixture("hang"), client = await LspClient.start(server, 1000);
  await client.close();
  assert.throws(() => process.kill(client.proc.pid!, 0));
  assert.strictEqual(LspClient.active.has(client), false);
  await client.close();
});
test("lifecycle: concurrent closes await the same child cleanup", async () => {
  const { server } = fixture("hang"), client = await LspClient.start(server, 1000);
  const closing = client.close();
  try {
    assert.strictEqual(LspClient.active.has(client), true);
    await client.close();
    assert.throws(() => process.kill(client.proc.pid!, 0));
  } finally { await closing; }
});
test("CLI: SIGINT followed by SIGTERM still reaps a stubborn server", { skip: process.platform === "win32" }, async () => {
  const { server, root, events } = fixture("hang"), file = join(root, "source.ts");
  mkdirSync(join(root, ".git")); mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, "fixture.project"), ""); writeFileSync(file, "const value = 1;\n");
  writeFileSync(join(root, ".codex/lsp.json"), JSON.stringify({ servers: { "typescript-language-server": { command: server.command, args: server.args, rootMarkers: ["fixture.project"] } } }));
  const proc = childProcess.spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "../src/cli.js"), "request", "--file", file, "--method", "textDocument/hover", "--timeout", "5", "--json"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  proc.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  proc.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const closed = new Promise<number>((resolve, reject) => proc.once("close", code => code === null ? reject(new Error("CLI closed without an exit code")) : resolve(code)));
  let serverPid: number | undefined;
  let serverReaped = false;
  const waitFor = async (method: string) => {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const trace = events();
      serverPid ??= trace.find((e) => e.direction === "lifecycle")?.pid;
      if (trace.some((e) => e.direction === "receive" && e.method === method)) return;
      await delay(5);
    }
    throw new Error(`Fixture did not receive ${method}`);
  };
  try {
    await waitFor("textDocument/hover"); proc.kill("SIGINT");
    await waitFor("shutdown"); proc.kill("SIGTERM");
    const exit = await closed;
    assert.ok(([130, 143]).includes(exit));
    assert.strictEqual(typeof (serverPid), "number");
    assert.throws(() => process.kill(serverPid!, 0));
    serverReaped = true;
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await closed.catch(() => undefined);
    if (serverPid && !serverReaped) { try { process.kill(serverPid, "SIGKILL"); } catch { /* Already reaped. */ } }
    assert.strictEqual(stderr, "");
  }
});
test("readiness: diagnostics for another URI never satisfy the target", async () => {
  const { server, root } = fixture(), client = await LspClient.start(server, 1000), uri = fileUri(join(root, "target.py"));
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri: uri + "-other", diagnostics: [] } });
  await assert.rejects(client.waitDiagnostics(uri, 50), (error) => error instanceof Error && error.message.includes(String("file analysis")));
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
  assert.deepStrictEqual(await client.waitDiagnostics(uri), []);
});
test("readiness: unhealthy ready workspaces report the server reason", async () => {
  const { server } = fixture(), client = await LspClient.start(server, 1000);
  await client.request("fixture/notification", { method: "experimental/serverStatus", params: { quiescent: true, health: "error", message: "Cargo metadata failed" } });
  await assert.rejects(client.waitWorkspace(), (error) => error instanceof Error && error.message.includes(String("Cargo metadata failed")));
});
for (const [caseIndex, caseValue] of (["pull-malformed", "pull-missing"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (mode) => {
  const { server, root } = fixture(mode), client = await LspClient.start(server, 1000), uri = fileUri(join(root, "source.ts"));
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
  assert.deepStrictEqual(await client.getDiagnostics(uri, 50), { diagnostics: [], verified: false });
};
  test("diagnostics: %s cannot be reported as verified".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("diagnostics: malformed push diagnostics cannot establish readiness", async () => {
  const { server, root } = fixture(), client = await LspClient.start(server, 1000), uri = fileUri(join(root, "source.ts"));
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [null] } });
  assert.deepStrictEqual(await client.getDiagnostics(uri, 50), { diagnostics: [], verified: false });
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [null] } });
  assert.deepStrictEqual(await client.getDiagnostics(uri, 50), { diagnostics: [], verified: false });
});
for (const [caseIndex, caseValue] of ([
  { message: "missing range" },
  { message: "backwards range", range: { start: { line: 1, character: 2 }, end: { line: 0, character: 0 } } },
  { message: "invalid severity", severity: 99, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (diagnostic) => {
  const { server, root } = fixture(), client = await LspClient.start(server, 1000), uri = fileUri(join(root, "source.ts"));
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [diagnostic] } });
  assert.deepStrictEqual(await client.getDiagnostics(uri, 50), { diagnostics: [], verified: false });
};
  test("diagnostics: reject malformed diagnostic fields %#".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("diagnostics: retain valid errors including omitted optional severity", async () => {
  const { server, root } = fixture(), client = await LspClient.start(server, 1000), uri = fileUri(join(root, "source.ts"));
  const diagnostic = { message: "type error", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [diagnostic] } });
  assert.deepStrictEqual(await client.getDiagnostics(uri), { diagnostics: [diagnostic], verified: true });
});
test("diagnostics: valid empty pull reports are verified", async () => {
  const { server, root } = fixture("pull-valid"), client = await LspClient.start(server, 1000);
  assert.deepStrictEqual(await client.getDiagnostics(fileUri(join(root, "source.ts"))), { diagnostics: [], verified: true });
});
test("diagnostics: unsupported pull requests fall back to published diagnostics", async () => {
  const { server, root } = fixture("pull-throws"), client = await LspClient.start(server, 1000), uri = fileUri(join(root, "source.ts"));
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
  assert.deepStrictEqual(await client.getDiagnostics(uri), { diagnostics: [], verified: true });
});
test("wire: read-only workspace/applyEdit callbacks are refused", async () => {
  const { server, events } = fixture(), client = await LspClient.start(server, 1000);
  await client.request("fixture/callback", { method: "workspace/applyEdit", params: { edit: { changes: {} } } });
  const response = events().find((e) => e.direction === "receive" && e.id === "server-request" && !e.method);
  assert.strictEqual(response.result.applied, false);
});
for (const [caseIndex, caseValue] of ([false, true]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (fails) => {
  const { server } = fixture(), client = await LspClient.start(server, 1000, true);
  let calls = 0;
  client.applyEdit = async () => { calls++; if (fails) throw new Error("injected edit failure"); };
  const reply = await client.request<{ result: { applied: boolean; failureReason?: string } }>("fixture/callback", { method: "workspace/applyEdit", params: { edit: { changes: {} } } });
  assert.strictEqual(calls, 1); assert.strictEqual(reply.result.applied, !fails);
  if (fails) assert.ok(String(reply.result.failureReason).includes("injected edit failure"));
};
  test("wire: authorized applyEdit callback reports its failure=%s".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("wire: unknown client methods receive JSON-RPC MethodNotFound", async () => {
  const { server } = fixture(), client = await LspClient.start(server, 1000);
  const reply = await client.request<{ error: { code: number } }>("fixture/callback", { method: "unknown/clientMethod", params: {} });
  assert.strictEqual(reply.error.code, -32601);
});

test("readiness: malformed Rust status cannot satisfy a workspace wait", async () => {
  const { server } = fixture(), client = await LspClient.start(server, 1000);
  await client.request("fixture/notification", { method: "experimental/serverStatus", params: { quiescent: "true", health: "ok" } });
  await assert.rejects(client.waitWorkspace(50), (error) => error instanceof Error && error.message.includes(String("workspace analysis")));
});
test("readiness: Rust timeouts retain server status and Cargo recovery guidance", async () => {
  const { server } = fixture("normal", "rust-analyzer"), client = await LspClient.start(server, 1000);
  await client.request("fixture/notification", { method: "experimental/serverStatus", params: { quiescent: false, health: "warning", message: "Cargo metadata cannot resolve dependencies" } });
  await assert.rejects(client.waitWorkspace(20), error => error instanceof Error && /Cargo metadata cannot resolve dependencies/.test(error.message) && /cargo metadata --locked --format-version 1/.test(error.message));
});
for (const [caseIndex, caseValue] of (["running", "finished", "unrelated"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (state) => {
  const { server, root } = fixture("normal", "rust-analyzer"), client = await LspClient.start(server, 1000), uri = fileUri(join(root, "source.rs"));
  const notify = (method: string, params: unknown) => client.request("fixture/notification", { method, params });
  await notify("experimental/serverStatus", { quiescent: true, health: "ok" });
  await notify("textDocument/publishDiagnostics", { uri, diagnostics: [] });
  const token = state === "unrelated" ? "other/check" : "rustAnalyzer/checkOnSave/0";
  await notify("$/progress", { token, value: { kind: "begin" } });
  if (state !== "running") await notify("$/progress", { token, value: { kind: "end" } });
  assert.deepStrictEqual(await client.getDiagnostics(uri, 160), { diagnostics: [], verified: state === "finished" });
};
  test("Rust diagnostics: %s check progress controls verification".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("diagnostics: cached reports from an exited server cannot remain verified", async () => {
  const { server, root } = fixture(), client = await LspClient.start(server, 1000), uri = fileUri(join(root, "source.ts"));
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
  await assert.rejects(client.request("fixture/exit", {}));
  assert.deepStrictEqual(await client.getDiagnostics(uri, 50), { diagnostics: [], verified: false });
});
test("wire: configuration sections and workspace folder callbacks preserve values", async () => {
  const { server } = fixture(), client = await LspClient.start(server, 1000);
  const config = await client.request<{ result: unknown }>("fixture/callback", { method: "workspace/configuration", params: { items: [{ section: "python.analysis.typeCheckingMode" }, { section: "missing" }, {}] } });
  assert.deepStrictEqual(config.result, ["strict", null, server.settings]);
  const folders = await client.request<{ result: unknown }>("fixture/callback", { method: "workspace/workspaceFolders" });
  assert.deepStrictEqual(folders.result, [{ uri: fileUri(server.root), name: server.root.split(/[\\/]/).at(-1) }]);
});
test("wire: dynamic diagnostics registration is honored and benign callbacks are acknowledged", async () => {
  const { server } = fixture(), client = await LspClient.start(server, 1000);
  await client.request("fixture/callback", { method: "client/registerCapability", params: { registrations: [{ method: "textDocument/diagnostic", registerOptions: { interFileDependencies: true } }] } });
  assert.deepStrictEqual(client.capabilities.diagnosticProvider, { interFileDependencies: true });
  for (const method of ["client/unregisterCapability", "window/workDoneProgress/create", "workspace/diagnostic/refresh"]) {
    const response = await client.request<{ result: unknown }>("fixture/callback", { method });
    assert.strictEqual(response.result, null);
  }
});
