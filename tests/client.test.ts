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
import { fileUri, MAX_FILE_BYTES, MAX_FILES, type Server } from "../src/config.ts";

const roots: string[] = [];
function fixture(mode = "normal", name = "fixture") {
  const root = mkdtempSync(join(tmpdir(), "codex-lsp wire ")); roots.push(root);
  const trace = join(root, "wire.ndjson"); writeFileSync(trace, "");
  const server: Server = { name, root, command: process.execPath, resolvedCommand: process.execPath, args: [join(dirname(fileURLToPath(import.meta.url)), "fixtures/lsp-server.js"), mode, trace], warmupTimeoutMs: 1000, settings: { python: { analysis: { typeCheckingMode: "strict" } } } };
  return { server, root, events: () => readFileSync(trace, "utf8").split("\n").slice(0, -1).filter(Boolean).map((s) => JSON.parse(s)) };
}
function diagnosticFixture(mode: "large" | "aggregate" | "burst" | "deep") {
  const value = fixture(), file = join(value.root, "diagnostics.mjs");
  writeFileSync(file, `import { MessageFramer, encodeMessageFrame } from ${JSON.stringify(new URL("../src/omp/message-framing.js", import.meta.url).href)};
const framer = new MessageFramer(Buffer.alloc(0)); let calls = 0;
const send = message => process.stdout.write(encodeMessageFrame(message));
for await (const chunk of process.stdin) {
 framer.push(chunk);
 for (const text of framer.drain(() => {})) {
  const message = JSON.parse(text), reply = result => send({ id: message.id, result });
  if (message.method === "initialize") reply({ capabilities: { diagnosticProvider: true } });
  else if (message.method === "fixture/notification") { send({ method: message.params.method, params: message.params.params }); reply(true); }
  else if (message.method === "textDocument/diagnostic") {
   calls++;
   if (${JSON.stringify(mode)} === "deep" && calls === 1) {
    const data = "[".repeat(20000) + "0" + "]".repeat(20000);
    const raw = '{"id":' + JSON.stringify(message.id) + ',"result":{"kind":"full","items":[{"message":"deep","range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}},"data":' + data + '}]}}';
    process.stdout.write('Content-Length: ' + Buffer.byteLength(raw) + '\\r\\n\\r\\n' + raw); continue;
   }
   if (${JSON.stringify(mode)} === "burst" && calls === 1) {
    for (let index = 0; index <= ${MAX_FILES}; index++) send({ method: "textDocument/publishDiagnostics", params: { uri: "file:///burst/" + index, diagnostics: [] } });
    send({ method: "textDocument/publishDiagnostics", params: { uri: message.params.textDocument.uri, diagnostics: [] } });
   }
   const large = ${JSON.stringify(mode)} === "aggregate" || ${JSON.stringify(mode)} === "large" && calls === 1;
   reply({ kind: "full", items: large ? [{ message: "中".repeat(${JSON.stringify(mode)} === "aggregate" ? 3 * 1024 * 1024 : Math.ceil(${MAX_FILE_BYTES} / 3)), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] : [] });
  } else if (message.method === "shutdown") reply(null);
  else if (message.method === "exit") process.exit(0);
 }
}
`);
  value.server.args = [file]; return value;
}
afterEach(async () => {
  await Promise.all([...LspClient.active].map((client) => client.close()));
  assert.strictEqual(LspClient.active.size, 0);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("wire: a TypeScript rename UI request is acknowledged read-only without changing source or suggesting an edit", async () => {
  const { server, root } = fixture(), file = join(root, "source.ts"); writeFileSync(file, "const value = 1;\n");
  const client = await LspClient.start(server, 1000); await client.open(file);
  const response = await client.request<{ result?: unknown; error?: unknown }>("fixture/callback", { method: "_typescript.rename", params: { textDocument: { uri: fileUri(file) }, position: { line: 0, character: 6 } } });
  assert.equal(response.error, undefined); assert.equal(response.result, null);
  assert.equal((client as LspClient & { renameTarget?: unknown }).renameTarget, undefined);
  assert.equal(readFileSync(file, "utf8"), "const value = 1;\n"); await client.close();
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
test("diagnostic bounds: native workspace push URI overflow is unverified until a fresh valid report", async () => {
  const { server, root } = fixture(), client = await LspClient.start(server, 2000), file = join(root, "target.ts");
  writeFileSync(file, "const value = 1;\n"); const { uri } = await client.open(file);
  const push = (params: unknown) => client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params });
  for (let index = 0; index < MAX_FILES; index++) await push({ uri: uri + index, diagnostics: [] });
  assert.equal(client.diagnostics.size, MAX_FILES);
  await push({ uri: uri + "0", diagnostics: [] }); assert.equal(client.diagnostics.size, MAX_FILES);
  await push({ uri: uri + "overflow", diagnostics: [] }); assert.equal(client.diagnostics.size, 0);
  await assert.rejects(client.waitDiagnostics(uri, 50), /200 URI\/16 MiB/);
  assert.deepEqual(await client.getDiagnostics(uri, 50), { diagnostics: [], verified: false });
  for (const params of [{ uri, diagnostics: [null] }, { uri, version: -1, diagnostics: [] }, { uri, version: 0, diagnostics: [] }]) {
    await push(params); assert.deepEqual(await client.getDiagnostics(uri, 50), { diagnostics: [], verified: false });
  }
  await push({ uri, version: 1, diagnostics: [] }); assert.deepEqual(await client.getDiagnostics(uri), { diagnostics: [], verified: true });
  client.diagnostics.clear(); assert.deepEqual(await client.getDiagnostics(uri, 30), { diagnostics: [], verified: false });
  await push({ uri, diagnostics: [] }); assert.deepEqual(await client.getDiagnostics(uri), { diagnostics: [], verified: true });
});
test("diagnostic bounds: aggregate native push bytes honor public cache deletions and recover without restarting", async () => {
  const { server, root } = fixture(), client = await LspClient.start(server, 6000), uri = fileUri(join(root, "target.ts"));
  const item = { message: "中".repeat(Math.floor(MAX_FILE_BYTES / 6)), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
  const push = (target: string, diagnostics: unknown[]) => client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri: target, diagnostics } });
  await push(uri + "-first", [item]); assert.equal(client.diagnostics.size, 1);
  client.diagnostics.delete(uri + "-first");
  await push(uri + "-second", [item]); assert.equal(client.diagnostics.size, 1);
  assert.equal((await client.getDiagnostics(uri + "-second")).verified, true);
  await push(uri, [item]); assert.equal(client.diagnostics.size, 0);
  assert.deepEqual(await client.getDiagnostics(uri, 50), { diagnostics: [], verified: false });
  await push(uri, []); assert.deepEqual(await client.getDiagnostics(uri), { diagnostics: [], verified: true });
  assert.equal(client.reusable, true); assert.equal(client.diagnostics.size, 1);
});
test("diagnostic bounds: an oversized native pull report is unverified and a later small report recovers", async () => {
  const { server, root } = diagnosticFixture("large"), client = await LspClient.start(server, 6000), uri = fileUri(join(root, "target.ts"));
  assert.deepEqual(await client.getDiagnostics(uri), { diagnostics: [], verified: false }); assert.equal(client.diagnostics.size, 0);
  assert.deepEqual(await client.getDiagnostics(uri), { diagnostics: [], verified: true }); assert.equal(client.reusable, true);
});
test("diagnostic bounds: native pull results share the aggregate cache cap with published reports", async () => {
  const { server, root } = diagnosticFixture("aggregate"), client = await LspClient.start(server, 6000), uri = fileUri(join(root, "target.ts"));
  const item = { message: "中".repeat(3 * 1024 * 1024), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri: uri + "-other", diagnostics: [item] } });
  assert.deepEqual(await client.getDiagnostics(uri), { diagnostics: [], verified: false }); assert.equal(client.diagnostics.size, 0);
  const recovered = await client.getDiagnostics(uri); assert.equal(recovered.verified, true); assert.equal(recovered.diagnostics.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify([...client.diagnostics])) <= MAX_FILE_BYTES);
});
test("diagnostic bounds: a query spanning overflow and a fresh push/pull remains unverified once", async () => {
  const { server, root } = diagnosticFixture("burst"), client = await LspClient.start(server, 2000), uri = fileUri(join(root, "target.ts"));
  assert.deepEqual(await client.getDiagnostics(uri), { diagnostics: [], verified: false });
  assert.deepEqual(await client.getDiagnostics(uri), { diagnostics: [], verified: true }); assert.equal(client.diagnostics.size, 1);
});
test("diagnostic bounds: deep native metadata respects serializer limits without poisoning later reports", async () => {
  const { server, root } = diagnosticFixture("deep"), client = await LspClient.start(server, 2000), uri = fileUri(join(root, "target.ts"));
  const first = await client.getDiagnostics(uri);
  assert.deepEqual(first.diagnostics.map(item => item.message), first.verified ? ["deep"] : []); assert.equal(client.reusable, true);
  assert.equal(client.diagnostics.has(uri), first.verified);
  assert.deepEqual(await client.getDiagnostics(uri), { diagnostics: [], verified: true });
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
