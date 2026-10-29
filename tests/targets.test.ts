import assert from "node:assert/strict";
import { after, afterEach, before, mock, test } from "node:test";
import { chmodSync, lstatSync, readFileSync, readdirSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { attachTargets, resolveTarget } from "../src/targets.ts";
import { parseOptions } from "../src/cli.ts";
import { run } from "../src/commands.ts";
import { object } from "../src/config.ts";
import { LspClient } from "../src/client.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); }); after(() => restore());
afterEach(() => { mock.restoreAll(); cleanWorkspaces(); });
const cache = () => join(homedir(), ".cache/codex-lsp/targets");
const cli = join(dirname(fileURLToPath(import.meta.url)), "../src/cli.js");
const query = (w: ReturnType<typeof workspace>, target: string) => parseOptions(["hover", "--target", target], w.root);
function target(w: ReturnType<typeof workspace>, column = 1) {
  const result = attachTargets(w.args("definition", "--targets"), { success: true, locations: [{ file: w.file, line: 1, column }] });
  const id = String((result.locations as Record<string, unknown>[])[0].target);
  return { result, id, path: join(cache(), id.slice(2).split(".")[0] + ".json") };
}

test("targets: opt-in handles deduplicate positions and preserve input and actual UTF-16 coordinates", () => {
  const w = workspace(), original = { success: true, locations: [{ file: w.file, line: 1, column: 1 }, { file: w.file, line: 1, column: 1 }] };
  assert.equal(attachTargets(w.args("definition"), original), original);
  const result = attachTargets(w.args("definition", "--targets"), original), rows = result.locations as Record<string, unknown>[];
  assert.equal(rows[0].target, rows[1].target); assert.equal((result.targets as unknown[]).length, 1);
  assert.deepEqual(original.locations[0], { file: w.file, line: 1, column: 1 });
  const options = resolveTarget(query(w, String(rows[0].target)));
  assert.equal(options.file, w.file); assert.equal(options.line, 1); assert.equal(options.column, 1);
});

test("targets: private snapshots work across CLI invocations and point at the actual backend position", () => {
  const w = workspace(); w.setScenario({ capabilities: { definitionProvider: true, hoverProvider: true }, responses: {
    "textDocument/definition": { uri: w.uri, range }, "textDocument/hover": { contents: "value: number" },
  } });
  const invoke = (flags: string[]) => {
    const child = spawnSync(process.execPath, [cli, ...flags], { cwd: w.root, encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 0, child.stdout + child.stderr); return JSON.parse(child.stdout);
  };
  const first = invoke(["definition", "--file", w.file, "--targets", "--fields", "targets"]);
  const id = String(first.targets[0].id), snapshot = join(cache(), id.slice(2).split(".")[0] + ".json");
  if (process.platform !== "win32") { assert.equal(lstatSync(cache()).mode & 0o777, 0o700); assert.equal(lstatSync(snapshot).mode & 0o777, 0o600); }
  assert.equal(invoke(["hover", "--target", id, "--json"]).hover, "value: number");
  const params = object(w.events().find(event => event.method === "textDocument/hover")?.params);
  assert.deepEqual(params.position, { line: 0, character: 0 }); assert.equal(readFileSync(w.file, "utf8"), "value = 1\n");
});

for (const command of ["hover", "signature-help"]) test(`targets: ${command} creates a reusable handle at its actual UTF-16 query position`, async () => {
  const w = workspace({ responses: {
    "textDocument/hover": { contents: "value: number" },
    "textDocument/signatureHelp": { signatures: [{ label: "value(input: number): number" }] },
  } });
  const text = 'const emoji = "😀"; value(value);\n', column = text.lastIndexOf("value") + 1;
  writeFileSync(w.file, text);
  const flags = command === "hover" ? ["--symbol", "value#2"] : ["--column", String(column)];
  const first = await run(w.args(command, "--line", "1", ...flags, "--targets"));
  const targets = first.data.targets as Record<string, unknown>[];
  assert.equal(targets.length, 1); assert.equal(targets[0].path, "cursor");
  assert.equal(object(first.data.cursor).column, column);
  const next = await run(parseOptions(["hover", "--target", String(targets[0].id)], w.root));
  assert.equal(next.data.hover, "value: number");
  const hover = w.events().filter(event => event.method === "textDocument/hover").at(-1)!;
  assert.deepEqual(object(hover.params).position, { line: 0, character: column - 1 });
  assert.equal(readFileSync(w.file, "utf8"), text);
  const plain = await run(w.args(command, "--line", "1", ...flags));
  assert.equal(plain.data.cursor, undefined); assert.equal(plain.data.file, undefined);
});

test("targets: an edit injected during navigation cannot create a stale cursor handle", async () => {
  const w = workspace({ responses: { "textDocument/hover": { contents: "value: number" } } }), request = LspClient.prototype.request;
  mock.method(LspClient.prototype, "request", async function(this: LspClient, ...args: Parameters<typeof request>) {
    const response = await request.apply(this, args);
    if (args[0] === "textDocument/hover") writeFileSync(w.file, "other = 2\n");
    return response;
  });
  await assert.rejects(run(w.args("hover", "--targets")), /Source changed.*current anchor/);
  assert.equal(LspClient.active.size, 0);
  assert.equal(readFileSync(w.file, "utf8"), "other = 2\n");
});

test("targets: a source edit during DevDocs fallback cannot bind the old hover cursor to new text", async () => {
  const w = workspace({ responses: { "textDocument/hover": null } }), previous = process.env.CODEX_HOME;
  w.configs.fixture.languageId = "rust"; w.saveConfig(); writeFileSync(w.file, "is_none()\n");
  process.env.CODEX_HOME = w.root;
  const fetch = mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    writeFileSync(w.file, "moved()\n");
    return Response.json(String(input).endsWith("docs/docs.json") ? [{ slug: "rust" }] : { entries: [{ name: "is_none", path: "std/option.html#method.is_none" }] });
  });
  try {
    await assert.rejects(run(w.args("hover", "--symbol", "is_none", "--targets")), /Source changed.*current anchor/);
    assert.equal(fetch.mock.callCount(), 2); assert.equal(LspClient.active.size, 0);
    assert.equal(readFileSync(w.file, "utf8"), "moved()\n");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
  }
});

test("targets: changed or deleted source and another workspace fail before any backend starts", async () => {
  const w = workspace(), { id } = target(w), other = workspace();
  assert.throws(() => resolveTarget(query(other, id)), /workspace mismatch/);
  writeFileSync(w.file, "value = 2\n");
  await assert.rejects(run(query(w, id)), /Target source changed.*rerun/);
  assert.equal(readdirSync(w.root).includes("wire.ndjson"), false);
  unlinkSync(w.file); assert.throws(() => resolveTarget(query(w, id)), /ENOENT/);
});

test("targets: ambiguous flags and malformed IDs fail with actionable errors", () => {
  const w = workspace();
  for (const flags of [["--file", w.file], ["--line", "1"], ["--column", "1"], ["--symbol", "value"]])
    assert.throws(() => parseOptions(["hover", "--target", "bad", ...flags], w.root), /Choose --target/);
  for (const id of ["../file", "t_../../hello.1", "t_abc.0", "", "t_aaaaaaaaaaaaaaaa.-1"])
    assert.throws(() => resolveTarget({ ...w.args("hover"), file: undefined, target: id || "bad" }), /Invalid target ID/);
  assert.throws(() => parseOptions(["diagnostics", "--target", "bad"], w.root), /position-based/);
});

test("targets: expired, oversized indexes and damaged snapshots never silently retarget", () => {
  const w = workspace(), { id, path } = target(w), saved = readFileSync(path, "utf8");
  const value = JSON.parse(saved); value.created = 0; writeFileSync(path, JSON.stringify(value));
  assert.throws(() => resolveTarget(query(w, id)), /expired/);
  writeFileSync(path, saved); assert.throws(() => resolveTarget(query(w, id.replace(/\.0$/, ".9999"))), /Invalid target record/);
  writeFileSync(path, "{"); assert.throws(() => resolveTarget(query(w, id)), /unavailable.*rerun/);
});

test("targets: untrusted cache permissions and symlinks reject resolution", () => {
  const w = workspace(), { id, path } = target(w);
  if (process.platform !== "win32") {
    chmodSync(path, 0o644); assert.throws(() => resolveTarget(query(w, id)), /Unsafe target snapshot/); chmodSync(path, 0o600);
  }
  unlinkSync(path); symlinkSync(w.file, path);
  assert.throws(() => resolveTarget(query(w, id)), /Unsafe target snapshot/); unlinkSync(path);
});

test("targets: Unicode scalar boundaries and CRLF retain exact anchors", () => {
  const w = workspace(); writeFileSync(w.file, "😀value\r\n");
  const { id, path } = target(w, 3); assert.equal(resolveTarget(query(w, id)).column, 3);
  const value = JSON.parse(readFileSync(path, "utf8")); value.targets[0].column = 2; writeFileSync(path, JSON.stringify(value));
  assert.throws(() => resolveTarget(query(w, id)), /Invalid target position/);
  const invalid = attachTargets(w.args("definition", "--targets"), { success: true, locations: [{ file: w.file, line: 1, column: 2 }] });
  assert.deepEqual(invalid.targets, []); assert.match(String(invalid.targetsHint), /explicit/);
});

test("targets: missing and virtual locations retain navigation data and report omitted handles", () => {
  const w = workspace(), data = { success: true, locations: [{ file: join(w.root, "absent"), line: 1, column: 1 }, { file: "rust-analyzer://virtual", line: 1, column: 1 }] };
  const result = attachTargets(w.args("definition", "--targets"), data);
  assert.deepEqual(result.locations, data.locations); assert.deepEqual(result.targets, []); assert.ok(result.targetsHint);
});

test("targets: cache snapshots are bounded and callers can recover after eviction", () => {
  const w = workspace(), first = target(w);
  // Files created within one filesystem clock tick can have identical modification times.
  const earlier = new Date(Date.now() - 1000); utimesSync(first.path, earlier, earlier);
  assert.equal(resolveTarget(query(w, first.id)).file, w.file);
  for (let i = 0; i < 20; i++) target(w);
  assert.ok(readdirSync(cache()).filter(file => /^[A-Za-z0-9_-]{16}\.json$/.test(file)).length <= 16);
  assert.throws(() => resolveTarget(query(w, first.id)), /unavailable.*rerun/);
  const last = target(w); assert.equal(resolveTarget(query(w, last.id)).file, w.file);
});

test("targets: cache failures preserve successful semantic results and report explicit-anchor recovery", async () => {
  if (process.platform === "win32") return;
  const w = workspace(); target(w);
  w.setScenario({ capabilities: { definitionProvider: true }, responses: { "textDocument/definition": { uri: w.uri, range } } });
  chmodSync(cache(), 0o755);
  try {
    const result = await run(w.args("definition", "--targets"));
    assert.equal(result.data.success, true); assert.equal(result.data.found, true); assert.deepEqual(result.data.targets, []);
    assert.match(String(result.data.targetsHint), /explicit file\/line anchors.*Unsafe target cache/);
    assert.equal((result.data.locations as unknown[]).length, 1);
  } finally { chmodSync(cache(), 0o700); }
});

test("targets: sessions return a handle before EOF and reuse their server for handle-based queries", async () => {
  const w = workspace(); w.setScenario({ capabilities: { definitionProvider: true, hoverProvider: true }, responses: { "textDocument/definition": { uri: w.uri, range }, "textDocument/hover": { contents: "value: number" } } });
  const child = spawn(process.execPath, [cli, "session", "--stdio", "--targets", "--budget", "1500"], { cwd: w.root, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = ""; const rows: Record<string, unknown>[] = [], waiters: ((row: Record<string, unknown>) => void)[] = [];
  child.stdout.on("data", chunk => { buffer += String(chunk); let end; while ((end = buffer.indexOf("\n")) >= 0) { const row = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); const waiter = waiters.shift(); if (waiter) waiter(row); else rows.push(row); } });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  const request = (value: unknown) => { child.stdin.write(JSON.stringify(value) + "\n"); return rows.length ? Promise.resolve(rows.shift()!) : new Promise<Record<string, unknown>>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Session target reply missing")), 5000); waiters.push(row => { clearTimeout(timer); resolve(row); }); }); };
  try {
    const first = await request({ command: "definition", file: w.file });
    const id = String((first.targets as Record<string, unknown>[])[0].id);
    const second = await request({ command: "hover", target: id }); assert.equal(second.hover, "value: number");
    assert.ok(JSON.stringify(second).length <= 1500); assert.equal(child.exitCode, null);
    await request({ command: "close" }); assert.equal(await exited, 0);
    assert.equal(w.events().filter(event => event.method === "initialize").length, 1);
    assert.equal(w.events().filter(event => event.method === "shutdown").length, 1);
  } finally { child.kill("SIGKILL"); await exited; }
});
