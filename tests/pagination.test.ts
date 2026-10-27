import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, mock, test } from "node:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { firstPage, nextPage } from "../src/pagination.ts";
import { MAX_FILE_BYTES, object } from "../src/config.ts";
import { cleanWorkspaces, isolateGlobalConfig, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); }); after(() => restore());
afterEach(() => { mock.restoreAll(); rmSync(join(homedir(), ".cache"), { recursive: true, force: true }); cleanWorkspaces(); });
const directory = () => join(homedir(), ".cache/codex-lsp/pages");
const cursorFile = (cursor: unknown) => join(directory(), `references-${String(cursor).split(".")[0]}.json`);
function fixture() {
  const w = workspace(), target = join(w.root, "target.ts");
  writeFileSync(target, "value();\n".repeat(20));
  const locations = Array.from({ length: 5 }, (_, index) => ({ file: target, line: index + 1, column: 1 }));
  const options = { cwd: w.root, sourceFile: w.file, sourceText: readFileSync(w.file, "utf8"), pageSize: 2 };
  const data = { success: true, found: true, total: locations.length, truncated: false, server: "fixture", locations };
  return { w, target, locations, options, data, first: () => firstPage(options, data) };
}
test("pages: ordered first/middle/last results preserve every reference without extra payload", () => {
  const f = fixture(), first = firstPage(f.options, { ...f.data, payload: { APIKEY: "must not be saved" } });
  const second = nextPage({ cwd: f.w.root, cursor: String(first.nextCursor) });
  const last = nextPage({ cwd: f.w.root, cursor: String(second.nextCursor) });
  assert.deepEqual([first, second, last].flatMap(page => page.locations), f.locations);
  assert.deepEqual([first, second, last].map(page => [page.total, page.shown, page.offset]), [[5, 2, 0], [5, 2, 2], [5, 1, 4]]);
  assert.equal(last.nextCursor, undefined); assert.equal(last.truncated, true);
  assert.equal(first.server, "fixture"); assert.match(String(object(first.snapshot).hint), /original query snapshot/);
  assert.ok(!readFileSync(cursorFile(first.nextCursor), "utf8").includes("must not be saved"));
  assert.equal(existsSync(join(f.w.root, "wire.ndjson")), false);
});
test("pages: complete and empty first pages need no cache entry", () => {
  const f = fixture();
  for (const locations of [[], [f.locations[0]]]) {
    const page = firstPage(f.options, { ...f.data, locations, total: locations.length });
    assert.equal(page.found, !!locations.length); assert.equal(page.truncated, false); assert.equal(page.nextCursor, undefined);
  }
  assert.equal(existsSync(directory()), false);
});
test("pages: malformed sizes, incomplete results and virtual references fail with recovery", () => {
  const f = fixture();
  for (const pageSize of [0, 1001, 1.5, NaN]) assert.throws(() => firstPage({ ...f.options, pageSize }, f.data), /page-size/);
  for (const data of [{ ...f.data, total: 10 }, { ...f.data, truncated: true }, { ...f.data, success: false }]) assert.throws(() => firstPage(f.options, data), /complete successful/);
  assert.throws(() => firstPage(f.options, { ...f.data, total: 1, locations: [{ file: "untitled:source", line: 1, column: 1 }] }), /without --page-size/);
});
test("pages: a source changed during querying cannot create a misleading snapshot", () => {
  const f = fixture(); writeFileSync(f.w.file, "new source\n");
  assert.throws(f.first, /Source changed/); assert.equal(existsSync(directory()), false);
});
for (const changed of ["source", "target", "missing-target"]) test(`pages: ${changed} changes invalidate saved references`, () => {
  const f = fixture();
  if (changed === "missing-target") unlinkSync(f.target);
  const first = f.first();
  writeFileSync(changed === "source" ? f.w.file : f.target, "a new source version\n");
  assert.throws(() => nextPage({ cwd: f.w.root, cursor: String(first.nextCursor) }), /files changed.*references --page-size/);
});
test("pages: workspace, cursor offset and expiration checks reject stale continuations", () => {
  const f = fixture(), first = f.first(), cursor = String(first.nextCursor), other = workspace();
  assert.throws(() => nextPage({ cwd: other.root, cursor }), /workspace mismatch/);
  for (const bad of ["../outside", "not-a-cursor", cursor.replace(/\.2$/, ".0"), cursor.replace(/\.2$/, ".3"), cursor.replace(/\.2$/, ".99999999999999999999"), `${randomUUID()}.2`]) assert.throws(() => nextPage({ cwd: f.w.root, cursor: bad }), /cursor|snapshot/);
  const file = cursorFile(cursor), snapshot = JSON.parse(readFileSync(file, "utf8"));
  snapshot.createdAt -= 10 * 60 * 1000 + 1; snapshot.expiresAt -= 10 * 60 * 1000 + 1; writeFileSync(file, JSON.stringify(snapshot));
  assert.throws(() => nextPage({ cwd: f.w.root, cursor }), /expired/);
});
test("pages: corrupt cache errors never print the snapshot body", () => {
  const f = fixture(), cursor = String(f.first().nextCursor), file = cursorFile(cursor);
  for (const text of ['{"APIKEY":"secret-value",', JSON.stringify({ schema: 1, APIKEY: "secret-value" })]) {
    writeFileSync(file, text);
    assert.throws(() => nextPage({ cwd: f.w.root, cursor }), error => error instanceof Error && /invalid/i.test(error.message) && !error.message.includes("secret-value"));
  }
});
test("pages: edited snapshot schemas and future timestamps cannot continue a query", () => {
  const f = fixture(), cursor = String(f.first().nextCursor), file = cursorFile(cursor), original = JSON.parse(readFileSync(file, "utf8"));
  for (const value of [{ ...original, extra: "arbitrary payload" }, { ...original, pageSize: 0 }, { ...original, targets: {} }, { ...original, createdAt: Date.now() + 60000, expiresAt: Date.now() + 660000 }]) {
    writeFileSync(file, JSON.stringify(value)); assert.throws(() => nextPage({ cwd: f.w.root, cursor }), /invalid|expired/);
  }
});
test("pages: private cache modes and symlinks protect unrelated files", () => {
  const f = fixture(), cursor = String(f.first().nextCursor), file = cursorFile(cursor);
  if (process.platform !== "win32") {
    assert.equal(statSync(directory()).mode & 0o777, 0o700); assert.equal(statSync(file).mode & 0o777, 0o600);
    chmodSync(file, 0o644); assert.throws(() => nextPage({ cwd: f.w.root, cursor }), /private/); chmodSync(file, 0o600);
    chmodSync(directory(), 0o755); assert.throws(() => nextPage({ cwd: f.w.root, cursor }), /private/); chmodSync(directory(), 0o700);
  }
  const important = join(f.w.root, "important.txt"); writeFileSync(important, "keep me"); unlinkSync(file); symlinkSync(important, file);
  assert.throws(() => nextPage({ cwd: f.w.root, cursor }), /Unsafe/); assert.equal(readFileSync(important, "utf8"), "keep me");
});
test("pages: a linked cache parent never receives writes", () => {
  const f = fixture(), outside = join(f.w.root, "outside"); mkdirSync(outside); symlinkSync(outside, join(homedir(), ".cache"), "dir");
  assert.throws(f.first, /Unsafe/); assert.deepEqual(readdirSync(outside), []);
});
test("pages: cache ownership is checked before reading results", () => {
  const f = fixture(), cursor = String(f.first().nextCursor);
  if (process.platform !== "win32") {
    const uid = process.getuid!(); mock.method(process as { getuid: () => number }, "getuid", () => uid + 1);
    assert.throws(() => nextPage({ cwd: f.w.root, cursor }), /Unsafe|private/);
  }
});
test("pages: expiry/count eviction preserves unknown files and limits owned snapshots", () => {
  const f = fixture(), now = Date.now() - 1000; let clock = now;
  mock.method(Date, "now", () => clock++);
  const first = f.first(), unknown = join(directory(), "notes.txt"), damaged = join(directory(), `references-${randomUUID()}.json`);
  writeFileSync(unknown, "keep"); writeFileSync(damaged, "unknown", { mode: 0o600 });
  for (let index = 0; index < 16; index++) f.first();
  assert.equal(existsSync(cursorFile(first.nextCursor)), false);
  assert.equal(readdirSync(directory()).filter(file => file.startsWith("references-") && join(directory(), file) !== damaged).length, 16);
  assert.equal(readFileSync(unknown, "utf8"), "keep"); assert.equal(readFileSync(damaged, "utf8"), "unknown");
  const kept = readdirSync(directory()).filter(file => file.startsWith("references-") && join(directory(), file) !== damaged)[0], old = JSON.parse(readFileSync(join(directory(), kept), "utf8"));
  old.createdAt -= 10 * 60 * 1000; old.expiresAt -= 10 * 60 * 1000; writeFileSync(join(directory(), kept), JSON.stringify(old));
  f.first(); assert.equal(existsSync(join(directory(), kept)), false);
});
test("pages: cache write locks fail promptly and recover a dead process lease", () => {
  const f = fixture(); f.first(); const lock = join(directory(), ".write-lock");
  writeFileSync(lock, JSON.stringify({ kind: "codex-lsp.pages.lock", pid: process.pid }), { mode: 0o600 });
  assert.throws(f.first, /cache is busy/); unlinkSync(lock);
  writeFileSync(lock, JSON.stringify({ kind: "codex-lsp.pages.lock", pid: 2147483647 }), { mode: 0o600 });
  assert.ok(f.first().nextCursor); assert.equal(existsSync(lock), false);
});
test("pages: byte quota evicts old snapshots and rejects an oversized single result", () => {
  const f = fixture(), locationBytes = JSON.stringify(f.locations[0]).length + 1;
  const data = { ...f.data, locations: Array(Math.ceil(12 * 1024 * 1024 / locationBytes)).fill(f.locations[0]) }; data.total = data.locations.length;
  const now = Date.now() - 1000; let clock = now; mock.method(Date, "now", () => clock++);
  const first = firstPage(f.options, data); firstPage(f.options, data); firstPage(f.options, data);
  assert.equal(existsSync(cursorFile(first.nextCursor)), false);
  assert.ok(readdirSync(directory()).filter(file => file.startsWith("references-")).reduce((sum, file) => sum + statSync(join(directory(), file)).size, 0) <= 32 * 1024 * 1024);
  const huge = { ...data, locations: Array(Math.ceil((MAX_FILE_BYTES + 1024) / locationBytes)).fill(f.locations[0]) }; huge.total = huge.locations.length;
  assert.throws(() => firstPage(f.options, huge), /exceeds 16 MiB/);
});
