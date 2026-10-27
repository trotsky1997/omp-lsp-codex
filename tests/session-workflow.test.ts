import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { parseOptions } from "../src/cli.ts";
import { queryOptions } from "../src/batch.ts";
import { sessionLines } from "../src/session.ts";
import { object, MAX_FILE_BYTES } from "../src/config.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); }); after(() => restore());
const children = new Set<ReturnType<typeof spawn>>();
afterEach(() => { for (const child of children) child.kill("SIGKILL"); children.clear(); cleanWorkspaces(); });
const cli = join(dirname(fileURLToPath(import.meta.url)), "../src/cli.js");
const capabilities = { hoverProvider: true, definitionProvider: true, referencesProvider: true, documentSymbolProvider: true, textDocumentSync: 2 };
const responses = { "textDocument/hover": { contents: "value" }, "textDocument/documentSymbol": [] };

function launch(w: ReturnType<typeof workspace>, flags: string[] = []) {
  const child = spawn(process.execPath, [cli, "session", "--stdio", ...flags], { cwd: w.root, stdio: ["pipe", "pipe", "pipe"] });
  children.add(child); let pending = "", stderr = "";
  const messages: Record<string, unknown>[] = [], waiters: ((row: Record<string, unknown>) => void)[] = [];
  child.stdout!.on("data", chunk => {
    pending += String(chunk); let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const row = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
      const waiter = waiters.shift(); if (waiter) waiter(row); else messages.push(row);
    }
  });
  child.stderr!.on("data", chunk => { stderr += String(chunk); });
  const exited = new Promise<number | null>(resolve => child.once("exit", code => { children.delete(child); resolve(code); }));
  const next = () => messages.length ? Promise.resolve(messages.shift()!) : new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No session reply: ${stderr}`)), 9000);
    waiters.push(row => { clearTimeout(timer); resolve(row); });
  });
  return { child, exited, next, request: (row: unknown) => { child.stdin!.write(JSON.stringify(row) + "\n"); return next(); } };
}
function query(w: ReturnType<typeof workspace>, args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args, "--json"], { cwd: w.root, encoding: "utf8", timeout: 10000 });
  assert.equal(result.error, undefined); return { code: result.status, data: JSON.parse(result.stdout) as Record<string, unknown> };
}
function reaped(w: ReturnType<typeof workspace>) {
  for (const event of w.events().filter(event => event.direction === "lifecycle")) assert.throws(() => process.kill(Number(event.pid), 0));
}

test("session: replies before EOF, accepts dependent queries, reuses one server and closes on request", async () => {
  const w = workspace({ capabilities, responses }), session = launch(w);
  const first = await session.request({ id: "first", command: "hover", file: w.file });
  assert.equal(first.id, "first"); assert.equal(first.found, true); assert.equal(session.child.exitCode, null);
  assert.equal(typeof first.elapsedMs, "number"); assert.ok(Number(first.elapsedMs) >= 0);
  const second = await session.request({ id: 2, command: first.found ? "definition" : "symbols", file: w.file });
  assert.equal(second.code, 0); assert.equal(second.id, 2);
  assert.equal((await session.request({ command: "close" })).closed, true);
  assert.equal(await session.exited, 0);
  assert.equal(w.events().filter(event => event.method === "initialize").length, 1);
  assert.equal(w.events().filter(event => event.method === "shutdown").length, 1); reaped(w);
});

test("session: malformed or mutating rows preserve later queries and the process remains read-only", async () => {
  const w = workspace({ capabilities, responses }), session = launch(w);
  session.child.stdin!.write("{\n"); assert.equal((await session.next()).code, 2);
  assert.equal((await session.request({ command: "hover", file: w.file, apply: true })).code, 2);
  assert.equal((await session.request({ command: "hover", file: w.file })).found, true);
  await session.request({ command: "close" }); assert.equal(await session.exited, 1);
  const init = w.events().find(event => event.method === "initialize");
  assert.equal(object(object(object(init?.params).capabilities).workspace).applyEdit, false);
  assert.equal(readFileSync(w.file, "utf8"), "value = 1\n"); reaped(w);
});

test("session: external edits synchronize incrementally with new versions without writing source or restarting", async () => {
  const w = workspace({ capabilities, responses, diagnosticVersionFromDocument: true }), session = launch(w);
  await session.request({ command: "hover", file: w.file });
  writeFileSync(w.file, "value = 2\r\n");
  const response = await session.request({ command: "diagnostics", file: w.file });
  assert.equal(response.verified, true); assert.equal(response.refreshedDocuments, 1);
  await session.request({ command: "close" }); assert.equal(await session.exited, 0);
  const events = w.events(), change = object(events.find(event => event.method === "textDocument/didChange")?.params);
  assert.equal(object(change.textDocument).version, 2);
  assert.deepEqual(change.contentChanges, [{ range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, text: "value = 2\r\n" }]);
  assert.equal(events.filter(event => event.method === "initialize").length, 1);
  assert.equal(readFileSync(w.file, "utf8"), "value = 2\r\n"); reaped(w);
});

test("session: changes during a query discard the stale result and the next current query recovers", async () => {
  const w = workspace();
  w.setScenario({ capabilities, responses, beforeResponse: { "textDocument/hover": { file: w.file, text: "external = 2\n" } } });
  const session = launch(w), first = await session.request({ command: "hover", file: w.file });
  assert.equal(first.code, 2); assert.match(String(first.error), /Source changed during this query/); assert.equal(first.hover, undefined);
  assert.equal((await session.request({ command: "definition", file: w.file })).code, 0);
  await session.request({ command: "close" }); assert.equal(await session.exited, 1); reaped(w);
});

test("session: servers with sync disabled refresh through close/open with a newer document version", async () => {
  const w = workspace({ capabilities: { ...capabilities, textDocumentSync: 0 }, responses, diagnosticVersionFromDocument: true }), session = launch(w);
  await session.request({ command: "hover", file: w.file }); writeFileSync(w.file, "value = 2\n");
  assert.equal((await session.request({ command: "diagnostics", file: w.file })).verified, true);
  await session.request({ command: "close" }); assert.equal(await session.exited, 0);
  const events = w.events(); assert.equal(events.filter(event => event.method === "initialize").length, 1);
  assert.equal(events.some(event => event.method === "textDocument/didChange"), false);
  assert.deepEqual(events.filter(event => event.method === "textDocument/didOpen").map(event => object(object(event.params).textDocument).version), [1, 2]);
  assert.equal(events.filter(event => event.method === "textDocument/didClose").length, 1); reaped(w);
});

test("session: Rust file refresh keeps the ready workspace when the server sends no new workspace status", async () => {
  const w = workspace({ capabilities, responses, diagnosticVersionFromDocument: true, serverStatus: { quiescent: true, health: "ok" } });
  w.configs["rust-analyzer"] = w.configs.fixture; delete w.configs.fixture; w.saveConfig();
  const session = launch(w, ["--timeout", "5"]);
  assert.equal((await session.request({ command: "hover", file: w.file })).found, true);
  writeFileSync(w.file, "value = 2\n");
  const changed = await session.request({ command: "hover", file: w.file });
  assert.equal(changed.code, 0); assert.equal(changed.found, true); assert.equal(changed.refreshedDocuments, 1);
  await session.request({ command: "close" }); assert.equal(await session.exited, 0);
  assert.equal(w.events().filter(event => event.method === "initialize").length, 1);
  assert.equal(w.events().filter(event => event.method === "textDocument/didChange").length, 1); reaped(w);
});

test("session: EOF and SIGTERM reap warm servers", async () => {
  for (const signal of [false, true]) {
    const w = workspace({ capabilities, responses }), session = launch(w);
    await session.request({ command: "hover", file: w.file });
    if (signal) session.child.kill("SIGTERM"); else session.child.stdin!.end();
    assert.equal(await session.exited, signal ? 143 : 0); reaped(w);
  }
});

test("session input: chunked Unicode, invalid UTF-8 and oversized rows preserve the next complete row", async () => {
  const unicode = Buffer.from('{"name":"中文😀"}\n');
  const chunks = [unicode.subarray(0, 12), unicode.subarray(12, 14), unicode.subarray(14), Buffer.from([0xff, 10]), Buffer.alloc(MAX_FILE_BYTES + 1, 32), Buffer.from('\n{"ok":true}')];
  const rows = []; for await (const row of sessionLines(Readable.from(chunks))) rows.push(row);
  assert.deepEqual(JSON.parse(rows[0].text!), { name: "中文😀" }); assert.match(rows[1].error!, /UTF-8/);
  assert.match(rows[2].error!, /exceeds/); assert.equal(rows[3].line, 4); assert.deepEqual(JSON.parse(rows[3].text!), { ok: true });
});

test("references pagination: separate CLI pages use one query snapshot and preserve cursor with field selection", () => {
  const w = workspace({ capabilities, responses: { ...responses, "textDocument/references": [] } });
  const locations = Array.from({ length: 5 }, (_, character) => ({ uri: w.uri, range: { start: { line: 0, character }, end: { line: 0, character: character + 1 } } }));
  w.setScenario({ capabilities, responses: { ...responses, "textDocument/references": locations } });
  const first = query(w, ["references", "--file", w.file, "--page-size", "2", "--fields", "locations"]);
  assert.equal(first.code, 0); assert.equal(typeof first.data.nextCursor, "string");
  const second = query(w, ["next", "--cursor", String(first.data.nextCursor)]), third = query(w, ["next", "--cursor", String(second.data.nextCursor)]);
  assert.equal(second.code, 0); assert.equal(third.code, 0); assert.equal(third.data.nextCursor, undefined);
  assert.deepEqual([first, second, third].flatMap(result => (result.data.locations as { column: number }[]).map(item => item.column)), [1, 2, 3, 4, 5]);
  writeFileSync(w.file, "value = 2\n");
  assert.equal(query(w, ["next", "--cursor", String(first.data.nextCursor)]).code, 2);
  assert.equal(w.events().filter(event => event.method === "textDocument/references").length, 1);
  assert.equal(w.events().filter(event => event.method === "initialize").length, 1); reaped(w);
});

test("inspect budget: CLI and session share one response budget while retaining failure states and protocol IDs", async () => {
  const w = workspace({ capabilities, diagnostics: [{ range, severity: 1, message: "existing error" }], responses: { ...responses, "textDocument/hover": { contents: "😀".repeat(3000) } } });
  const direct = query(w, ["inspect", "--file", w.file, "--context", "--budget", "3000"]);
  assert.equal(direct.code, 1); assert.ok(JSON.stringify(direct.data).length <= 3000); assert.equal(object(direct.data.budget).characters, JSON.stringify(direct.data).length);
  assert.equal(object(object(direct.data.results).diagnostics).hasErrors, true); assert.deepEqual(direct.data.failedSections, ["diagnostics"]);
  const input = join(w.root, "budget.jsonl");
  writeFileSync(input, JSON.stringify({ command: "inspect", file: w.file, fields: "results.hover.hover", budget: 800 }));
  const batch = query(w, ["batch", "--input", input]), row = (batch.data.results as Record<string, unknown>[])[0];
  assert.equal(batch.code, 1); assert.equal(row.code, 1); assert.ok(JSON.stringify(row).length <= 800);
  assert.equal(object(row.budget).characters, JSON.stringify(row).length);
  const session = launch(w), response = await session.request({ id: "budgeted", command: "inspect", file: w.file, fields: "results.hover.hover", budget: 800 });
  assert.equal(response.id, "budgeted"); assert.equal(response.code, 1); assert.ok(JSON.stringify(response).length <= 800);
  assert.equal(object(response.budget).characters, JSON.stringify(response).length); assert.deepEqual(response.failedSections, ["diagnostics"]);
  await session.request({ command: "close" }); assert.equal(await session.exited, 1); reaped(w);
});

test("new query flags: misplaced, conflicting and malformed flags fail before creating protocol state", () => {
  for (const args of [["hover", "--page-size", "2"], ["references", "--page-size", "0"], ["references", "--page-size", "2", "--limit", "3"], ["inspect", "--budget", "511"], ["hover", "--cursor", "x"], ["hover", "--stdio"]]) assert.throws(() => parseOptions(args));
  const args = parseOptions(["batch", "--input", "-"]);
  for (const value of [{ command: "inspect", file: "x", budget: 3 }, { command: "hover", file: "x", pageSize: 2 }, { command: "next" }, { command: "next", cursor: "x", file: "x" }]) assert.throws(() => queryOptions(args, value));
});

test("session: recovery alternatives follow capabilities and unimplemented methods preserve the warm server", async () => {
  const w = workspace({ capabilities: { ...capabilities, implementationProvider: false }, responses }), session = launch(w);
  const unsupported = await session.request({ command: "supertypes", file: w.file, fields: "nodes" });
  assert.deepEqual(unsupported.alternatives, ["definition"]);
  assert.equal((await session.request({ command: "definition", file: w.file })).code, 0);
  await session.request({ command: "close" }); assert.equal(await session.exited, 1); reaped(w);
  const lying = workspace({ capabilities: { ...capabilities, implementationProvider: true }, responses, errors: { "textDocument/implementation": { code: -32601, message: "Unhandled method" } } });
  const second = launch(lying), missing = await second.request({ command: "implementation", file: lying.file });
  assert.equal(missing.code, 1); assert.equal(missing.supported, false); assert.ok(!(missing.alternatives as string[]).includes("implementation"));
  assert.equal((await second.request({ command: "definition", file: lying.file })).code, 0);
  await second.request({ command: "close" }); assert.equal(await second.exited, 1);
  assert.equal(lying.events().filter(event => event.method === "initialize").length, 1); reaped(lying);
});
