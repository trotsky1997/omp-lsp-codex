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
