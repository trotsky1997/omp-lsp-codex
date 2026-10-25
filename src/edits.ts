import {
  chmodSync,
  closeSync,
  copyFileSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { inside, MAX_FILE_BYTES, uriFile } from "./config.ts";
import { applyTextEditsToString } from "./omp/text-edits.ts";
import type { Position, TextEdit, WorkspaceEdit } from "./omp/types.ts";

export function atomicWrite(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  try {
    const fd = openSync(temp, "wx", mode);
    try {
      fchmodSync(fd, mode);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}
export function textChanges(edit: WorkspaceEdit): Map<string, TextEdit[]> {
  const changes = new Map<string, TextEdit[]>();
  for (const [uri, items] of Object.entries(edit.changes ?? {})) changes.set(uri, [...items]);
  for (const change of edit.documentChanges ?? []) {
    if (!("textDocument" in change))
      throw new Error("Resource operations are not supported by this CLI");
    const uri = change.textDocument.uri;
    changes.set(uri, [...(changes.get(uri) ?? []), ...change.edits]);
  }
  return changes;
}
export function editSummary(edit: WorkspaceEdit): string[] {
  const changes = textChanges(edit);
  const lines = [
    `${changes.size} file(s), ${[...changes.values()].reduce((n, items) => n + items.length, 0)} edit(s)`,
  ];
  for (const [uri, edits] of changes)
    for (const edit of edits) {
      const { start, end } = edit.range;
      lines.push(
        `${uriFile(uri) ?? uri}:${start.line + 1}:${start.character + 1}-${end.line + 1}:${end.character + 1} → ${JSON.stringify(edit.newText)}`,
      );
    }
  return lines;
}
function validatePosition(lines: string[], pos: Position): void {
  if (
    !pos ||
    !Number.isInteger(pos.line) ||
    !Number.isInteger(pos.character) ||
    pos.line < 0 ||
    pos.line >= lines.length ||
    pos.character < 0 ||
    pos.character > lines[pos.line].length
  )
    throw new Error("Invalid LSP edit range");
  const unit = lines[pos.line].charCodeAt(pos.character);
  if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error("LSP edit splits a UTF-16 surrogate pair");
}
export async function applyWorkspaceEdit(edit: WorkspaceEdit, root: string): Promise<void> {
  const planned: { path: string; original: Buffer; updated: Buffer }[] = [];
  for (const [uri, edits] of textChanges(edit)) {
    const target = uriFile(uri);
    if (!target) throw new Error(`Unsupported edit URI: ${uri}`);
    const path = realpathSync(target),
      info = statSync(path);
    if (!inside(realpathSync(root), path))
      throw new Error(`Edit is outside the workspace: ${path}`);
    if (!info.isFile() || info.size > MAX_FILE_BYTES)
      throw new Error(`Unsupported edit target: ${path}`);
    const original = readFileSync(path),
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original);
    const lines = text.split("\n");
    for (const item of edits) {
      validatePosition(lines, item.range?.start);
      validatePosition(lines, item.range?.end);
      const { start, end } = item.range;
      if (
        start.line > end.line ||
        (start.line === end.line && start.character > end.character) ||
        typeof item.newText !== "string"
      )
        throw new Error("Invalid LSP text edit");
    }
    planned.push({ path, original, updated: Buffer.from(applyTextEditsToString(text, edits)) });
  }
  const written: typeof planned = [];
  try {
    for (const item of planned) {
      if (!readFileSync(item.path).equals(item.original))
        throw new Error(`File changed before applying edits: ${item.path}`);
      atomicWrite(item.path, item.updated);
      written.push(item);
    }
  } catch (error) {
    const failures: string[] = [];
    for (const item of written.reverse()) {
      try {
        atomicWrite(item.path, item.original);
      } catch {
        failures.push(item.path);
      }
    }
    if (failures.length) throw new Error(`${error}; rollback failed for ${failures.join(", ")}`);
    throw error;
  }
}
export function moveNoReplace(source: string, destination: string): void {
  let created = false;
  try {
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    created = true;
    chmodSync(destination, statSync(source).mode & 0o777);
    unlinkSync(source);
  } catch (error) {
    if (created && existsSync(source)) unlinkSync(destination);
    throw error;
  }
}
export function remapEdit(edit: WorkspaceEdit, oldUri: string, newUri: string): WorkspaceEdit {
  const result = structuredClone(edit);
  if (result.changes?.[oldUri]) {
    result.changes[newUri] = result.changes[oldUri];
    delete result.changes[oldUri];
  }
  for (const change of result.documentChanges ?? [])
    if ("textDocument" in change && change.textDocument.uri === oldUri)
      change.textDocument.uri = newUri;
  return result;
}
