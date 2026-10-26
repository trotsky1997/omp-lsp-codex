import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { after, afterEach, before, test, mock } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import type { PathLike } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LspClient } from "../src/client.ts";
import { changedFiles, formatSymbols, location, run } from "../src/commands.ts";
import { fileUri, MAX_FILES, object } from "../src/config.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";

let restoreConfig: () => void;
before(() => { restoreConfig = isolateGlobalConfig(); });
after(() => restoreConfig());

afterEach(async () => {
  const leaked = LspClient.active.size;
  await Promise.all([...LspClient.active].map((c) => c.close()));
  cleanWorkspaces();
  assert.strictEqual(leaked, 0);
});
const replacement = { range, newText: "renamed" };
const method = (command: string) => `textDocument/${command}`;

for (const [caseIndex, caseValue] of (["definition", "references", "type-definition", "implementation"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (command) => {
  const w = workspace(), rpc = method(command === "type-definition" ? "typeDefinition" : command);
  w.setScenario({ responses: { [rpc]: [{ targetUri: w.uri, targetSelectionRange: range }] } });
  const { data } = await run(w.args(command, "--symbol", "value"));
  assert.strictEqual(data.found, true); assert.deepStrictEqual(data.locations, [{ file: w.file, line: 1, column: 1 }]);
  const params = object(w.events().find((e) => e.direction === "receive" && e.method === rpc)?.params);
  assert.deepStrictEqual(params.position, { line: 0, character: 0 });
  if (command === "references") assert.deepStrictEqual(params.context, { includeDeclaration: true });
};
  test("navigation: %s uses the correct request and UTF-16 position".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("navigation: ContentModified retries are bounded and recover", async () => {
  const w = workspace(); w.setScenario({ contentModified: { "textDocument/definition": 1 }, responses: { "textDocument/definition": { uri: w.uri, range } } });
  assert.strictEqual((await run(w.args("definition"))).data.found, true);
  assert.strictEqual(w.events().filter((e) => e.direction === "receive" && e.method === "textDocument/definition").length, 2);
});
test("navigation: repeated ContentModified fails without claiming an empty result", async () => {
  const w = workspace({ contentModified: { "textDocument/definition": 100 } });
  await assert.rejects(run(w.args("definition")), (error) => error instanceof Error && error.message.includes(String("Timed out")));
});
test("navigation: transient empty results exhaust the deadline; non-symbol positions can return empty", async () => {
  const w = workspace({ diagnostics: false });
  await assert.rejects(run(w.args("references")), (error) => error instanceof Error && error.message.includes(String("Timed out")));
  assert.strictEqual((await run(w.args("references", "--column", "10"))).data.found, false);
});
test("hover: nested MarkedStrings preserve code and Markdown", async () => {
  const w = workspace({ responses: { "textDocument/hover": { contents: ["text", { language: "fixture", value: "value: number" }, { kind: "markdown", value: "**doc**" }] } } });
  assert.partialDeepStrictEqual((await run(w.args("hover"))).data, { provider: "lsp", hover: "text\n\nvalue: number\n\n**doc**", found: true });
});
for (const [caseIndex, caseValue] of ([-1, 1.5, NaN, Infinity]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = (line) => {
  assert.strictEqual(location({ uri: "file:///tmp/source", range: { start: { line, character: 0 } } }), undefined);
};
  test("locations: malformed coordinate %s is discarded".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("symbols: nested document symbols and case-insensitive filters", async () => {
  const w = workspace({ responses: { "textDocument/documentSymbol": [{ name: "Outer", kind: 5, range, children: [{ name: "Value", kind: 8, selectionRange: range }] }] } });
  assert.deepStrictEqual((await run(w.args("symbols", "--query", "VALUE"))).data.symbols, [{ name: "Value", kind: 8, container: "Outer", file: w.file, line: 1, column: 1 }]);
  assert.deepStrictEqual(formatSymbols(null), []);
});
test("symbols: workspace queries seed a file and respect the output limit", async () => {
  const w = workspace(); w.setScenario({ capabilities: { workspaceSymbolProvider: true }, responses: { "workspace/symbol": Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ name: `value${i}`, location: { uri: w.uri, range } })) } });
  const result = await run(w.args("symbols", "--workspace", "--query", "value", "--limit", String(MAX_FILES)));
  assert.strictEqual((result.data.symbols as unknown[]).length, MAX_FILES); assert.deepStrictEqual(result.data.servers, ["fixture"]);
  assert.strictEqual(w.events().some((e) => e.method === "textDocument/didOpen"), true);
});
test("symbols: unsupported servers and failed queries produce useful errors", async () => {
  const w = workspace();
  await assert.rejects(run(w.args("symbols", "--workspace")), (error) => error instanceof Error && error.message.includes(String("--query")));
  await assert.rejects(run(w.args("symbols", "--workspace", "--query", "value")), (error) => error instanceof Error && error.message.includes(String("supports workspace symbols")));
  w.setScenario({ capabilities: { workspaceSymbolProvider: true }, errors: { "workspace/symbol": { code: -32603, message: "injected symbol error" } } });
  const result = await run(w.args("symbols", "--workspace", "--query", "value"));
  assert.strictEqual(result.code, 1); assert.strictEqual(result.data.success, false); assert.ok((result.human).includes("injected symbol error"));
});
for (const [caseIndex, caseValue] of ([false, true]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (apply) => {
  const w = workspace(); w.setScenario({ responses: { "textDocument/rename": { changes: { [w.uri]: [replacement] } } } });
  const result = await run(w.args("rename", "--new-name", "renamed", ...(apply ? ["--apply"] : [])));
  assert.strictEqual(result.data.applied, apply); assert.strictEqual(readFileSync(w.file, "utf8"), apply ? "renamed = 1\n" : "value = 1\n");
  assert.strictEqual("workspaceEdit" in result.data, !apply);
};
  test("rename: preview/apply=%s preserve the explicit write boundary".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("rename: empty edits and missing new names fail without changing files", async () => {
  const w = workspace();
  await assert.rejects(run(w.args("rename")), (error) => error instanceof Error && error.message.includes(String("--new-name")));
  await assert.rejects(run(w.args("rename", "--new-name", "renamed")), (error) => error instanceof Error && error.message.includes(String("no rename edits")));
  assert.strictEqual(readFileSync(w.file, "utf8"), "value = 1\n");
});
test("code actions: previews retain original indexes after filtering", async () => {
  const w = workspace({ responses: { "textDocument/codeAction": [{ title: "Other" }, { title: "Fix value", kind: "quickfix" }] } });
  assert.deepStrictEqual((await run(w.args("code-actions", "--query", "FIX"))).data.actions, [{ index: 1, title: "Fix value", kind: "quickfix" }]);
});
for (const [caseIndex, caseValue] of (["edit", "command", "nested command", "resolved edit"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (kind) => {
  const w = workspace(), edit = { changes: { [w.uri]: [replacement] } };
  const action = kind === "edit" ? { title: "Fix", edit } : kind === "command" ? { title: "Fix", command: "fixture.fix", arguments: [1] } : kind === "nested command" ? { title: "Fix", command: { title: "Fix", command: "fixture.fix", arguments: [1] } } : { title: "Fix", data: 1 };
  w.setScenario({ capabilities: { codeActionProvider: { resolveProvider: true } }, responses: { "textDocument/codeAction": [action], "codeAction/resolve": { title: "Fix", edit } } });
  assert.strictEqual((await run(w.args("code-actions", "--apply", "--query", "0"))).data.applied, true);
  if (kind.includes("edit")) assert.strictEqual(readFileSync(w.file, "utf8"), "renamed = 1\n");
  else assert.strictEqual(w.events().some((e) => e.method === "workspace/executeCommand" && object(e.params).command === "fixture.fix"), true);
};
  test("code actions: apply %s".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
for (const [caseIndex, caseValue] of (["missing query", "no match", "disabled", "empty", "resolve disabled", "command error"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (fault) => {
  const w = workspace();
  w.setScenario({ capabilities: { codeActionProvider: true }, responses: { "textDocument/codeAction": [{ title: "Fix", ...(fault === "disabled" ? { disabled: { reason: "injected disabled" } } : fault === "command error" ? { command: "fixture.fail" } : {}) }], "codeAction/resolve": { title: "Fix", ...(fault === "resolve disabled" ? { disabled: { reason: "injected resolve disabled" }, edit: { changes: { [w.uri]: [replacement] } } } : {}) } }, errors: { "workspace/executeCommand": { code: -32603, message: "injected command error" } } });
  await assert.rejects(run(w.args("code-actions", "--apply", ...(fault === "missing query" ? [] : ["--query", fault === "no match" ? "missing" : "0"]))));
  assert.strictEqual(readFileSync(w.file, "utf8"), "value = 1\n");
};
  test("code actions: %s fails and leaves the source intact".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
for (const [caseIndex, caseValue] of ([false, true]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (apply) => {
  const w = workspace(), dest = join(w.root, "renamed.fixture");
  w.setScenario({ responses: { "workspace/willRenameFiles": { changes: { [w.uri]: [replacement] } } } });
  const result = await run(w.args("rename-file", "--new-name", "renamed.fixture", ...(apply ? ["--apply"] : [])));
  assert.strictEqual(result.data.applied, apply); assert.strictEqual(existsSync(w.file), !apply); assert.strictEqual(existsSync(dest), apply);
  if (apply) { assert.strictEqual(readFileSync(dest, "utf8"), "renamed = 1\n"); assert.strictEqual(w.events().some((e) => e.method === "workspace/didRenameFiles"), true); }
};
  test("rename-file: preview/apply=%s updates imports and moves the source".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("rename-file: failed edits roll the move back; existing destinations stay intact", async () => {
  const w = workspace(), dest = join(w.root, "renamed.fixture");
  w.setScenario({ responses: { "workspace/willRenameFiles": { changes: { [w.uri]: [{ ...replacement, range: { start: { line: 90, character: 0 }, end: { line: 90, character: 1 } } }] } } } });
  await assert.rejects(run(w.args("rename-file", "--new-name", "renamed.fixture", "--apply")), (error) => error instanceof Error && error.message.includes(String("range")));
  assert.strictEqual(readFileSync(w.file, "utf8"), "value = 1\n"); assert.strictEqual(existsSync(dest), false);
  writeFileSync(dest, "keep");
  await assert.rejects(run(w.args("rename-file", "--new-name", dest, "--apply")), (error) => error instanceof Error && error.message.includes(String("Destination already exists")));
  assert.strictEqual(readFileSync(dest, "utf8"), "keep");
});
test("rename-file: unsupported methods allow a plain move; other server errors abort", async () => {
  const w = workspace({ errors: { "workspace/willRenameFiles": { code: -32601, message: "unsupported method" } } });
  assert.strictEqual((await run(w.args("rename-file", "--new-name", "renamed.fixture", "--apply"))).data.applied, true);
  const v = workspace({ errors: { "workspace/willRenameFiles": { code: -32603, message: "injected server error" } } });
  await assert.rejects(run(v.args("rename-file", "--new-name", "renamed.fixture", "--apply")), (error) => error instanceof Error && error.message.includes(String("injected server error"))); assert.strictEqual(existsSync(v.file), true);
});
test("rename-file: workspace escapes fail before moving", async () => {
  const w = workspace(), other = workspace();
  await assert.rejects(run(w.args("rename-file", "--new-name", join(other.root, "escape.fixture"), "--apply")), (error) => error instanceof Error && error.message.includes(String("inside the workspace")));
  assert.strictEqual(existsSync(w.file), true); assert.strictEqual(existsSync(join(other.root, "escape.fixture")), false);
});
test("raw requests: guard write methods and generate navigation parameters", async () => {
  const w = workspace();
  await assert.rejects(run(w.args("request")), (error) => error instanceof Error && error.message.includes(String("--method")));
  await assert.rejects(run(w.args("request", "--method", "workspace/executeCommand")), (error) => error instanceof Error && error.message.includes(String("--apply")));
  await assert.rejects(run(w.args("request", "--method", "textDocument/hover", "--payload", "{")));
  await run(w.args("request", "--method", "textDocument/references", "--symbol", "value"));
  assert.partialDeepStrictEqual(object(w.events().find((e) => e.method === "textDocument/references")?.params), { textDocument: { uri: w.uri }, position: { line: 0, character: 0 }, context: { includeDeclaration: true } });
});
test("raw requests: invalid positions close the newly opened client", async () => {
  const w = workspace();
  await assert.rejects(run(w.args("request", "--method", "textDocument/definition", "--line", "99")), (error) => error instanceof Error && error.message.includes(String("outside this file")));
  assert.strictEqual(LspClient.active.size, 0);
});
test("raw requests: explicit payloads and returned workspace edits", async () => {
  const w = workspace(); w.setScenario({ responses: { "fixture/edit": { changes: { [w.uri]: [replacement] } } } });
  const result = await run(w.args("request", "--method", "fixture/edit", "--apply", "--payload", '{"custom":true}'));
  assert.strictEqual(result.data.applied, true); assert.strictEqual(readFileSync(w.file, "utf8"), "renamed = 1\n");
  assert.deepStrictEqual(w.events().find((e) => e.method === "fixture/edit")?.params, { custom: true });
});
test("raw requests: server applyEdit callbacks honor --apply", async () => {
  const w = workspace(); w.setScenario({ callbacks: { "workspace/executeCommand": { method: "workspace/applyEdit", params: { edit: { changes: { [w.uri]: [replacement] } } } } } });
  assert.strictEqual((await run(w.args("request", "--method", "workspace/executeCommand", "--apply"))).data.applied, true);
  assert.strictEqual(readFileSync(w.file, "utf8"), "renamed = 1\n");
});
test("status, capabilities and doctor use the selected project server", async () => {
  const w = workspace({ capabilities: { hoverProvider: true } });
  const args = w.args("status");
  assert.partialDeepStrictEqual((await run(args)).data.servers, [{ name: "fixture", root: w.root, command: process.execPath }]);
  assert.deepStrictEqual((await run({ ...args, command: "capabilities" })).data.servers, [{ name: "fixture", capabilities: { hoverProvider: true } }]);
  assert.strictEqual((await run({ ...args, command: "doctor" })).data.success, true);
  w.configs.fixture.command = join(w.root, "missing-server"); w.saveConfig();
  const missing = await run(w.args("doctor")); assert.strictEqual(missing.code, 1); assert.partialDeepStrictEqual(missing.data.servers, [{ name: "fixture", status: "missing" }]);
});
test("setup: language lists register absolute executables while preserving settings and unrelated entries", async () => {
  const w = workspace(); w.configs.fixture.settings = { custom: true }; w.saveConfig();
  const before = JSON.parse(readFileSync(w.configPath, "utf8"));
  const result = await run({ ...w.args("setup", "--project"), languages: ["fixture， .fixture, fixture"] });
  assert.strictEqual(result.data.path, w.configPath); assert.deepStrictEqual(result.data.servers, { fixture: process.execPath });
  const after = JSON.parse(readFileSync(w.configPath, "utf8"));
  assert.deepStrictEqual(after.servers.fixture.settings, { custom: true }); assert.deepStrictEqual(after.servers.pyright, before.servers.pyright);
});
test("setup: missing servers return platform install guidance without partial writes", async () => {
  const w = workspace(); w.configs.fixture.command = "codex-lsp-nonexistent-fixture-bin";
  w.configs.fixture.setup = { install: { [process.platform]: ["install fixture-server", "configure fixture-server"] }, docs: "https://example.org/fixture-docs" }; w.saveConfig();
  const before = readFileSync(w.configPath);
  await assert.rejects(run({ ...w.args("setup", "--project"), languages: ["fixture"] }), (error) => error instanceof Error && error.message.includes(String(`Install commands (${process.platform})`)));
  await assert.rejects(run({ ...w.args("setup", "--project"), languages: ["fixture"] }), (error) => error instanceof Error && error.message.includes(String("https://example.org/fixture-docs")));
  assert.deepStrictEqual(readFileSync(w.configPath), before);
  await assert.rejects(run({ ...w.args("setup"), languages: [] }), (error) => error instanceof Error && error.message.includes(String("Provide languages")));
  await assert.rejects(run({ ...w.args("setup"), languages: ["unknown-language"] }), (error) => error instanceof Error && error.message.includes(String("No bundled language server")));
});
test("diagnostics: clean, error and unverified reports preserve exit semantics", async () => {
  const w = workspace(); assert.partialDeepStrictEqual((await run(w.args("diagnostics"))).data, { success: true, verified: true, hasErrors: false });
  w.setScenario({ diagnostics: [{ message: "type error", range }] });
  const errors = await run(w.args("diagnostics")); assert.strictEqual(errors.code, 1); assert.partialDeepStrictEqual(errors.data, { success: false, verified: true, hasErrors: true });
  w.setScenario({ diagnostics: false });
  const unchecked = await run(w.args("diagnostics")); assert.strictEqual(unchecked.code, 1); assert.strictEqual(unchecked.data.verified, false);
  await assert.rejects(run(w.args("diagnostics", "--changed")), (error) => error instanceof Error && error.message.includes(String("exactly one")));
});
test("diagnostics: one verified server cannot mask another unverified server", async () => {
  const w = workspace(), silent = join(w.root, "silent.json"); writeFileSync(silent, JSON.stringify({ diagnostics: false }));
  w.configs.secondary = { ...w.configs.fixture, args: [...w.configs.fixture.args!.slice(0, -1), silent], isLinter: true }; w.saveConfig();
  assert.partialDeepStrictEqual((await run(w.args("diagnostics"))).data, { success: false, verified: false });
});
test("diagnostics: a duplicate warning cannot hide a later error", async () => {
  const w = workspace({ diagnostics: [{ message: "same message", severity: 2, range }] }), errors = join(w.root, "error.json");
  writeFileSync(errors, JSON.stringify({ diagnostics: [{ message: "same message", severity: 1, range }] }));
  w.configs.secondary = { ...w.configs.fixture, args: [...w.configs.fixture.args!.slice(0, -1), errors], isLinter: true }; w.saveConfig();
  assert.partialDeepStrictEqual((await run(w.args("diagnostics"))).data, { success: false, hasErrors: true });
});
function git(root: string, ...args: string[]) {
  const proc = childProcess.spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (proc.status !== 0) throw new Error(proc.stderr);
}
test("changed files: worktree, index, rename, deletion and Unicode paths", async () => {
  const w = workspace(); rmSync(join(w.root, ".git"), { recursive: true }); git(w.root, "init", "-q");
  writeFileSync(join(w.root, ".gitignore"), "*\n!*.fixture\n");
  const old = join(w.root, "old.fixture"), deleted = join(w.root, "deleted.fixture"), unicode = join(w.root, "中文 space\nline.fixture");
  writeFileSync(old, "old"); writeFileSync(deleted, "delete"); git(w.root, "add", ".");
  git(w.root, "-c", "user.name=trotsky1997", "-c", "user.email=30512160+trotsky1997@users.noreply.github.com", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  writeFileSync(w.file, "changed"); rmSync(deleted); git(w.root, "mv", "old.fixture", "new.fixture"); writeFileSync(unicode, "new");
  assert.deepStrictEqual(await changedFiles(w.root), [w.file, join(w.root, "new.fixture"), unicode].sort());
});
test("changed files: repositories without a first commit still inspect staged and untracked files", async () => {
  const w = workspace(); rmSync(join(w.root, ".git"), { recursive: true }); git(w.root, "init", "-q");
  writeFileSync(join(w.root, ".gitignore"), "*\n!*.fixture\n"); git(w.root, "add", "source.fixture");
  assert.deepStrictEqual(await changedFiles(w.root), [w.file]);
});
test("changed files: failed Git discovery cannot claim a clean workspace", async () => {
  const w = workspace(); rmSync(join(w.root, ".git"), { recursive: true });
  await assert.rejects(changedFiles(w.root), (error) => error instanceof Error && error.message.includes(String("Git")));
});
test("changed files: exceeding the file limit fails explicitly", async () => {
  const w = workspace(); rmSync(join(w.root, ".git"), { recursive: true }); git(w.root, "init", "-q");
  writeFileSync(join(w.root, ".gitignore"), "*\n!*.fixture\n");
  for (let i = 0; i < MAX_FILES; i++) writeFileSync(join(w.root, `${i}.fixture`), "value");
  await assert.rejects(changedFiles(w.root), (error) => error instanceof Error && error.message.includes(String("200")));
});
for (const [caseIndex, caseValue] of (["oversized", "outside symlink"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (fault) => {
  const w = workspace(); rmSync(join(w.root, ".git"), { recursive: true }); git(w.root, "init", "-q");
  writeFileSync(join(w.root, ".gitignore"), "*\n!*.fixture\n");
  if (fault === "oversized") truncateSync(w.file, 16 * 1024 * 1024 + 1);
  else { const other = workspace(); symlinkSync(other.file, join(w.root, "outside.fixture")); }
  await assert.rejects(changedFiles(w.root), (error) => error instanceof Error && error.message.includes(String(fault === "oversized" ? "16 MiB" : "outside")));
};
  test("changed files: %s cannot disappear from a verified check".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("commands: unknown commands and absent files fail before starting servers", async () => {
  const w = workspace();
  await assert.rejects(run(w.args("unknown")), (error) => error instanceof Error && error.message.includes(String("Unknown command")));
  await assert.rejects(run({ ...w.args("hover"), file: undefined }), (error) => error instanceof Error && error.message.includes(String("--file")));
  mkdirSync(join(w.root, "folder"));
  await assert.rejects(run({ ...w.args("hover"), file: join(w.root, "folder") }), (error) => error instanceof Error && error.message.includes(String("regular file")));
  assert.strictEqual(fileUri(w.file), w.uri);
});
for (const [caseIndex, caseValue] of (["utf-8", "utf-32", false]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (encoding) => {
  const w = workspace({ capabilities: { positionEncoding: encoding } });
  await assert.rejects(run(w.args("definition")), (error) => error instanceof Error && error.message.includes(String("utf-16")));
  assert.strictEqual(readFileSync(w.file, "utf8"), "value = 1\n");
};
  test("client initialization: incompatible position encoding %s fails before navigation or edits".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("hover: empty LSP responses label external references and preserve an honest not-found result", async () => {
  const w = workspace(), oldHome = process.env.CODEX_HOME, cacheRoot = fs.mkdtempSync(join(tmpdir(), "codex-lsp docs test "));
  w.configs.pyright = { ...w.configs.fixture, languageId: "typescript" }; delete w.configs.fixture; w.saveConfig();
  process.env.CODEX_HOME = cacheRoot;
  let includeEntry = true;
  const fetch = mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Response.json(url.endsWith("docs/docs.json") ? [{ slug: "typescript", version: "1" }] : { entries: includeEntry ? [{ name: "value", path: "value.html" }] : [] });
  });
  try {
    assert.partialDeepStrictEqual((await run(w.args("hover"))).data, { provider: "devdocs", found: true });
    includeEntry = false;
    fs.rmSync(join(cacheRoot, "cache/codex-lsp/devdocs"), { recursive: true, force: true });
    assert.partialDeepStrictEqual((await run(w.args("hover"))).data, { provider: "lsp", hover: "", found: false });
  } finally {
    fetch.mock.restore();
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});
test("setup: failed atomic writes preserve the entire existing configuration", async () => {
  const w = workspace(), before = readFileSync(w.configPath), original = fs.renameSync;
  const fault = mock.method(fs, "renameSync", (source: PathLike, dest: PathLike) => { if (dest === w.configPath) throw new Error("injected config write failure"); original(source, dest); });
  syncBuiltinESMExports();
  try {
    await assert.rejects(run({ ...w.args("setup", "--project"), languages: ["fixture"] }), (error) => error instanceof Error && error.message.includes(String("config write failure")));
    assert.deepStrictEqual(readFileSync(w.configPath), before); assert.deepStrictEqual(readdirSync(join(w.root, ".codex")), ["lsp.json"]);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
});
test("doctor and diagnostics: initialization errors leave useful records and close children", async () => {
  const w = workspace(); w.configs.fixture.args![1] = "exit-init"; w.saveConfig();
  const doctor = await run(w.args("doctor")); assert.strictEqual(doctor.code, 1); assert.ok((doctor.human).includes("fixture initialization failed"));
  const diagnostics = await run(w.args("diagnostics")); assert.strictEqual(diagnostics.code, 1); assert.strictEqual(diagnostics.data.verified, false); assert.ok((diagnostics.human).includes("fixture initialization failed"));
});
test("empty discovery: status/doctor report absence and semantic commands fail with setup guidance", async () => {
  const w = workspace(); w.configs.fixture.disabled = true; w.saveConfig();
  assert.ok(((await run(w.args("status"))).human).includes("No configured language servers"));
  assert.partialDeepStrictEqual((await run(w.args("doctor"))).data.issues, [{ severity: "warning" }]);
  await assert.rejects(run(w.args("capabilities")), (error) => error instanceof Error && error.message.includes(String("No available language server")));
  await assert.rejects(run(w.args("definition")), (error) => error instanceof Error && error.message.includes(String("setup <language>")));
  await assert.rejects(run({ ...w.args("request", "--method", "textDocument/hover"), file: undefined }), (error) => error instanceof Error && error.message.includes(String("No available language server")));
});
test("raw requests: workspace requests without --file start and close the selected server", async () => {
  const w = workspace({ responses: { "workspace/symbol": [] } });
  assert.deepStrictEqual((await run({ ...w.args("request", "--method", "workspace/symbol", "--payload", '{"query":"value"}'), file: undefined })).data.result, []);
});
test("Rust diagnostics: check-on-save is enabled and completed Cargo progress verifies an empty report", async () => {
  const w = workspace({ serverStatus: { quiescent: true, health: "ok" }, progress: [{ token: "rustAnalyzer/checkOnSave/0", value: { kind: "begin" } }, { token: "rustAnalyzer/checkOnSave/0", value: { kind: "end" } }] });
  w.configs["rust-analyzer"] = { ...w.configs.fixture }; delete w.configs.fixture; w.saveConfig();
  assert.partialDeepStrictEqual((await run(w.args("diagnostics"))).data, { success: true, verified: true });
  assert.partialDeepStrictEqual(w.events().find((e) => e.method === "workspace/didChangeConfiguration")?.params, { settings: { "rust-analyzer": { checkOnSave: true } } });
});
