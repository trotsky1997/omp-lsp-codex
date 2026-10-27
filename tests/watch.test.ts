import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { watchDiagnostics } from "../src/watch.ts";
import { LspClient } from "../src/client.ts";
import { object, type ObjectValue } from "../src/config.ts";
import type { Options } from "../src/commands.ts";
import { cleanWorkspaces, isolateGlobalConfig, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); }); after(() => restore());
const active = new Set<{ controller: AbortController; done: Promise<number> }>();
afterEach(async () => { for (const item of active) item.controller.abort(); await Promise.allSettled([...active].map(item => item.done)); active.clear(); cleanWorkspaces(); });
const capabilities = { textDocumentSync: 2, diagnosticProvider: true };
const diagnostic = (message: string, line = 0, severity = 1) => ({ range: { start: { line, character: 0 }, end: { line, character: 5 } }, message, severity, code: "E1", source: "fixture" });
function launch(w: ReturnType<typeof workspace>, extra: Partial<Options> = {}, slow = 0) {
  const controller = new AbortController(), rows: ObjectValue[] = [], pending: ObjectValue[] = [], waiters: ((value: ObjectValue) => void)[] = [];
  const output = new Writable({ write(chunk, _encoding, callback) {
    const value = JSON.parse(String(chunk)) as ObjectValue;
    if (value.event === "starting") { if (slow) setTimeout(callback, slow); else callback(); return; }
    rows.push(value);
    const waiter = waiters.shift(); if (waiter) waiter(value); else pending.push(value);
    if (slow) setTimeout(callback, slow); else callback();
  } });
  const done = watchDiagnostics({ ...w.args("diagnostics"), ...extra }, output, controller.signal);
  void done.catch(() => {});
  const task = { controller, done }; active.add(task);
  const next = () => pending.length ? Promise.resolve(pending.shift()!) : new Promise<ObjectValue>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No watch row; received ${JSON.stringify(rows)}`)), 8000);
    waiters.push(value => { clearTimeout(timer); resolve(value); });
  });
  const stop = async () => { controller.abort(); const code = await done; active.delete(task); return code; };
  return { rows, next, stop, done, controller };
}
function counts(row: ObjectValue) { return object(object(row.changes).counts); }
function issues(row: ObjectValue, kind = "new") { return object(object(row.changes)[kind]).diagnostics as ObjectValue[]; }
function reaped(w: ReturnType<typeof workspace>) {
  if (!existsSync(join(w.root, "wire.ndjson"))) return;
  for (const row of w.events().filter(row => row.direction === "lifecycle")) assert.throws(() => process.kill(Number(row.pid), 0));
}
function gitWorkspace(w: ReturnType<typeof workspace>) {
  const git = (...args: string[]) => execFileSync("git", ["-C", w.root, ...args], { encoding: "utf8" });
  git("init", "--quiet");
  writeFileSync(join(w.root, ".gitignore"), ".codex/\nfixture.project\nwire.ndjson\nscenario.json\n.gitignore\n");
  git("add", "source.fixture");
  git("-c", "user.name=codex-lsp-fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + join(w.root, ".git/disabled-hooks"), "commit", "--quiet", "-m", "fixture");
  return git;
}

test("watch: streams before stop, keeps unchanged files quiet, reuses a read-only server and reaps it", async () => {
  const w = workspace({ capabilities, diagnosticVersionFromDocument: true }), initial = readFileSync(w.file, "utf8"), stream = launch(w);
  const first = await stream.next();
  assert.equal(first.event, "snapshot"); assert.equal(first.sequence, 2); assert.equal(first.verified, true); assert.equal(first.total, 0);
  await sleep(1100); assert.equal(stream.rows.length, 1);
  assert.equal(w.events().filter(row => row.method === "initialize").length, 1);
  assert.equal(w.events().filter(row => row.method === "textDocument/diagnostic").length, 1);
  const initialize = w.events().find(row => row.method === "initialize");
  assert.equal(object(object(object(initialize?.params).capabilities).workspace).applyEdit, false);
  assert.equal(await stream.stop(), 0); assert.equal(stream.rows.at(-1)!.event, "closed");
  assert.equal(w.events().filter(row => row.method === "shutdown").length, 1);
  assert.equal(readFileSync(w.file, "utf8"), initial); reaped(w);
});

test("watch: source moves and changed messages update stable IDs, then clean diagnostics resolve them", async () => {
  const w = workspace({ capabilities, diagnosticVersionFromDocument: true, diagnosticsByText: {
    "value = 1\n": [diagnostic("first")], "\nvalue = 1\n": [diagnostic("first", 1)],
    "\nvalue = 2\n": [diagnostic("changed", 1, 2)], "\nvalue = 3\n": [],
  } }), stream = launch(w);
  const first = await stream.next(), id = issues(first)[0].id;
  assert.equal(first.hasErrors, true); assert.deepEqual(counts(first), { new: 1, resolved: 0, updated: 0, existing: 0 });
  writeFileSync(w.file, "\nvalue = 1\n"); const moved = await stream.next();
  assert.deepEqual(counts(moved), { new: 0, resolved: 0, updated: 1, existing: 0 });
  assert.equal(issues(moved, "updated")[0].id, id); assert.equal(issues(moved, "updated")[0].line, 2);
  assert.deepEqual((moved.files as ObjectValue[])[0].versions, [2]);
  writeFileSync(w.file, "\nvalue = 2\n"); const changed = await stream.next();
  assert.equal(changed.hasErrors, false); assert.equal(issues(changed, "updated")[0].id, id); assert.equal(issues(changed, "updated")[0].message, "changed");
  writeFileSync(w.file, "\nvalue = 3\n"); const clean = await stream.next();
  assert.equal(clean.verified, true); assert.equal(clean.total, 0); assert.equal(issues(clean, "resolved")[0].id, id);
  assert.equal(await stream.stop(), 0);
  assert.equal(w.events().filter(row => row.method === "initialize").length, 1);
  assert.deepEqual(w.events().filter(row => row.method === "textDocument/didChange").map(row => object(object(row.params).textDocument).version), [2, 3, 4]); reaped(w);
});

test("watch: unverified results retain earlier errors and recover without a second initialization", async () => {
  const w = workspace({ capabilities: { textDocumentSync: 2 }, diagnosticVersionFromDocument: true, diagnosticsByText: {
    "value = 1\n": [diagnostic("retained")], "value = 2\n": false, "value = 3\n": [],
  } }), stream = launch(w, { timeout: 150 });
  const first = await stream.next(), id = issues(first)[0].id;
  writeFileSync(w.file, "value = 2\n"); const unavailable = await stream.next();
  assert.equal(unavailable.verified, false); assert.equal(unavailable.retained, true); assert.equal(unavailable.total, 1); assert.equal(counts(unavailable).resolved, 0);
  writeFileSync(w.file, "value = 3\n"); const recovered = await stream.next();
  assert.equal(recovered.verified, true); assert.equal(recovered.retained, false); assert.equal(issues(recovered, "resolved")[0].id, id);
  assert.equal(await stream.stop(), 0); assert.equal(w.events().filter(row => row.method === "initialize").length, 1); reaped(w);
});

test("watch: delayed diagnostics for an older document version cannot restore a resolved issue", async () => {
  const w = workspace({ capabilities: { textDocumentSync: 2 }, diagnosticVersionFromDocument: true,
    diagnosticsByText: { "value = 1\n": [], "value = 2\n": [diagnostic("late")], "value = 3\n": [] }, diagnosticDelayByText: { "value = 2\n": 1600 } }), stream = launch(w, { timeout: 150 });
  await stream.next(); writeFileSync(w.file, "value = 2\n"); const pending = await stream.next(); assert.equal(pending.verified, false);
  writeFileSync(w.file, "value = 3\n"); const current = await stream.next(); assert.equal(current.verified, true); assert.equal(current.total, 0);
  const count = stream.rows.length; await sleep(950); assert.equal(stream.rows.length, count);
  const pushes = w.events().filter(row => row.method === "textDocument/publishDiagnostics");
  assert.ok(pushes.some(row => object(row.params).version === 2 && (object(row.params).diagnostics as unknown[]).length === 1));
  assert.equal(await stream.stop(), 0); reaped(w);
});

test("watch: source changes during collection emit an error without stale additions and retry the current source", async () => {
  const w = workspace(); w.setScenario({ capabilities, diagnosticVersionFromDocument: true, afterOpen: { file: w.file, text: "value = 2\n" }, diagnosticsByText: { "value = 1\n": [diagnostic("stale")], "value = 2\n": [] } });
  const stream = launch(w), changed = await stream.next();
  assert.equal(changed.event, "error"); assert.match(String(changed.error), /changed during watch analysis/); assert.equal(changed.retained, true); assert.equal(changed.total, 0);
  const recovered = await stream.next(); assert.equal(recovered.verified, true); assert.equal(recovered.total, 0);
  assert.equal(readFileSync(w.file, "utf8"), "value = 2\n"); assert.equal(await stream.stop(), 0); reaped(w);
});

test("watch: deletion resolves a removed file and recreation is observed in the same process", async () => {
  const w = workspace({ capabilities, diagnosticVersionFromDocument: true, diagnosticsByText: { "value = 1\n": [diagnostic("exists")] } }), stream = launch(w);
  await stream.next(); rmSync(w.file); const deleted = await stream.next();
  assert.equal(deleted.total, 0); assert.equal(counts(deleted).resolved, 1); assert.deepEqual(deleted.removedFiles, [{ file: w.file, reason: "deleted" }]);
  writeFileSync(w.file, "value = 1\n"); const created = await stream.next();
  assert.equal(created.total, 1); assert.equal(counts(created).new, 1); assert.equal(await stream.stop(), 1);
  assert.equal(w.events().filter(row => row.method === "initialize").length, 1); reaped(w);
});

test("watch: changed scope distinguishes restored files from deleted ones and discovers untracked source", async () => {
  const w = workspace({ capabilities, diagnosticVersionFromDocument: true, diagnosticsByText: { "value = 1\n": [], "value = 2\n": [diagnostic("changed")] } }), git = gitWorkspace(w);
  writeFileSync(w.file, "value = 2\n"); const stream = launch(w, { file: undefined, changed: true }); await stream.next();
  writeFileSync(w.file, "value = 1\n"); const outside = await stream.next();
  assert.equal(outside.total, 0); assert.equal(counts(outside).resolved, 0); assert.deepEqual(outside.removedFiles, [{ file: w.file, reason: "out-of-scope" }]);
  const another = join(w.root, "new.fixture"); writeFileSync(another, "value = 2\n"); const added = await stream.next();
  assert.equal(issues(added)[0].file, another); rmSync(another); const removed = await stream.next();
  assert.equal(counts(removed).resolved, 1); assert.deepEqual(removed.removedFiles, [{ file: another, reason: "deleted" }]);
  assert.equal(await stream.stop(), 0); assert.equal(git("status", "--porcelain").trim(), ""); reaped(w);
});

test("watch: malformed configuration retains prior state and a corrected configuration recovers", async () => {
  const w = workspace({ capabilities, diagnosticVersionFromDocument: true, diagnosticsByText: { "value = 1\n": [diagnostic("existing")] } }), stream = launch(w);
  await stream.next(); writeFileSync(w.configPath, "{"); const broken = await stream.next();
  assert.equal(broken.event, "error"); assert.equal(broken.retained, true); assert.equal(broken.total, 1);
  w.saveConfig(); const repaired = await stream.next(); assert.equal(repaired.verified, true); assert.equal(repaired.total, 1); assert.equal(counts(repaired).existing, 1);
  assert.equal(await stream.stop(), 1); assert.equal(w.events().filter(row => row.method === "initialize").length, 2); reaped(w);
});

test("watch: field selection and whole-row budget preserve event metadata and explicit clipping", async () => {
  const w = workspace({ capabilities: { textDocumentSync: 2 }, diagnostics: [diagnostic("x".repeat(6000)), { ...diagnostic("y".repeat(6000)), code: "E2" }, { ...diagnostic("z".repeat(6000)), code: "E3" }], diagnosticVersionFromDocument: true });
  const stream = launch(w, { fields: ["changes.new"], budget: 1600 }), row = await stream.next();
  assert.equal(row.event, "snapshot"); assert.equal(row.sequence, 2); assert.equal(row.verified, true); assert.equal(object(object(row.changes).new).total, 3);
  assert.ok(JSON.stringify(row).length <= 1600); assert.equal(object(row.budget).clipped, true);
  assert.equal(object(row.budget).characters, JSON.stringify(row).length); assert.equal(await stream.stop(), 1);
  assert.ok(stream.rows.every(value => JSON.stringify(value).length <= 1600)); assert.equal(stream.rows.at(-1)!.event, "closed"); reaped(w);
});

test("watch: cancellation flushes a backpressured response before the closed row and cleans up", async () => {
  const w = workspace({ capabilities, diagnosticVersionFromDocument: true }), stream = launch(w, {}, 60);
  await stream.next(); let settled = false; void stream.done.then(() => { settled = true; });
  stream.controller.abort(); assert.equal(settled, false);
  assert.equal(await stream.stop(), 0); assert.deepEqual(stream.rows.map(row => row.event), ["snapshot", "closed"]); reaped(w);
});

test("watch: output errors reject and still close every owned language-server child", async () => {
  const w = workspace({ capabilities, diagnosticVersionFromDocument: true });
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("closed sink")); } });
  await assert.rejects(watchDiagnostics(w.args("diagnostics"), sink), /closed sink/); reaped(w);
});

test("watch: invalid source ranges never enter retained state and an already-aborted watch starts no server", async () => {
  const w = workspace({ capabilities: { textDocumentSync: 2 }, diagnosticVersionFromDocument: true, diagnostics: [diagnostic("bad range", 999)] }), stream = launch(w);
  const invalid = await stream.next(); assert.equal(invalid.event, "error"); assert.equal(invalid.total, 0); assert.match(String(invalid.error), /outside the current source/);
  assert.equal(await stream.stop(), 1); reaped(w);
  const controller = new AbortController(); controller.abort(); const rows: ObjectValue[] = [];
  const sink = new Writable({ write(chunk, _encoding, callback) { rows.push(JSON.parse(String(chunk))); callback(); } });
  const before = w.events().length; assert.equal(await watchDiagnostics(w.args("diagnostics"), sink, controller.signal), 0);
  assert.equal(w.events().length, before); assert.deepEqual(rows.map(row => row.event), ["closed"]);
});

test("watch: rejects mixed/write/baseline scopes before starting a server", async () => {
  const w = workspace(), sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  for (const extra of [{ changed: true }, { file: undefined }, { apply: true }, { baseline: "before.json" }, { saveBaseline: "before.json" }])
    await assert.rejects(watchDiagnostics({ ...w.args("diagnostics"), ...extra }, sink), /Watch is read-only/);
});

test("watch: diagnostic reorder stays quiet and duplicate positions retain distinct IDs", async () => {
  const a = diagnostic("first"), b = diagnostic("second");
  const w = workspace({ capabilities: { textDocumentSync: 2 }, diagnosticVersionFromDocument: true, diagnosticsByText: { "value = 1\n": [a, b], "value = 2\n": [b] } }), stream = launch(w);
  const initial = await stream.next(), first = issues(initial), ids = first.map(row => row.id);
  assert.equal(new Set(ids).size, 2);
  const client = [...LspClient.active].find(client => client.server.root === w.root)!;
  await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri: w.uri, version: 1, diagnostics: [b, a] } });
  await sleep(650); assert.equal(stream.rows.length, 1);
  writeFileSync(w.file, "value = 2\n"); const remaining = await stream.next();
  assert.deepEqual(counts(remaining), { new: 0, resolved: 1, updated: 0, existing: 1 }); assert.equal(issues(remaining, "resolved")[0].id, ids[0]);
  assert.equal(await stream.stop(), 1); reaped(w);
});

test("watch: CRLF and Unicode locations remain exact, and a split surrogate never clears retained state", async () => {
  const good = { ...diagnostic("😀"), range: { start: { line: 0, character: 6 }, end: { line: 0, character: 8 } } };
  const moved = { ...good, range: { start: { line: 1, character: 6 }, end: { line: 1, character: 8 } } };
  const bad = { ...moved, range: { start: { line: 1, character: 6 }, end: { line: 1, character: 7 } } };
  const w = workspace({ capabilities, diagnosticVersionFromDocument: true, diagnosticsByText: { "value 😀\r\n": [good], "header\r\nvalue 😀\r\n": [moved], "\r\nvalue 😀\r\n": [bad] } });
  writeFileSync(w.file, "value 😀\r\n"); const stream = launch(w), first = await stream.next(), id = issues(first)[0].id;
  assert.equal(issues(first)[0].column, 7); assert.equal(issues(first)[0].endColumn, 9);
  writeFileSync(w.file, "header\r\nvalue 😀\r\n"); const shifted = await stream.next(); assert.equal(issues(shifted, "updated")[0].id, id);
  writeFileSync(w.file, "\r\nvalue 😀\r\n"); const invalid = await stream.next();
  assert.equal(invalid.event, "error"); assert.equal(invalid.total, 1); assert.equal(invalid.retained, true); assert.match(String(invalid.error), /splits Unicode/);
  assert.equal(await stream.stop(), 1); reaped(w);
});

test("watch: a missing initial file reports its cause and recovers when created", async () => {
  const w = workspace({ capabilities, diagnosticVersionFromDocument: true }); rmSync(w.file);
  const stream = launch(w), missing = await stream.next(); assert.equal(missing.event, "error"); assert.match(String(missing.error), /File not found/);
  writeFileSync(w.file, "value = 1\n"); const created = await stream.next();
  assert.equal(created.event, "snapshot"); assert.equal(created.verified, true); assert.equal(await stream.stop(), 0); reaped(w);
});

test("watch: the aggregate source limit fails before starting a language server", async () => {
  const w = workspace(), git = gitWorkspace(w); writeFileSync(w.file, "x".repeat(9 * 1024 * 1024)); writeFileSync(join(w.root, "large.fixture"), "y".repeat(9 * 1024 * 1024));
  const stream = launch(w, { file: undefined, changed: true }), large = await stream.next();
  assert.equal(large.event, "error"); assert.match(String(large.error), /16M-character limit/); assert.equal(await stream.stop(), 1);
  assert.equal(existsSync(join(w.root, "wire.ndjson")), false); assert.equal(git("diff", "--cached", "--name-only").trim(), "");
});

async function cliSignal(w: ReturnType<typeof workspace>, initializing = false) {
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "../src/cli.js"), "diagnostics", "--file", w.file, "--watch", "--jsonl", "--timeout", "5"], { cwd: w.root, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); }); child.stderr.on("data", chunk => { stderr += String(chunk); });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  try {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      if (initializing ? existsSync(join(w.root, "wire.ndjson")) && w.events().some(row => row.method === "initialize") : stdout.includes('"event":"snapshot"')) break;
      if (child.exitCode !== null) assert.fail(`CLI exited before ready: ${stdout} ${stderr}`);
      await sleep(10);
    }
    assert.ok(initializing ? w.events().some(row => row.method === "initialize") : stdout.includes('"event":"snapshot"'), stderr);
    const started = performance.now(); child.kill("SIGINT");
    const code = await Promise.race([exited, sleep(1800).then(() => { throw new Error(`SIGINT did not stop watch: ${stdout} ${stderr}`); })]);
    return { code, rows: stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as ObjectValue), stderr, elapsedMs: performance.now() - started };
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
  }
}

test("watch CLI: SIGINT flushes a final closed row and uses the final diagnostic status", async () => {
  const w = workspace({ capabilities, diagnosticVersionFromDocument: true }), result = await cliSignal(w);
  assert.equal(result.stderr, ""); assert.equal(result.code, 0); assert.deepEqual(result.rows.map(row => row.event), ["starting", "snapshot", "closed"]); reaped(w);
});

test("watch CLI: SIGINT interrupts a pending server initialization and reaps it promptly", async () => {
  const w = workspace(); w.configs.fixture.args![1] = "stall-init"; w.saveConfig();
  const result = await cliSignal(w, true);
  assert.equal(result.stderr, ""); assert.equal(result.code, 0); assert.deepEqual(result.rows.map(row => row.event), ["starting", "closed"]);
  assert.ok(result.elapsedMs < 1800); reaped(w);
});

test("watch: large reordered diagnostic sets preserve IDs and emit only the resolved delta", async () => {
  const all = Array.from({ length: 5000 }, (_, index) => diagnostic(`issue-${index}`));
  const w = workspace({ capabilities: { textDocumentSync: 2 }, diagnosticVersionFromDocument: true,
    diagnosticsByText: { "value = 1\n": all, "value = 2\n": all.slice(1).reverse() } }), stream = launch(w, { limit: 5 });
  const initial = await stream.next(); assert.equal(initial.total, 5000); assert.equal(issues(initial).length, 5); assert.equal(new Set(issues(initial).map(row => row.id)).size, 5);
  const resolvedId = issues(initial)[0].id;
  writeFileSync(w.file, "value = 2\n"); const delta = await stream.next();
  assert.equal(delta.total, 4999); assert.deepEqual(counts(delta), { new: 0, resolved: 1, updated: 0, existing: 4999 }); assert.equal(issues(delta, "resolved")[0].id, resolvedId);
  assert.equal(await stream.stop(), 1); reaped(w);
});

test("watch: a changed message cannot steal an unchanged diagnostic ID at the same position", async () => {
  const w = workspace({ capabilities, diagnosticVersionFromDocument: true, diagnosticsByText: {
    "value = 1\n": [diagnostic("first"), diagnostic("second")], "value = 2\n": [diagnostic("changed"), diagnostic("second")],
  } }), stream = launch(w), first = await stream.next(), initial = issues(first);
  writeFileSync(w.file, "value = 2\n"); const changed = await stream.next();
  assert.deepEqual(counts(changed), { new: 0, resolved: 0, updated: 1, existing: 1 }); assert.equal(issues(changed, "updated")[0].id, initial[0].id);
  assert.equal(await stream.stop(), 1); reaped(w);
});

test("watch: startup status flushes before backend work and supports cancellation under backpressure", async () => {
  const w = workspace({ capabilities }), controller = new AbortController(), rows: ObjectValue[] = [];
  let release: (() => void) | undefined, ready: () => void;
  const starting = new Promise<void>(resolve => { ready = resolve; });
  const sink = new Writable({ write(chunk, _encoding, callback) {
    const row = JSON.parse(String(chunk)); rows.push(row);
    if (row.event === "starting") { release = callback; ready(); } else callback();
  } });
  const done = watchDiagnostics(w.args("diagnostics"), sink, controller.signal);
  try {
    await starting; assert.equal(rows[0].verified, false); assert.match(String(rows[0].hint), /Initializing/);
    assert.equal(existsSync(join(w.root, "wire.ndjson")), false); controller.abort(); release!(); release = undefined;
    assert.equal(await done, 0); assert.deepEqual(rows.map(row => row.event), ["starting", "closed"]);
    assert.equal(existsSync(join(w.root, "wire.ndjson")), false);
  } finally { controller.abort(); release?.(); await done; }
});
