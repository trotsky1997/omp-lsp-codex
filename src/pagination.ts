import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { gitRoot, MAX_FILE_BYTES, object, readText, type ObjectValue } from "./config.ts";

const TTL = 10 * 60 * 1000, MAX_SNAPSHOTS = 16, MAX_CACHE_BYTES = 32 * 1024 * 1024;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const FILENAME = new RegExp(`^references-(${UUID})\\.json$`), CURSOR = new RegExp(`^(${UUID})\\.([1-9][0-9]*)$`);
const RETRY = "Run references --page-size again for a new snapshot.";
interface Location { file: string; line: number; column: number; }
interface Snapshot {
  schema: 1; kind: "codex-lsp.references"; id: string; root: string; createdAt: number; expiresAt: number; pageSize: number;
  source: { file: string; hash: string }; targets: Record<string, string | null>; locations: Location[]; server?: string;
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const integer = (value: unknown, minimum = 1): value is number => Number.isSafeInteger(value) && Number(value) >= minimum;
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes(String(object(error).code));
function privateEntry(entry: Stats, directory = false) {
  if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1)) throw new Error("Unsafe pagination cache entry");
  if (process.platform !== "win32" && (entry.uid !== process.getuid?.() || (entry.mode & 0o077))) throw new Error("Pagination cache must be private to the current user");
}
function cacheDirectory() {
  const base = join(homedir(), ".cache"), directory = join(base, "codex-lsp", "pages");
  for (const path of [base, join(base, "codex-lsp"), directory]) {
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
    const entry = lstatSync(path);
    if (path === base) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || process.platform !== "win32" && (entry.uid !== process.getuid?.() || (entry.mode & 0o022))) throw new Error("Unsafe pagination cache directory");
    } else privateEntry(entry, true);
  }
  return directory;
}
function targetStamp(file: string): string | null {
  try {
    const entry = statSync(file, { bigint: true });
    if (!entry.isFile()) throw new Error(`Reference target is not a regular file: ${file}`);
    return [entry.dev, entry.ino, entry.size, entry.mtimeNs, entry.ctimeNs].join(":");
  } catch (error) { if (missing(error)) return null; throw error; }
}
function sourceHash(file: string) {
  const entry = statSync(file);
  if (!entry.isFile() || entry.size > MAX_FILE_BYTES) throw new Error("Pagination source must be a regular file no larger than 16 MiB");
  return digest(readText(file));
}
function validate(value: unknown, id: string): Snapshot {
  const x = object(value), source = object(x.source), targets = object(x.targets);
  if (x.schema !== 1 || x.kind !== "codex-lsp.references" || x.id !== id || typeof x.root !== "string" || !isAbsolute(x.root) ||
      Object.keys(x).some(key => !["schema", "kind", "id", "root", "createdAt", "expiresAt", "pageSize", "source", "targets", "locations", "server"].includes(key)) ||
      !integer(x.createdAt, 0) || !integer(x.expiresAt) || x.expiresAt !== x.createdAt + TTL || !integer(x.pageSize) || x.pageSize > 1000 ||
      Object.keys(source).some(key => !["file", "hash"].includes(key)) ||
      typeof source.file !== "string" || !isAbsolute(source.file) || typeof source.hash !== "string" || !/^[0-9a-f]{64}$/.test(source.hash) ||
      !x.targets || typeof x.targets !== "object" || Array.isArray(x.targets) || !Array.isArray(x.locations) ||
      x.server !== undefined && typeof x.server !== "string") throw new Error("Invalid references snapshot");
  const files = new Set<string>();
  for (const raw of x.locations) {
    const location = object(raw);
    if (typeof location.file !== "string" || !isAbsolute(location.file) || !integer(location.line) || !integer(location.column) || Object.keys(location).some(key => !["file", "line", "column"].includes(key))) throw new Error("Invalid references snapshot location");
    files.add(location.file);
  }
  if (Object.keys(targets).length !== files.size || [...files].some(file => !Object.hasOwn(targets, file)) || Object.entries(targets).some(([file, stamp]) => !isAbsolute(file) || stamp !== null && (typeof stamp !== "string" || !/^\d+:\d+:\d+:-?\d+:-?\d+$/.test(stamp)))) throw new Error("Invalid references snapshot targets");
  return value as Snapshot;
}
function readSnapshot(file: string, id: string) {
  privateEntry(lstatSync(file));
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd); privateEntry(before);
    if (before.size > MAX_FILE_BYTES) throw new Error("References snapshot exceeds 16 MiB");
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) throw new Error("References snapshot changed while reading");
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error("Invalid references snapshot JSON"); }
    return validate(value, id);
  } finally { closeSync(fd); }
}
function withCacheLock<T>(directory: string, action: () => T, recover = true): T {
  const file = join(directory, ".write-lock");
  let fd: number;
  try { fd = openSync(file, "wx", 0o600); }
  catch (error) {
    if (object(error).code !== "EEXIST") throw error;
    if (!recover) throw new Error("Pagination cache is busy; retry the references query");
    privateEntry(lstatSync(file));
    let lock: ObjectValue;
    try {
      if (lstatSync(file).size > 1024) throw new Error("oversized");
      lock = object(JSON.parse(readFileSync(file, "utf8")));
    } catch { throw new Error("Pagination cache is busy or has an invalid lock; retry the references query"); }
    if (lock.kind !== "codex-lsp.pages.lock" || !integer(lock.pid) || lock.pid > 2147483647) throw new Error("Invalid pagination cache lock");
    try { process.kill(lock.pid, 0); }
    catch (check) {
      if (object(check).code === "ESRCH") { unlinkSync(file); return withCacheLock(directory, action, false); }
    }
    throw new Error("Pagination cache is busy; retry the references query");
  }
  try {
    writeFileSync(fd, JSON.stringify({ kind: "codex-lsp.pages.lock", pid: process.pid }));
    return action();
  } finally { closeSync(fd); unlinkSync(file); }
}
function save(snapshot: Snapshot) {
  const bytes = Buffer.from(JSON.stringify(snapshot));
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`References snapshot exceeds 16 MiB; narrow the query. ${RETRY}`);
  const directory = cacheDirectory();
  withCacheLock(directory, () => {
    const entries: { file: string; bytes: number; createdAt: number }[] = [];
    for (const name of readdirSync(directory)) {
      const match = name.match(FILENAME); if (!match) continue;
      const file = join(directory, name);
      try {
        const value = readSnapshot(file, match[1]);
        if (value.expiresAt <= Date.now()) unlinkSync(file);
        else entries.push({ file, bytes: lstatSync(file).size, createdAt: value.createdAt });
      } catch { /* Unknown or damaged files are left for their owner. */ }
    }
    entries.sort((a, b) => a.createdAt - b.createdAt || a.file.localeCompare(b.file));
    let size = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    while (entries.length >= MAX_SNAPSHOTS || size + bytes.length > MAX_CACHE_BYTES) {
      const old = entries.shift(); if (!old) throw new Error("References snapshot exceeds pagination cache capacity");
      unlinkSync(old.file); size -= old.bytes;
    }
    const file = join(directory, `references-${snapshot.id}.json`), fd = openSync(file, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); }
    catch (error) { unlinkSync(file); throw error; }
    finally { closeSync(fd); }
  });
}
function page(snapshot: Snapshot, offset: number): ObjectValue {
  const locations = snapshot.locations.slice(offset, offset + snapshot.pageSize), end = offset + locations.length;
  return { success: true, found: snapshot.locations.length > 0, ...(snapshot.server ? { server: snapshot.server } : {}),
    total: snapshot.locations.length, shown: locations.length, offset, pageSize: snapshot.pageSize, truncated: locations.length < snapshot.locations.length,
    locations, ...(end < snapshot.locations.length ? { nextCursor: `${snapshot.id}.${end}` } : {}),
    snapshot: { createdAt: new Date(snapshot.createdAt).toISOString(), expiresAt: new Date(snapshot.expiresAt).toISOString(),
      hint: "Results belong to the original query snapshot; rerun references to discover newly added references." } };
}
export function firstPage(options: { cwd: string; sourceFile: string; sourceText: string; pageSize: number }, data: ObjectValue): ObjectValue {
  if (!integer(options.pageSize) || options.pageSize > 1000) throw new Error("--page-size must be an integer from 1 to 1000");
  if (data.success !== true || !Array.isArray(data.locations) || data.truncated === true || data.total !== undefined && data.total !== data.locations.length) throw new Error("Pagination requires a complete successful references result");
  const locations: Location[] = data.locations.map(raw => {
    const value = object(raw);
    if (typeof value.file !== "string" || !isAbsolute(value.file)) throw new Error("Cannot paginate virtual reference targets; rerun references without --page-size (use --limit 0 for complete output)");
    if (!integer(value.line) || !integer(value.column)) throw new Error("Invalid reference position for pagination");
    return { file: value.file, line: value.line, column: value.column };
  });
  const sourceFile = realpathSync(options.sourceFile), hash = digest(options.sourceText);
  if (sourceHash(sourceFile) !== hash) throw new Error(`Source changed during the references query. ${RETRY}`);
  const targets = Object.fromEntries([...new Set(locations.map(value => value.file))].map(file => [file, targetStamp(file)]));
  const createdAt = Date.now(), snapshot: Snapshot = { schema: 1, kind: "codex-lsp.references", id: randomUUID(), root: realpathSync(gitRoot(options.cwd)),
    createdAt, expiresAt: createdAt + TTL, pageSize: options.pageSize, source: { file: sourceFile, hash }, targets, locations,
    ...(typeof data.server === "string" ? { server: data.server } : {}) };
  if (sourceHash(sourceFile) !== hash || Object.entries(targets).some(([file, stamp]) => targetStamp(file) !== stamp)) throw new Error(`Files changed during the references query. ${RETRY}`);
  if (locations.length > options.pageSize) save(snapshot);
  return page(snapshot, 0);
}
export function nextPage(options: { cwd: string; cursor: string }): ObjectValue {
  const match = options.cursor.match(CURSOR), offset = match ? Number(match[2]) : NaN;
  if (!match || !integer(offset)) throw new Error(`Invalid pagination cursor. ${RETRY}`);
  let snapshot: Snapshot;
  try { snapshot = readSnapshot(join(cacheDirectory(), `references-${match[1]}.json`), match[1]); }
  catch (error) { throw new Error(`References snapshot is unavailable or invalid (${error instanceof Error ? error.message : String(error)}). ${RETRY}`); }
  if (snapshot.createdAt > Date.now() || snapshot.expiresAt <= Date.now()) throw new Error(`References snapshot expired. ${RETRY}`);
  if (snapshot.root !== realpathSync(gitRoot(options.cwd))) throw new Error(`References snapshot workspace mismatch. ${RETRY}`);
  if (offset >= snapshot.locations.length || offset % snapshot.pageSize !== 0) throw new Error(`Invalid pagination cursor offset. ${RETRY}`);
  try {
    if (sourceHash(snapshot.source.file) !== snapshot.source.hash || Object.entries(snapshot.targets).some(([file, stamp]) => targetStamp(file) !== stamp)) throw new Error("changed");
  } catch { throw new Error(`Snapshot source or reference files changed. ${RETRY}`); }
  return page(snapshot, offset);
}
