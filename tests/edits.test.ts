import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite, applyWorkspaceEdit, moveNoReplace, remapEdit, textChanges } from "../src/edits.ts";
import { fileUri } from "../src/config.ts";
import type { TextEdit } from "../src/omp/types.ts";

const roots: string[] = [];
const originalRename = fs.renameSync;
let renameFault: typeof fs.renameSync | undefined;
const renameSpy = spyOn(fs, "renameSync").mockImplementation((source, target) => (renameFault ?? originalRename)(source, target));
afterAll(() => renameSpy.mockRestore());
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
  expect(() => atomicWrite(first, Buffer.from("new"))).toThrow("injected rename failure");
  expect(trace).toEqual([first]);
  expect(fs.readFileSync(first, "utf8")).toBe("hello\n");
  expect(fs.readdirSync(root).sort()).toEqual(["first.txt", "second.txt"]);
});
test("workspace edit: a later write failure rolls earlier writes back", async () => {
  const { root, first, second, changes } = fixture(), rename = originalRename, trace: string[] = [];
  renameFault = (source, target) => {
    trace.push(String(target));
    if (target === second) throw new Error("injected disk failure");
    return rename(source, target);
  };
  await expect(applyWorkspaceEdit({ changes }, root)).rejects.toThrow("injected disk failure");
  expect(trace).toEqual([first, second, first]);
  expect(fs.readFileSync(first, "utf8")).toBe("hello\n");
  expect(fs.readFileSync(second, "utf8")).toBe("hello\n");
  expect(fs.readdirSync(root).length).toBe(2);
});
test("workspace edit: rollback preserves an external edit made during failure", async () => {
  const { root, first, second, changes } = fixture(), rename = originalRename;
  renameFault = (source, target) => {
    if (target === second) { fs.writeFileSync(first, "external edit\n"); throw new Error("injected disk failure"); }
    return rename(source, target);
  };
  await expect(applyWorkspaceEdit({ changes }, root)).rejects.toThrow("rollback failed");
  expect(fs.readFileSync(first, "utf8")).toBe("external edit\n");
  expect(fs.readFileSync(second, "utf8")).toBe("hello\n");
});
test("workspace edit: detect an external edit before writing a later file", async () => {
  const { root, first, second, changes } = fixture(), rename = originalRename;
  renameFault = (source, target) => {
    rename(source, target);
    if (target === first) fs.writeFileSync(second, "external edit\n");
  };
  await expect(applyWorkspaceEdit({ changes }, root)).rejects.toThrow("File changed");
  expect(fs.readFileSync(first, "utf8")).toBe("hello\n");
  expect(fs.readFileSync(second, "utf8")).toBe("external edit\n");
});
test.each(["outside", "symlink", "invalid UTF-8", "surrogate", "invalid range"])("workspace edit: validate all targets before any writes (%s)", async (kind) => {
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
  await expect(applyWorkspaceEdit({ changes: { [fileUri(first)]: [edit], [fileUri(target)]: [invalid] } }, root)).rejects.toThrow();
  expect(fs.readFileSync(first, "utf8")).toBe("hello\n");
  expect(fs.readFileSync(target)).toEqual(before);
});
test("workspace edit: preserve mode, BOM and CRLF", async () => {
  const { root, first, edit } = fixture(); fs.writeFileSync(first, "\uFEFFhello\r\n"); fs.chmodSync(first, 0o640);
  await applyWorkspaceEdit({ changes: { [fileUri(first)]: [{ ...edit, range: { start: { line: 0, character: 1 }, end: { line: 0, character: 6 } } }] } }, root);
  expect(fs.readFileSync(first, "utf8")).toBe("\uFEFFupdated\r\n");
  if (process.platform !== "win32") expect(fs.statSync(first).mode & 0o777).toBe(0o640);
});
test("resource operations: reject creates and preserve the source edit when remapping", () => {
  expect(() => textChanges({ documentChanges: [{ kind: "create", uri: "file:///new" }] })).toThrow("Resource operations");
  const original = { changes: { "file:///old": [] } };
  expect(remapEdit(original, "file:///old", "file:///new")).toEqual({ changes: { "file:///new": [] } });
  expect(original).toEqual({ changes: { "file:///old": [] } });
});
test("file moves: never overwrite an existing destination", () => {
  const { first, second } = fixture(); fs.writeFileSync(second, "keep\n");
  expect(() => moveNoReplace(first, second)).toThrow();
  expect(fs.readFileSync(first, "utf8")).toBe("hello\n");
  expect(fs.readFileSync(second, "utf8")).toBe("keep\n");
});
test("file rename: remapping merges edits for old and new URIs without losing either", () => {
  const first = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "first" };
  const second = { ...first, newText: "second" };
  const original = { changes: { "file:///old": [first], "file:///new": [second] } };
  expect(remapEdit(original, "file:///old", "file:///new")).toEqual({ changes: { "file:///new": [first, second] } });
  expect(original.changes["file:///new"]).toEqual([second]);
});
test.each(["chmod", "unlink"])("file moves: %s failure preserves the source and cleans up the destination", (operation) => {
  const { first, second } = fixture(); fs.unlinkSync(second);
  const originalChmod = fs.chmodSync, originalUnlink = fs.unlinkSync;
  const chmod = spyOn(fs, "chmodSync").mockImplementation((path, mode) => { if (operation === "chmod" && path === second) throw new Error("injected chmod failure"); originalChmod(path, mode); });
  const unlink = spyOn(fs, "unlinkSync").mockImplementation((path) => { if (operation === "unlink" && path === first) throw new Error("injected unlink failure"); originalUnlink(path); });
  try {
    expect(() => moveNoReplace(first, second)).toThrow(`injected ${operation} failure`);
    expect(fs.readFileSync(first, "utf8")).toBe("hello\n"); expect(fs.existsSync(second)).toBe(false);
  } finally { chmod.mockRestore(); unlink.mockRestore(); }
});
test.each(["write", "fsync", "mode"])("atomic write: %s failure leaves the original intact and removes partial temporary files", (operation) => {
  const { root, first } = fixture(), write = fs.writeFileSync, fsync = fs.fsyncSync, mode = fs.fchmodSync;
  const writeFault = spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
    if (operation === "write" && typeof file === "number") { write(file, "partial"); throw new Error("injected write failure"); }
    write(file, data, options);
  }) as typeof fs.writeFileSync);
  const syncFault = spyOn(fs, "fsyncSync").mockImplementation((fd) => { if (operation === "fsync") throw new Error("injected fsync failure"); fsync(fd); });
  const modeFault = spyOn(fs, "fchmodSync").mockImplementation((fd, value) => { if (operation === "mode") throw new Error("injected mode failure"); mode(fd, value); });
  try {
    expect(() => atomicWrite(first, Buffer.from("new contents"))).toThrow(`injected ${operation} failure`);
    expect(fs.readFileSync(first, "utf8")).toBe("hello\n"); expect(fs.readdirSync(root).sort()).toEqual(["first.txt", "second.txt"]);
  } finally { writeFault.mockRestore(); syncFault.mockRestore(); modeFault.mockRestore(); }
});
test("workspace edit: no-op changes never replace files", async () => {
  const { root, first, edit } = fixture();
  renameFault = () => { throw new Error("No-op must not write"); };
  expect((await applyWorkspaceEdit({ changes: { [fileUri(first)]: [{ ...edit, newText: "hello" }] } }, root)).size).toBe(0);
  expect(fs.readFileSync(first, "utf8")).toBe("hello\n");
});
