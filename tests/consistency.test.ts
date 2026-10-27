import assert from "node:assert/strict";
import { after, afterEach, before, test, mock } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import type { PathLike } from "node:fs";
import { join } from "node:path";
import { run } from "../src/commands.ts";
import { LspClient } from "../src/client.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";
import { fileUri, type Server } from "../src/config.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); });
after(() => restore());
afterEach(async () => {
  const leaked = LspClient.active.size;
  await Promise.all([...LspClient.active].map((client) => client.close()));
  cleanWorkspaces();
  assert.strictEqual(leaked, 0);
});
const replacement = { range, newText: "renamed" };

for (const [caseIndex, caseValue] of (["rename", "code-actions", "request", "rename-file"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (command) => {
  const w = workspace(), edit = { changes: { [w.uri]: [replacement] } };
  const method = command === "rename" ? "textDocument/rename" : command === "code-actions" ? "textDocument/codeAction" : command === "rename-file" ? "workspace/willRenameFiles" : "fixture/edit";
  w.setScenario({ beforeResponse: { [method]: { file: w.file, text: "external change\n" } }, responses: { [method]: command === "code-actions" ? [{ title: "Fix", edit }] : edit } });
  const flags = command === "code-actions" ? ["--query", "0"] : command === "request" ? ["--method", method] : ["--new-name", command === "rename-file" ? "renamed.fixture" : "renamed"];
  await assert.rejects(run(w.args(command, "--apply", ...flags)), (error) => error instanceof Error && error.message.includes(String("changed since")));
  assert.strictEqual(readFileSync(w.file, "utf8"), "external change\n");
  assert.strictEqual(existsSync(join(w.root, "renamed.fixture")), false);
};
  test("consistency: %s preserves a file modified after LSP analysis".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
for (const [caseIndex, caseValue] of ([0, 2, -1, "1", null]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (version) => {
  const w = workspace({ diagnosticVersion: version });
  assert.partialDeepStrictEqual((await run(w.args("diagnostics"))).data, { success: false, verified: false });
};
  test("diagnostic versions: version %s cannot verify the opened version 1".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
for (const [caseIndex, caseValue] of ([undefined, 1]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (version) => {
  const w = workspace(version === undefined ? {} : { diagnosticVersion: version });
  assert.partialDeepStrictEqual((await run(w.args("diagnostics"))).data, { success: true, verified: true });
};
  test("diagnostic versions: optional/current version %s remains supported".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
for (const [caseIndex, caseValue] of ([0, 2]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (version) => {
  const w = workspace(); w.setScenario({ responses: { "textDocument/rename": { documentChanges: [{ textDocument: { uri: w.uri, version }, edits: [replacement] }] } } });
  await assert.rejects(run(w.args("rename", "--new-name", "renamed", "--apply")), (error) => error instanceof Error && error.message.includes(String("version")));
  assert.strictEqual(readFileSync(w.file, "utf8"), "value = 1\n");
};
  test("edit versions: stale/future version %s cannot change a file".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
for (const [caseIndex, caseValue] of ([null, 1]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (version) => {
  const w = workspace(); w.setScenario({ responses: { "textDocument/rename": { documentChanges: [{ textDocument: { uri: w.uri, version }, edits: [replacement] }] } } });
  assert.strictEqual((await run(w.args("rename", "--new-name", "renamed", "--apply"))).data.applied, true);
  assert.strictEqual(readFileSync(w.file, "utf8"), "renamed = 1\n");
};
  test("edit versions: null/current version %s remains supported".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("edit versions: a versioned edit for an unopened document fails before any writes", async () => {
  const w = workspace(), other = join(w.root, "other.fixture"); writeFileSync(other, "value = 2\n");
  w.setScenario({ responses: { "textDocument/rename": { documentChanges: [{ textDocument: { uri: w.uri, version: 1 }, edits: [replacement] }, { textDocument: { uri: fileUri(other), version: 1 }, edits: [replacement] }] } } });
  await assert.rejects(run(w.args("rename", "--new-name", "renamed", "--apply")), (error) => error instanceof Error && error.message.includes(String("version")));
  assert.strictEqual(readFileSync(w.file, "utf8"), "value = 1\n"); assert.strictEqual(readFileSync(other, "utf8"), "value = 2\n");
});
test("partial code actions: a command failure identifies edits already applied", async () => {
  const w = workspace(); w.setScenario({ responses: { "textDocument/codeAction": [{ title: "Fix", edit: { changes: { [w.uri]: [replacement] } }, command: { title: "Follow up", command: "fixture.fail" } }] }, errors: { "workspace/executeCommand": { code: -32603, message: "injected command failure" } } });
  await assert.rejects(run(w.args("code-actions", "--apply", "--query", "0")), (error) => error instanceof Error && error.message.includes(String("after applying edits")));
  assert.strictEqual(readFileSync(w.file, "utf8"), "renamed = 1\n");
});
test("diagnostic versions: an older report cannot replace a current report", async () => {
  const w = workspace(), server: Server = { ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath };
  const client = await LspClient.start(server, 400);
  try {
    await client.open(w.file);
    const diagnostics = [{ message: "current error", range, severity: 1 as const }];
    await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri: w.uri, version: 1, diagnostics } });
    await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri: w.uri, version: 0, diagnostics: [] } });
    assert.deepStrictEqual(await client.getDiagnostics(w.uri), { diagnostics, verified: true });
  } finally { await client.close(); }
});
for (const [caseIndex, caseValue] of ([1, 2, { change: 2 }]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (sync) => {
  const w = workspace({ capabilities: { textDocumentSync: sync } }); writeFileSync(w.file, "😀value = 1\r\nlast");
  const client = await LspClient.start({ ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath }, 400, true);
  try {
    await client.open(w.file); await client.waitDiagnostics(w.uri);
    const range = { start: { line: 0, character: 2 }, end: { line: 0, character: 7 } };
    assert.strictEqual(await client.edit({ documentChanges: [{ textDocument: { uri: w.uri, version: 1 }, edits: [{ range, newText: "renamed" }] }] }), true);
    assert.deepStrictEqual(client.documents.get(w.uri), { text: "😀renamed = 1\r\nlast", version: 2 });
    assert.strictEqual(client.diagnostics.has(w.uri), false);
    await client.request("fixture/echo", {});
    const event = w.events().find((e) => e.method === "textDocument/didChange") as { params: { textDocument: unknown; contentChanges: { range?: unknown; text: string }[] } } | undefined;
    assert.deepStrictEqual(event?.params.textDocument, { uri: w.uri, version: 2 });
    assert.strictEqual(event?.params.contentChanges[0].text, "😀renamed = 1\r\nlast");
    assert.deepStrictEqual(event?.params.contentChanges[0].range, sync === 1 ? undefined : { start: { line: 0, character: 0 }, end: { line: 1, character: 4 } });
  } finally { await client.close(); }
};
  test("edit synchronization: sync=%j updates versions and sends a valid change".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("edit synchronization: read-only clients reject edits before writing", async () => {
  const w = workspace(), client = await LspClient.start({ ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath }, 400);
  try {
    await client.open(w.file);
    await assert.rejects(client.edit({ changes: { [w.uri]: [replacement] } }), (error) => error instanceof Error && error.message.includes(String("read-only")));
    assert.strictEqual(readFileSync(w.file, "utf8"), "value = 1\n");
  } finally { await client.close(); }
});
test("edit synchronization: no-op edits preserve versions and send no change", async () => {
  const w = workspace(), client = await LspClient.start({ ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath }, 400, true);
  try {
    await client.open(w.file); await client.waitDiagnostics(w.uri);
    assert.strictEqual(await client.edit({ changes: { [w.uri]: [{ range, newText: "value" }] } }), false);
    await client.request("fixture/echo", {});
    assert.strictEqual(client.documents.get(w.uri)?.version, 1);
    assert.strictEqual(w.events().some((e) => e.method === "textDocument/didChange"), false);
  } finally { await client.close(); }
});
test("edit synchronization: later edits and diagnostics must match the updated version", async () => {
  const w = workspace(), client = await LspClient.start({ ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath }, 400, true);
  try {
    await client.open(w.file); await client.waitDiagnostics(w.uri); await client.edit({ changes: { [w.uri]: [replacement] } });
    await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri: w.uri, version: 1, diagnostics: [] } });
    assert.strictEqual(client.diagnostics.has(w.uri), false);
    const edit = { documentChanges: [{ textDocument: { uri: w.uri, version: 1 }, edits: [{ range: { start: range.start, end: { line: 0, character: 7 } }, newText: "again" }] }] };
    await assert.rejects(client.edit(edit), (error) => error instanceof Error && error.message.includes(String("version")));
    edit.documentChanges[0].textDocument.version = 2; await client.edit(edit);
    assert.strictEqual(readFileSync(w.file, "utf8"), "again = 1\n"); assert.strictEqual(client.documents.get(w.uri)?.version, 3);
    await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri: w.uri, version: 3, diagnostics: [] } });
    assert.deepStrictEqual(await client.getDiagnostics(w.uri), { diagnostics: [], verified: true });
  } finally { await client.close(); }
});
test("edit synchronization: a notification failure reports completed writes", async () => {
  const w = workspace(), client = await LspClient.start({ ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath }, 400, true);
  await client.open(w.file); await client.waitDiagnostics(w.uri);
  const notify = client.notify.bind(client), fault = mock.method(client, "notify", (method: string, params: unknown) => method === "textDocument/didChange" ? Promise.reject(new Error("injected notification failure")) : notify(method, params));
  try {
    await assert.rejects(client.edit({ changes: { [w.uri]: [replacement] } }), (error) => error instanceof Error && error.message.includes(String("Edits applied")));
    assert.strictEqual(readFileSync(w.file, "utf8"), "renamed = 1\n");
  } finally { fault.mock.restore(); await client.close(); }
});
test("raw request: a failure after a successful callback identifies completed edits", async () => {
  const w = workspace(); w.setScenario({ callbacks: { "fixture/edit": { method: "workspace/applyEdit", params: { edit: { changes: { [w.uri]: [replacement] } } } } }, errors: { "fixture/edit": { code: -32603, message: "injected callback command failure" } } });
  await assert.rejects(run(w.args("request", "--apply", "--method", "fixture/edit")), (error) => error instanceof Error && error.message.includes(String("after applying edits")));
  assert.strictEqual(readFileSync(w.file, "utf8"), "renamed = 1\n");
});
test("raw request: rejected callback edits fail even when the server returns success", async () => {
  const w = workspace(); w.setScenario({ beforeResponse: { "fixture/edit": { file: w.file, text: "external change\n" } }, callbacks: { "fixture/edit": { method: "workspace/applyEdit", params: { edit: { changes: { [w.uri]: [replacement] } } } } } });
  await assert.rejects(run(w.args("request", "--apply", "--method", "fixture/edit")), /changed since/);
  assert.strictEqual(readFileSync(w.file, "utf8"), "external change\n");
  assert.strictEqual((w.events().find(event => event.direction === "receive" && event.id === "server-request")?.result as { applied: boolean }).applied, false);
});
test("raw request: callback synchronization failure cannot hide completed writes", async () => {
  const w = workspace(), start = LspClient.start.bind(LspClient);
  w.setScenario({ callbacks: { "fixture/edit": { method: "workspace/applyEdit", params: { edit: { changes: { [w.uri]: [replacement] } } } } } });
  const inject = mock.method(LspClient, "start", async (...args: Parameters<typeof LspClient.start>) => {
    const client = await start(...args), notify = client.notify.bind(client);
    mock.method(client, "notify", (method: string, params: unknown) => method === "textDocument/didChange" ? Promise.reject(new Error("injected synchronization failure")) : notify(method, params));
    return client;
  });
  try { await assert.rejects(run(w.args("request", "--apply", "--method", "fixture/edit")), /Edits applied.*synchronization failed/); }
  finally { inject.mock.restore(); }
  assert.strictEqual(readFileSync(w.file, "utf8"), "renamed = 1\n");
});
test("code action: rejected callback edits remain visible even if the command returns success", async () => {
  const w = workspace(); w.setScenario({ responses: { "textDocument/codeAction": [{ title: "Fix", command: "fixture.fix" }] }, beforeResponse: { "workspace/executeCommand": { file: w.file, text: "external change\n" } }, callbacks: { "workspace/executeCommand": { method: "workspace/applyEdit", params: { edit: { changes: { [w.uri]: [replacement] } } } } } });
  await assert.rejects(run(w.args("code-actions", "--apply", "--query", "0")), (error) => error instanceof Error && error.message.includes(String("changed since")));
  assert.strictEqual(readFileSync(w.file, "utf8"), "external change\n");
});
for (const [caseIndex, caseValue] of ([0, 1]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (version) => {
  const w = workspace(), dest = join(w.root, "renamed.fixture");
  w.setScenario({ responses: { "workspace/willRenameFiles": { documentChanges: [{ textDocument: { uri: w.uri, version }, edits: [replacement] }] } } });
  if (version === 0) {
    await assert.rejects(run(w.args("rename-file", "--apply", "--new-name", dest)), (error) => error instanceof Error && error.message.includes(String("version")));
    assert.strictEqual(readFileSync(w.file, "utf8"), "value = 1\n"); assert.strictEqual(existsSync(dest), false);
  } else {
    assert.strictEqual((await run(w.args("rename-file", "--apply", "--new-name", dest))).data.applied, true);
    assert.strictEqual(readFileSync(dest, "utf8"), "renamed = 1\n");
  }
};
  test("file rename: document edit version %s survives URI remapping".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("file rename: inconsistent snapshots across servers fail without overwriting the new content", async () => {
  const w = workspace();
  w.setScenario({ beforeResponse: { "workspace/willRenameFiles": { file: w.file, text: "external change\n" } }, responses: { "workspace/willRenameFiles": { changes: { [w.uri]: [replacement] } } } });
  const empty = join(w.root, "secondary.json"); writeFileSync(empty, "{}");
  w.configs.secondary = { ...w.configs.fixture, args: [...w.configs.fixture.args!.slice(0, -1), empty] }; w.saveConfig();
  await assert.rejects(run(w.args("rename-file", "--apply", "--new-name", "renamed.fixture")), (error) => error instanceof Error && error.message.includes(String("changed since")));
  assert.strictEqual(readFileSync(w.file, "utf8"), "external change\n"); assert.strictEqual(existsSync(join(w.root, "renamed.fixture")), false);
});
test("file rename: a failed notification reports the completed move", async () => {
  const w = workspace(), dest = join(w.root, "renamed.fixture"), notify = LspClient.prototype.notify;
  const fault = mock.method(LspClient.prototype, "notify", function (this: LspClient, method: string, params: unknown) { return method === "workspace/didRenameFiles" ? Promise.reject(new Error("injected rename notification failure")) : notify.call(this, method, params); });
  try {
    await assert.rejects(run(w.args("rename-file", "--apply", "--new-name", dest)), (error) => error instanceof Error && error.message.includes(String("File renamed and edits applied")));
    assert.strictEqual(existsSync(w.file), false); assert.strictEqual(readFileSync(dest, "utf8"), "value = 1\n");
  } finally { fault.mock.restore(); }
});
test("file rename: rollback conflicts preserve both files and identify the failure", async () => {
  const w = workspace(), dest = join(w.root, "renamed.fixture"), copy = fs.copyFileSync;
  w.setScenario({ responses: { "workspace/willRenameFiles": { changes: { [w.uri]: [{ ...replacement, range: { start: { line: 90, character: 0 }, end: { line: 90, character: 1 } } }] } } } });
  const fault = mock.method(fs, "copyFileSync", (source: PathLike, target: PathLike, mode?: number) => { if (source === dest && target === w.file) writeFileSync(w.file, "new external file\n"); copy(source, target, mode); });
  syncBuiltinESMExports();
  try {
    await assert.rejects(run(w.args("rename-file", "--apply", "--new-name", dest)), (error) => error instanceof Error && error.message.includes(String("file rename rollback failed")));
    assert.strictEqual(readFileSync(w.file, "utf8"), "new external file\n"); assert.strictEqual(readFileSync(dest, "utf8"), "value = 1\n");
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
});
test("diagnostics: files modified after didOpen cannot receive a verified clean result", async () => {
  const w = workspace(); w.setScenario({ diagnosticVersion: 1, afterOpen: { file: w.file, text: "external change\n" } });
  assert.partialDeepStrictEqual((await run(w.args("diagnostics"))).data, { success: false, verified: false });
  assert.strictEqual(readFileSync(w.file, "utf8"), "external change\n");
});
test("diagnostic versions: malformed metadata invalidates a previously valid report", async () => {
  const w = workspace(), client = await LspClient.start({ ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath }, 100);
  try {
    await client.open(w.file); await client.waitDiagnostics(w.uri);
    await client.request("fixture/notification", { method: "textDocument/publishDiagnostics", params: { uri: w.uri, version: "1", diagnostics: [] } });
    assert.deepStrictEqual(await client.getDiagnostics(w.uri), { diagnostics: [], verified: false });
  } finally { await client.close(); }
});
