import assert from "node:assert/strict";
import { after, afterEach, test, mock } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import type { Mode, PathLike, PathOrFileDescriptor, WriteFileOptions } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite, applyWorkspaceEdit, moveNoReplace, remapEdit, textChanges } from "../src/edits.ts";
import { fileUri, MAX_FILE_BYTES } from "../src/config.ts";
import type { TextEdit } from "../src/omp/types.ts";

const roots: string[] = [];
const originalRename = fs.renameSync;
let renameFault: typeof fs.renameSync | undefined;
const renameSpy = mock.method(fs, "renameSync", (source: PathLike, target: PathLike) => (renameFault ?? originalRename)(source, target));
syncBuiltinESMExports();
after(() => { renameSpy.mock.restore(); syncBuiltinESMExports(); });
function temp() { const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "codex-lsp edits "))); roots.push(root); return root; }
function fixture() {
  const root = temp(), first = join(root, "first.txt"), second = join(root, "second.txt");
  fs.writeFileSync(first, "hello\n"); fs.writeFileSync(second, "hello\n");
  const edit: TextEdit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "updated" };
  return { root, first, second, edit, changes: { [fileUri(first)]: [edit], [fileUri(second)]: [edit] } };
}
afterEach(() => {
  renameFault = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
test("atomic write: rename failure preserves bytes and removes temporary files", () => {
  const { root, first } = fixture(), rename = originalRename;
  const trace: string[] = [];
  renameFault = (source, target) => {
    trace.push(String(target));
    if (target === first) throw new Error("injected rename failure");
    return rename(source, target);
  };
  assert.throws(() => atomicWrite(first, Buffer.from("new")), (error) => error instanceof Error && error.message.includes(String("injected rename failure")));
  assert.deepStrictEqual(trace, [first]);
  assert.strictEqual(fs.readFileSync(first, "utf8"), "hello\n");
  assert.deepStrictEqual(fs.readdirSync(root).sort(), ["first.txt", "second.txt"]);
});
test("workspace edit: a later write failure rolls earlier writes back", async () => {
  const { root, first, second, changes } = fixture(), rename = originalRename, trace: string[] = [];
  renameFault = (source, target) => {
    trace.push(String(target));
    if (target === second) throw new Error("injected disk failure");
    return rename(source, target);
  };
  await assert.rejects(applyWorkspaceEdit({ changes }, root), (error) => error instanceof Error && error.message.includes(String("injected disk failure")));
  assert.deepStrictEqual(trace, [first, second, first]);
  assert.strictEqual(fs.readFileSync(first, "utf8"), "hello\n");
  assert.strictEqual(fs.readFileSync(second, "utf8"), "hello\n");
  assert.strictEqual(fs.readdirSync(root).length, 2);
});
test("workspace edit: oversized generated files fail before any planned write", async () => {
  const { root, first, second, edit } = fixture(), changes = { [fileUri(first)]: [edit], [fileUri(second)]: [{ ...edit, newText: "x".repeat(MAX_FILE_BYTES + 1) }] };
  await assert.rejects(applyWorkspaceEdit({ changes }, root), /16 MiB/);
  assert.strictEqual(fs.readFileSync(first, "utf8"), "hello\n"); assert.strictEqual(fs.readFileSync(second, "utf8"), "hello\n"); assert.strictEqual(fs.readdirSync(root).length, 2);
});
test("workspace edit: rollback preserves an external edit made during failure", async () => {
  const { root, first, second, changes } = fixture(), rename = originalRename;
  renameFault = (source, target) => {
    if (target === second) { fs.writeFileSync(first, "external edit\n"); throw new Error("injected disk failure"); }
    return rename(source, target);
  };
  await assert.rejects(applyWorkspaceEdit({ changes }, root), (error) => error instanceof Error && error.message.includes(String("rollback failed")));
  assert.strictEqual(fs.readFileSync(first, "utf8"), "external edit\n");
  assert.strictEqual(fs.readFileSync(second, "utf8"), "hello\n");
});
test("workspace edit: detect an external edit before writing a later file", async () => {
  const { root, first, second, changes } = fixture(), rename = originalRename;
  renameFault = (source, target) => {
    rename(source, target);
    if (target === first) fs.writeFileSync(second, "external edit\n");
  };
  await assert.rejects(applyWorkspaceEdit({ changes }, root), (error) => error instanceof Error && error.message.includes(String("File changed")));
  assert.strictEqual(fs.readFileSync(first, "utf8"), "hello\n");
  assert.strictEqual(fs.readFileSync(second, "utf8"), "external edit\n");
});
for (const [caseIndex, caseValue] of (["outside", "symlink", "invalid UTF-8", "surrogate", "invalid range"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (kind) => {
  const { root, first, second, edit } = fixture();
  let target = second, invalid = edit;
  if (kind === "outside" || kind === "symlink") {
    const external = join(temp(), "external.txt"); fs.writeFileSync(external, "hello\n");
    if (kind === "symlink") { target = join(root, "link.txt"); fs.symlinkSync(external, target); }
    else target = external;
  } else if (kind === "invalid UTF-8") fs.writeFileSync(target, Buffer.from([0xff, 0xfe]));
  else if (kind === "surrogate") { fs.writeFileSync(target, "😀hello\n"); invalid = { ...edit, range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } } }; }
  else invalid = { ...edit, range: { start: { line: 0, character: 0 }, end: { line: 99, character: 0 } } };
  const before = fs.readFileSync(target);
  await assert.rejects(applyWorkspaceEdit({ changes: { [fileUri(first)]: [edit], [fileUri(target)]: [invalid] } }, root));
  assert.strictEqual(fs.readFileSync(first, "utf8"), "hello\n");
  assert.deepStrictEqual(fs.readFileSync(target), before);
};
  test("workspace edit: validate all targets before any writes (%s)".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("workspace edit: preserve mode, BOM and CRLF", async () => {
  const { root, first, edit } = fixture(); fs.writeFileSync(first, "\uFEFFhello\r\n"); fs.chmodSync(first, 0o640);
  await applyWorkspaceEdit({ changes: { [fileUri(first)]: [{ ...edit, range: { start: { line: 0, character: 1 }, end: { line: 0, character: 6 } } }] } }, root);
  assert.strictEqual(fs.readFileSync(first, "utf8"), "\uFEFFupdated\r\n");
  if (process.platform !== "win32") assert.strictEqual(fs.statSync(first).mode & 0o777, 0o640);
});
test("resource operations: reject creates and preserve the source edit when remapping", () => {
  assert.throws(() => textChanges({ documentChanges: [{ kind: "create", uri: "file:///new" }] }), (error) => error instanceof Error && error.message.includes(String("Resource operations")));
  const original = { changes: { "file:///old": [] } };
  assert.deepStrictEqual(remapEdit(original, "file:///old", "file:///new"), { changes: { "file:///new": [] } });
  assert.deepStrictEqual(original, { changes: { "file:///old": [] } });
});
test("file moves: never overwrite an existing destination", () => {
  const { first, second } = fixture(); fs.writeFileSync(second, "keep\n");
  assert.throws(() => moveNoReplace(first, second));
  assert.strictEqual(fs.readFileSync(first, "utf8"), "hello\n");
  assert.strictEqual(fs.readFileSync(second, "utf8"), "keep\n");
});
test("file rename: remapping merges edits for old and new URIs without losing either", () => {
  const first = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "first" };
  const second = { ...first, newText: "second" };
  const original = { changes: { "file:///old": [first], "file:///new": [second] } };
  assert.deepStrictEqual(remapEdit(original, "file:///old", "file:///new"), { changes: { "file:///new": [first, second] } });
  assert.deepStrictEqual(original.changes["file:///new"], [second]);
});
for (const [caseIndex, caseValue] of (["chmod", "unlink"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = (operation) => {
  const { first, second } = fixture(); fs.unlinkSync(second);
  const originalChmod = fs.chmodSync, originalUnlink = fs.unlinkSync;
  const chmod = mock.method(fs, "chmodSync", (path: PathLike, mode: Mode) => { if (operation === "chmod" && path === second) throw new Error("injected chmod failure"); originalChmod(path, mode); });
  const unlink = mock.method(fs, "unlinkSync", (path: PathLike) => { if (operation === "unlink" && path === first) throw new Error("injected unlink failure"); originalUnlink(path); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => moveNoReplace(first, second), (error) => error instanceof Error && error.message.includes(String(`injected ${operation} failure`)));
    assert.strictEqual(fs.readFileSync(first, "utf8"), "hello\n"); assert.strictEqual(fs.existsSync(second), false);
  } finally { chmod.mock.restore(); unlink.mock.restore(); syncBuiltinESMExports(); }
};
  test("file moves: %s failure preserves the source and cleans up the destination".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
for (const [caseIndex, caseValue] of (["write", "fsync", "mode"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = (operation) => {
  const { root, first } = fixture(), write = fs.writeFileSync, fsync = fs.fsyncSync, mode = fs.fchmodSync;
  const writeFault = mock.method(fs, "writeFileSync", ((file: PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: WriteFileOptions) => {
    if (operation === "write" && typeof file === "number") { write(file, "partial"); throw new Error("injected write failure"); }
    write(file, data, options);
  }) as typeof fs.writeFileSync);
  const syncFault = mock.method(fs, "fsyncSync", (fd: number) => { if (operation === "fsync") throw new Error("injected fsync failure"); fsync(fd); });
  const modeFault = mock.method(fs, "fchmodSync", (fd: number, value: number) => { if (operation === "mode") throw new Error("injected mode failure"); mode(fd, value); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => atomicWrite(first, Buffer.from("new contents")), (error) => error instanceof Error && error.message.includes(String(`injected ${operation} failure`)));
    assert.strictEqual(fs.readFileSync(first, "utf8"), "hello\n"); assert.deepStrictEqual(fs.readdirSync(root).sort(), ["first.txt", "second.txt"]);
  } finally { writeFault.mock.restore(); syncFault.mock.restore(); modeFault.mock.restore(); syncBuiltinESMExports(); }
};
  test("atomic write: %s failure leaves the original intact and removes partial temporary files".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("workspace edit: no-op changes never replace files", async () => {
  const { root, first, edit } = fixture();
  renameFault = () => { throw new Error("No-op must not write"); };
  assert.strictEqual((await applyWorkspaceEdit({ changes: { [fileUri(first)]: [{ ...edit, newText: "hello" }] } }, root)).size, 0);
  assert.strictEqual(fs.readFileSync(first, "utf8"), "hello\n");
});
