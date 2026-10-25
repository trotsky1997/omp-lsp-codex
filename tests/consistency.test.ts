import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import { run } from "../src/commands.ts";
import { LspClient } from "../src/client.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";
import { fileUri, type Server } from "../src/config.ts";

let restore: () => void;
beforeAll(() => { restore = isolateGlobalConfig(); });
afterAll(() => restore());
afterEach(async () => {
  const leaked = LspClient.active.size;
  await Promise.all([...LspClient.active].map((client) => client.close()));
  cleanWorkspaces();
  expect(leaked).toBe(0);
});
const replacement = { range, newText: "renamed" };

test.each(["rename", "code-actions", "request", "rename-file"])("consistency: %s preserves a file modified after LSP analysis", async (command) => {
  const w = workspace(), edit = { changes: { [w.uri]: [replacement] } };
  const method = command === "rename" ? "textDocument/rename" : command === "code-actions" ? "textDocument/codeAction" : command === "rename-file" ? "workspace/willRenameFiles" : "fixture/edit";
  w.setScenario({ beforeResponse: { [method]: { file: w.file, text: "external change\n" } }, responses: { [method]: command === "code-actions" ? [{ title: "Fix", edit }] : edit } });
  const flags = command === "code-actions" ? ["--query", "0"] : command === "request" ? ["--method", method] : ["--new-name", command === "rename-file" ? "renamed.fixture" : "renamed"];
  await expect(run(w.args(command, "--apply", ...flags))).rejects.toThrow("changed since");
  expect(readFileSync(w.file, "utf8")).toBe("external change\n");
  expect(existsSync(join(w.root, "renamed.fixture"))).toBe(false);
});
test.each([0, 2, -1, "1", null])("diagnostic versions: version %s cannot verify the opened version 1", async (version) => {
  const w = workspace({ diagnosticVersion: version });
  expect((await run(w.args("diagnostics"))).data).toMatchObject({ success: false, verified: false });
});
test.each([undefined, 1])("diagnostic versions: optional/current version %s remains supported", async (version) => {
  const w = workspace(version === undefined ? {} : { diagnosticVersion: version });
  expect((await run(w.args("diagnostics"))).data).toMatchObject({ success: true, verified: true });
});
test.each([0, 2])("edit versions: stale/future version %s cannot change a file", async (version) => {
  const w = workspace(); w.setScenario({ responses: { "textDocument/rename": { documentChanges: [{ textDocument: { uri: w.uri, version }, edits: [replacement] }] } } });
  await expect(run(w.args("rename", "--new-name", "renamed", "--apply"))).rejects.toThrow("version");
  expect(readFileSync(w.file, "utf8")).toBe("value = 1\n");
});
test.each([null, 1])("edit versions: null/current version %s remains supported", async (version) => {
  const w = workspace(); w.setScenario({ responses: { "textDocument/rename": { documentChanges: [{ textDocument: { uri: w.uri, version }, edits: [replacement] }] } } });
  expect((await run(w.args("rename", "--new-name", "renamed", "--apply"))).data.applied).toBe(true);
  expect(readFileSync(w.file, "utf8")).toBe("renamed = 1\n");
});
test("edit versions: a versioned edit for an unopened document fails before any writes", async () => {
  const w = workspace(), other = join(w.root, "other.fixture"); writeFileSync(other, "value = 2\n");
  w.setScenario({ responses: { "textDocument/rename": { documentChanges: [{ textDocument: { uri: w.uri, version: 1 }, edits: [replacement] }, { textDocument: { uri: fileUri(other), version: 1 }, edits: [replacement] }] } } });
  await expect(run(w.args("rename", "--new-name", "renamed", "--apply"))).rejects.toThrow("version");
  expect(readFileSync(w.file, "utf8")).toBe("value = 1\n"); expect(readFileSync(other, "utf8")).toBe("value = 2\n");
});
test("partial code actions: a command failure identifies edits already applied", async () => {
  const w = workspace(); w.setScenario({ responses: { "textDocument/codeAction": [{ title: "Fix", edit: { changes: { [w.uri]: [replacement] } }, command: { title: "Follow up", command: "fixture.fail" } }] }, errors: { "workspace/executeCommand": { code: -32603, message: "injected command failure" } } });
  await expect(run(w.args("code-actions", "--apply", "--query", "0"))).rejects.toThrow("after applying edits");
  expect(readFileSync(w.file, "utf8")).toBe("renamed = 1\n");
});
test("diagnostic versions: an older report cannot replace a current report", async () => {
  const w = workspace(), server: Server = { ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath };
  const client = await LspClient.start(server, 400);
  try {
    await client.open(w.file);
    const diagnostics = [{ message: "current error", range, severity: 1 as const }];
    await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri: w.uri, version: 1, diagnostics } });
    await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri: w.uri, version: 0, diagnostics: [] } });
    expect(await client.getDiagnostics(w.uri)).toEqual({ diagnostics, verified: true });
  } finally { await client.close(); }
});
test.each([1, 2, { change: 2 }])("edit synchronization: sync=%j updates versions and sends a valid change", async (sync) => {
  const w = workspace({ capabilities: { textDocumentSync: sync } }); writeFileSync(w.file, "😀value = 1\r\nlast");
  const client = await LspClient.start({ ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath }, 400, true);
  try {
    await client.open(w.file); await client.waitDiagnostics(w.uri);
    const range = { start: { line: 0, character: 2 }, end: { line: 0, character: 7 } };
    expect(await client.edit({ documentChanges: [{ textDocument: { uri: w.uri, version: 1 }, edits: [{ range, newText: "renamed" }] }] })).toBe(true);
    expect(client.documents.get(w.uri)).toEqual({ text: "😀renamed = 1\r\nlast", version: 2 });
    expect(client.diagnostics.has(w.uri)).toBe(false);
    await client.request("fixture/echo", {});
    const event = w.events().find((e) => e.method === "textDocument/didChange") as { params: { textDocument: unknown; contentChanges: { range?: unknown; text: string }[] } } | undefined;
    expect(event?.params.textDocument).toEqual({ uri: w.uri, version: 2 });
    expect(event?.params.contentChanges[0].text).toBe("😀renamed = 1\r\nlast");
    expect(event?.params.contentChanges[0].range).toEqual(sync === 1 ? undefined : { start: { line: 0, character: 0 }, end: { line: 1, character: 4 } });
  } finally { await client.close(); }
});
test("edit synchronization: read-only clients reject edits before writing", async () => {
  const w = workspace(), client = await LspClient.start({ ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath }, 400);
  try {
    await client.open(w.file);
    await expect(client.edit({ changes: { [w.uri]: [replacement] } })).rejects.toThrow("read-only");
    expect(readFileSync(w.file, "utf8")).toBe("value = 1\n");
  } finally { await client.close(); }
});
test("edit synchronization: no-op edits preserve versions and send no change", async () => {
  const w = workspace(), client = await LspClient.start({ ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath }, 400, true);
  try {
    await client.open(w.file); await client.waitDiagnostics(w.uri);
    expect(await client.edit({ changes: { [w.uri]: [{ range, newText: "value" }] } })).toBe(false);
    await client.request("fixture/echo", {});
    expect(client.documents.get(w.uri)?.version).toBe(1);
    expect(w.events().some((e) => e.method === "textDocument/didChange")).toBe(false);
  } finally { await client.close(); }
});
test("edit synchronization: later edits and diagnostics must match the updated version", async () => {
  const w = workspace(), client = await LspClient.start({ ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath }, 400, true);
  try {
    await client.open(w.file); await client.waitDiagnostics(w.uri); await client.edit({ changes: { [w.uri]: [replacement] } });
    await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri: w.uri, version: 1, diagnostics: [] } });
    expect(client.diagnostics.has(w.uri)).toBe(false);
    const edit = { documentChanges: [{ textDocument: { uri: w.uri, version: 1 }, edits: [{ range: { start: range.start, end: { line: 0, character: 7 } }, newText: "again" }] }] };
    await expect(client.edit(edit)).rejects.toThrow("version");
    edit.documentChanges[0].textDocument.version = 2; await client.edit(edit);
    expect(readFileSync(w.file, "utf8")).toBe("again = 1\n"); expect(client.documents.get(w.uri)?.version).toBe(3);
    await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri: w.uri, version: 3, diagnostics: [] } });
    expect(await client.getDiagnostics(w.uri)).toEqual({ diagnostics: [], verified: true });
  } finally { await client.close(); }
});
test("edit synchronization: a notification failure reports completed writes", async () => {
  const w = workspace(), client = await LspClient.start({ ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath }, 400, true);
  await client.open(w.file); await client.waitDiagnostics(w.uri);
  const notify = client.notify.bind(client), fault = spyOn(client, "notify").mockImplementation((method, params) => method === "textDocument/didChange" ? Promise.reject(new Error("injected notification failure")) : notify(method, params));
  try {
    await expect(client.edit({ changes: { [w.uri]: [replacement] } })).rejects.toThrow("Edits applied");
    expect(readFileSync(w.file, "utf8")).toBe("renamed = 1\n");
  } finally { fault.mockRestore(); await client.close(); }
});
test("raw request: a failure after a successful callback identifies completed edits", async () => {
  const w = workspace(); w.setScenario({ callbacks: { "fixture/edit": { method: "workspace/applyEdit", params: { edit: { changes: { [w.uri]: [replacement] } } } } }, errors: { "fixture/edit": { code: -32603, message: "injected callback command failure" } } });
  await expect(run(w.args("request", "--apply", "--method", "fixture/edit"))).rejects.toThrow("after applying edits");
  expect(readFileSync(w.file, "utf8")).toBe("renamed = 1\n");
});
test("code action: rejected callback edits remain visible even if the command returns success", async () => {
  const w = workspace(); w.setScenario({ responses: { "textDocument/codeAction": [{ title: "Fix", command: "fixture.fix" }] }, beforeResponse: { "workspace/executeCommand": { file: w.file, text: "external change\n" } }, callbacks: { "workspace/executeCommand": { method: "workspace/applyEdit", params: { edit: { changes: { [w.uri]: [replacement] } } } } } });
  await expect(run(w.args("code-actions", "--apply", "--query", "0"))).rejects.toThrow("changed since");
  expect(readFileSync(w.file, "utf8")).toBe("external change\n");
});
test.each([0, 1])("file rename: document edit version %s survives URI remapping", async (version) => {
  const w = workspace(), dest = join(w.root, "renamed.fixture");
  w.setScenario({ responses: { "workspace/willRenameFiles": { documentChanges: [{ textDocument: { uri: w.uri, version }, edits: [replacement] }] } } });
  if (version === 0) {
    await expect(run(w.args("rename-file", "--apply", "--new-name", dest))).rejects.toThrow("version");
    expect(readFileSync(w.file, "utf8")).toBe("value = 1\n"); expect(existsSync(dest)).toBe(false);
  } else {
    expect((await run(w.args("rename-file", "--apply", "--new-name", dest))).data.applied).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe("renamed = 1\n");
  }
});
test("file rename: inconsistent snapshots across servers fail without overwriting the new content", async () => {
  const w = workspace();
  w.setScenario({ beforeResponse: { "workspace/willRenameFiles": { file: w.file, text: "external change\n" } }, responses: { "workspace/willRenameFiles": { changes: { [w.uri]: [replacement] } } } });
  const empty = join(w.root, "secondary.json"); writeFileSync(empty, "{}");
  w.configs.secondary = { ...w.configs.fixture, args: [...w.configs.fixture.args!.slice(0, -1), empty] }; w.saveConfig();
  await expect(run(w.args("rename-file", "--apply", "--new-name", "renamed.fixture"))).rejects.toThrow("changed since");
  expect(readFileSync(w.file, "utf8")).toBe("external change\n"); expect(existsSync(join(w.root, "renamed.fixture"))).toBe(false);
});
test("file rename: a failed notification reports the completed move", async () => {
  const w = workspace(), dest = join(w.root, "renamed.fixture"), notify = LspClient.prototype.notify;
  const fault = spyOn(LspClient.prototype, "notify").mockImplementation(function (this: LspClient, method, params) { return method === "workspace/didRenameFiles" ? Promise.reject(new Error("injected rename notification failure")) : notify.call(this, method, params); });
  try {
    await expect(run(w.args("rename-file", "--apply", "--new-name", dest))).rejects.toThrow("File renamed and edits applied");
    expect(existsSync(w.file)).toBe(false); expect(readFileSync(dest, "utf8")).toBe("value = 1\n");
  } finally { fault.mockRestore(); }
});
test("file rename: rollback conflicts preserve both files and identify the failure", async () => {
  const w = workspace(), dest = join(w.root, "renamed.fixture"), copy = fs.copyFileSync;
  w.setScenario({ responses: { "workspace/willRenameFiles": { changes: { [w.uri]: [{ ...replacement, range: { start: { line: 90, character: 0 }, end: { line: 90, character: 1 } } }] } } } });
  const fault = spyOn(fs, "copyFileSync").mockImplementation((source, target, mode) => { if (source === dest && target === w.file) writeFileSync(w.file, "new external file\n"); copy(source, target, mode); });
  try {
    await expect(run(w.args("rename-file", "--apply", "--new-name", dest))).rejects.toThrow("file rename rollback failed");
    expect(readFileSync(w.file, "utf8")).toBe("new external file\n"); expect(readFileSync(dest, "utf8")).toBe("value = 1\n");
  } finally { fault.mockRestore(); }
});
test("diagnostics: files modified after didOpen cannot receive a verified clean result", async () => {
  const w = workspace(); w.setScenario({ diagnosticVersion: 1, afterOpen: { file: w.file, text: "external change\n" } });
  expect((await run(w.args("diagnostics"))).data).toMatchObject({ success: false, verified: false });
  expect(readFileSync(w.file, "utf8")).toBe("external change\n");
});
test("diagnostic versions: malformed metadata invalidates a previously valid report", async () => {
  const w = workspace(), client = await LspClient.start({ ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath }, 100);
  try {
    await client.open(w.file); await client.waitDiagnostics(w.uri);
    await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri: w.uri, version: "1", diagnostics: [] } });
    expect(await client.getDiagnostics(w.uri)).toEqual({ diagnostics: [], verified: false });
  } finally { await client.close(); }
});
