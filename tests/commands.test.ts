import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import * as devdocs from "../src/devdocs.ts";
import { join } from "node:path";
import { LspClient } from "../src/client.ts";
import { changedFiles, formatSymbols, location, run } from "../src/commands.ts";
import { fileUri, MAX_FILES, object } from "../src/config.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";

let restoreConfig: () => void;
beforeAll(() => { restoreConfig = isolateGlobalConfig(); });
afterAll(() => restoreConfig());

afterEach(async () => {
  const leaked = LspClient.active.size;
  await Promise.all([...LspClient.active].map((c) => c.close()));
  cleanWorkspaces();
  expect(leaked).toBe(0);
});
const replacement = { range, newText: "renamed" };
const method = (command: string) => `textDocument/${command}`;

test.each(["definition", "references", "type-definition", "implementation"])("navigation: %s uses the correct request and UTF-16 position", async (command) => {
  const w = workspace(), rpc = method(command === "type-definition" ? "typeDefinition" : command);
  w.setScenario({ responses: { [rpc]: [{ targetUri: w.uri, targetSelectionRange: range }] } });
  const { data } = await run(w.args(command, "--symbol", "value"));
  expect(data.found).toBe(true); expect(data.locations).toEqual([{ file: w.file, line: 1, column: 1 }]);
  const params = object(w.events().find((e) => e.direction === "receive" && e.method === rpc)?.params);
  expect(params.position).toEqual({ line: 0, character: 0 });
  if (command === "references") expect(params.context).toEqual({ includeDeclaration: true });
});
test("navigation: ContentModified retries are bounded and recover", async () => {
  const w = workspace(); w.setScenario({ contentModified: { "textDocument/definition": 1 }, responses: { "textDocument/definition": { uri: w.uri, range } } });
  expect((await run(w.args("definition"))).data.found).toBe(true);
  expect(w.events().filter((e) => e.direction === "receive" && e.method === "textDocument/definition").length).toBe(2);
});
test("navigation: repeated ContentModified fails without claiming an empty result", async () => {
  const w = workspace({ contentModified: { "textDocument/definition": 100 } });
  await expect(run(w.args("definition"))).rejects.toThrow("Timed out");
});
test("navigation: transient empty results exhaust the deadline; non-symbol positions can return empty", async () => {
  const w = workspace({ diagnostics: false });
  await expect(run(w.args("references"))).rejects.toThrow("Timed out");
  expect((await run(w.args("references", "--column", "10"))).data.found).toBe(false);
});
test("hover: nested MarkedStrings preserve code and Markdown", async () => {
  const w = workspace({ responses: { "textDocument/hover": { contents: ["text", { language: "fixture", value: "value: number" }, { kind: "markdown", value: "**doc**" }] } } });
  expect((await run(w.args("hover"))).data).toMatchObject({ provider: "lsp", hover: "text\n\nvalue: number\n\n**doc**", found: true });
});
test.each([-1, 1.5, NaN, Infinity])("locations: malformed coordinate %s is discarded", (line) => {
  expect(location({ uri: "file:///tmp/source", range: { start: { line, character: 0 } } })).toBeUndefined();
});
test("symbols: nested document symbols and case-insensitive filters", async () => {
  const w = workspace({ responses: { "textDocument/documentSymbol": [{ name: "Outer", kind: 5, range, children: [{ name: "Value", kind: 8, selectionRange: range }] }] } });
  expect((await run(w.args("symbols", "--query", "VALUE"))).data.symbols).toEqual([{ name: "Value", kind: 8, container: "Outer", file: w.file, line: 1, column: 1 }]);
  expect(formatSymbols(null)).toEqual([]);
});
test("symbols: workspace queries seed a file and respect the output limit", async () => {
  const w = workspace(); w.setScenario({ capabilities: { workspaceSymbolProvider: true }, responses: { "workspace/symbol": Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ name: `value${i}`, location: { uri: w.uri, range } })) } });
  const result = await run(w.args("symbols", "--workspace", "--query", "value", "--limit", String(MAX_FILES)));
  expect((result.data.symbols as unknown[]).length).toBe(MAX_FILES); expect(result.data.servers).toEqual(["fixture"]);
  expect(w.events().some((e) => e.method === "textDocument/didOpen")).toBe(true);
});
test("symbols: unsupported servers and failed queries produce useful errors", async () => {
  const w = workspace();
  await expect(run(w.args("symbols", "--workspace"))).rejects.toThrow("--query");
  await expect(run(w.args("symbols", "--workspace", "--query", "value"))).rejects.toThrow("supports workspace symbols");
  w.setScenario({ capabilities: { workspaceSymbolProvider: true }, errors: { "workspace/symbol": { code: -32603, message: "injected symbol error" } } });
  const result = await run(w.args("symbols", "--workspace", "--query", "value"));
  expect(result.code).toBe(1); expect(result.data.success).toBe(false); expect(result.human).toContain("injected symbol error");
});
test.each([false, true])("rename: preview/apply=%s preserve the explicit write boundary", async (apply) => {
  const w = workspace(); w.setScenario({ responses: { "textDocument/rename": { changes: { [w.uri]: [replacement] } } } });
  const result = await run(w.args("rename", "--new-name", "renamed", ...(apply ? ["--apply"] : [])));
  expect(result.data.applied).toBe(apply); expect(readFileSync(w.file, "utf8")).toBe(apply ? "renamed = 1\n" : "value = 1\n");
  expect("workspaceEdit" in result.data).toBe(!apply);
});
test("rename: empty edits and missing new names fail without changing files", async () => {
  const w = workspace();
  await expect(run(w.args("rename"))).rejects.toThrow("--new-name");
  await expect(run(w.args("rename", "--new-name", "renamed"))).rejects.toThrow("no rename edits");
  expect(readFileSync(w.file, "utf8")).toBe("value = 1\n");
});
test("code actions: previews retain original indexes after filtering", async () => {
  const w = workspace({ responses: { "textDocument/codeAction": [{ title: "Other" }, { title: "Fix value", kind: "quickfix" }] } });
  expect((await run(w.args("code-actions", "--query", "FIX"))).data.actions).toEqual([{ index: 1, title: "Fix value", kind: "quickfix" }]);
});
test.each(["edit", "command", "nested command", "resolved edit"])("code actions: apply %s", async (kind) => {
  const w = workspace(), edit = { changes: { [w.uri]: [replacement] } };
  const action = kind === "edit" ? { title: "Fix", edit } : kind === "command" ? { title: "Fix", command: "fixture.fix", arguments: [1] } : kind === "nested command" ? { title: "Fix", command: { title: "Fix", command: "fixture.fix", arguments: [1] } } : { title: "Fix", data: 1 };
  w.setScenario({ capabilities: { codeActionProvider: { resolveProvider: true } }, responses: { "textDocument/codeAction": [action], "codeAction/resolve": { title: "Fix", edit } } });
  expect((await run(w.args("code-actions", "--apply", "--query", "0"))).data.applied).toBe(true);
  if (kind.includes("edit")) expect(readFileSync(w.file, "utf8")).toBe("renamed = 1\n");
  else expect(w.events().some((e) => e.method === "workspace/executeCommand" && object(e.params).command === "fixture.fix")).toBe(true);
});
test.each(["missing query", "no match", "disabled", "empty", "resolve disabled", "command error"])("code actions: %s fails and leaves the source intact", async (fault) => {
  const w = workspace();
  w.setScenario({ capabilities: { codeActionProvider: true }, responses: { "textDocument/codeAction": [{ title: "Fix", ...(fault === "disabled" ? { disabled: { reason: "injected disabled" } } : fault === "command error" ? { command: "fixture.fail" } : {}) }], "codeAction/resolve": { title: "Fix", ...(fault === "resolve disabled" ? { disabled: { reason: "injected resolve disabled" }, edit: { changes: { [w.uri]: [replacement] } } } : {}) } }, errors: { "workspace/executeCommand": { code: -32603, message: "injected command error" } } });
  await expect(run(w.args("code-actions", "--apply", ...(fault === "missing query" ? [] : ["--query", fault === "no match" ? "missing" : "0"])))).rejects.toThrow();
  expect(readFileSync(w.file, "utf8")).toBe("value = 1\n");
});
test.each([false, true])("rename-file: preview/apply=%s updates imports and moves the source", async (apply) => {
  const w = workspace(), dest = join(w.root, "renamed.fixture");
  w.setScenario({ responses: { "workspace/willRenameFiles": { changes: { [w.uri]: [replacement] } } } });
  const result = await run(w.args("rename-file", "--new-name", "renamed.fixture", ...(apply ? ["--apply"] : [])));
  expect(result.data.applied).toBe(apply); expect(existsSync(w.file)).toBe(!apply); expect(existsSync(dest)).toBe(apply);
  if (apply) { expect(readFileSync(dest, "utf8")).toBe("renamed = 1\n"); expect(w.events().some((e) => e.method === "workspace/didRenameFiles")).toBe(true); }
});
test("rename-file: failed edits roll the move back; existing destinations stay intact", async () => {
  const w = workspace(), dest = join(w.root, "renamed.fixture");
  w.setScenario({ responses: { "workspace/willRenameFiles": { changes: { [w.uri]: [{ ...replacement, range: { start: { line: 90, character: 0 }, end: { line: 90, character: 1 } } }] } } } });
  await expect(run(w.args("rename-file", "--new-name", "renamed.fixture", "--apply"))).rejects.toThrow("range");
  expect(readFileSync(w.file, "utf8")).toBe("value = 1\n"); expect(existsSync(dest)).toBe(false);
  writeFileSync(dest, "keep");
  await expect(run(w.args("rename-file", "--new-name", dest, "--apply"))).rejects.toThrow("Destination already exists");
  expect(readFileSync(dest, "utf8")).toBe("keep");
});
test("rename-file: unsupported methods allow a plain move; other server errors abort", async () => {
  const w = workspace({ errors: { "workspace/willRenameFiles": { code: -32601, message: "unsupported method" } } });
  expect((await run(w.args("rename-file", "--new-name", "renamed.fixture", "--apply"))).data.applied).toBe(true);
  const v = workspace({ errors: { "workspace/willRenameFiles": { code: -32603, message: "injected server error" } } });
  await expect(run(v.args("rename-file", "--new-name", "renamed.fixture", "--apply"))).rejects.toThrow("injected server error"); expect(existsSync(v.file)).toBe(true);
});
test("rename-file: workspace escapes fail before moving", async () => {
  const w = workspace(), other = workspace();
  await expect(run(w.args("rename-file", "--new-name", join(other.root, "escape.fixture"), "--apply"))).rejects.toThrow("inside the workspace");
  expect(existsSync(w.file)).toBe(true); expect(existsSync(join(other.root, "escape.fixture"))).toBe(false);
});
test("raw requests: guard write methods and generate navigation parameters", async () => {
  const w = workspace();
  await expect(run(w.args("request"))).rejects.toThrow("--method");
  await expect(run(w.args("request", "--method", "workspace/executeCommand"))).rejects.toThrow("--apply");
  await expect(run(w.args("request", "--method", "textDocument/hover", "--payload", "{"))).rejects.toThrow();
  await run(w.args("request", "--method", "textDocument/references", "--symbol", "value"));
  expect(object(w.events().find((e) => e.method === "textDocument/references")?.params)).toMatchObject({ textDocument: { uri: w.uri }, position: { line: 0, character: 0 }, context: { includeDeclaration: true } });
});
test("raw requests: invalid positions close the newly opened client", async () => {
  const w = workspace();
  await expect(run(w.args("request", "--method", "textDocument/definition", "--line", "99"))).rejects.toThrow("outside this file");
  expect(LspClient.active.size).toBe(0);
});
test("raw requests: explicit payloads and returned workspace edits", async () => {
  const w = workspace(); w.setScenario({ responses: { "fixture/edit": { changes: { [w.uri]: [replacement] } } } });
  const result = await run(w.args("request", "--method", "fixture/edit", "--apply", "--payload", '{"custom":true}'));
  expect(result.data.applied).toBe(true); expect(readFileSync(w.file, "utf8")).toBe("renamed = 1\n");
  expect(w.events().find((e) => e.method === "fixture/edit")?.params).toEqual({ custom: true });
});
test("raw requests: server applyEdit callbacks honor --apply", async () => {
  const w = workspace(); w.setScenario({ callbacks: { "workspace/executeCommand": { method: "workspace/applyEdit", params: { edit: { changes: { [w.uri]: [replacement] } } } } } });
  expect((await run(w.args("request", "--method", "workspace/executeCommand", "--apply"))).data.applied).toBe(true);
  expect(readFileSync(w.file, "utf8")).toBe("renamed = 1\n");
});
test("status, capabilities and doctor use the selected project server", async () => {
  const w = workspace({ capabilities: { hoverProvider: true } });
  const args = w.args("status");
  expect((await run(args)).data.servers).toMatchObject([{ name: "fixture", root: w.root, command: process.execPath }]);
  expect((await run({ ...args, command: "capabilities" })).data.servers).toEqual([{ name: "fixture", capabilities: { hoverProvider: true } }]);
  expect((await run({ ...args, command: "doctor" })).data.success).toBe(true);
  w.configs.fixture.command = join(w.root, "missing-server"); w.saveConfig();
  const missing = await run(w.args("doctor")); expect(missing.code).toBe(1); expect(missing.data.servers).toMatchObject([{ name: "fixture", status: "missing" }]);
});
test("setup: language lists register absolute executables while preserving settings and unrelated entries", async () => {
  const w = workspace(); w.configs.fixture.settings = { custom: true }; w.saveConfig();
  const before = JSON.parse(readFileSync(w.configPath, "utf8"));
  const result = await run({ ...w.args("setup", "--project"), languages: ["fixture， .fixture, fixture"] });
  expect(result.data.path).toBe(w.configPath); expect(result.data.servers).toEqual({ fixture: process.execPath });
  const after = JSON.parse(readFileSync(w.configPath, "utf8"));
  expect(after.servers.fixture.settings).toEqual({ custom: true }); expect(after.servers.pyright).toEqual(before.servers.pyright);
});
test("setup: missing servers return platform install guidance without partial writes", async () => {
  const w = workspace(); w.configs.fixture.command = "codex-lsp-nonexistent-fixture-bin";
  w.configs.fixture.setup = { install: { [process.platform]: ["install fixture-server", "configure fixture-server"] }, docs: "https://example.org/fixture-docs" }; w.saveConfig();
  const before = readFileSync(w.configPath);
  await expect(run({ ...w.args("setup", "--project"), languages: ["fixture"] })).rejects.toThrow(`Install commands (${process.platform})`);
  await expect(run({ ...w.args("setup", "--project"), languages: ["fixture"] })).rejects.toThrow("https://example.org/fixture-docs");
  expect(readFileSync(w.configPath)).toEqual(before);
  await expect(run({ ...w.args("setup"), languages: [] })).rejects.toThrow("Provide languages");
  await expect(run({ ...w.args("setup"), languages: ["unknown-language"] })).rejects.toThrow("No bundled language server");
});
test("diagnostics: clean, error and unverified reports preserve exit semantics", async () => {
  const w = workspace(); expect((await run(w.args("diagnostics"))).data).toMatchObject({ success: true, verified: true, hasErrors: false });
  w.setScenario({ diagnostics: [{ message: "type error", range }] });
  const errors = await run(w.args("diagnostics")); expect(errors.code).toBe(1); expect(errors.data).toMatchObject({ success: false, verified: true, hasErrors: true });
  w.setScenario({ diagnostics: false });
  const unchecked = await run(w.args("diagnostics")); expect(unchecked.code).toBe(1); expect(unchecked.data.verified).toBe(false);
  await expect(run(w.args("diagnostics", "--changed"))).rejects.toThrow("exactly one");
});
test("diagnostics: one verified server cannot mask another unverified server", async () => {
  const w = workspace(), silent = join(w.root, "silent.json"); writeFileSync(silent, JSON.stringify({ diagnostics: false }));
  w.configs.secondary = { ...w.configs.fixture, args: [...w.configs.fixture.args!.slice(0, -1), silent], isLinter: true }; w.saveConfig();
  expect((await run(w.args("diagnostics"))).data).toMatchObject({ success: false, verified: false });
});
test("diagnostics: a duplicate warning cannot hide a later error", async () => {
  const w = workspace({ diagnostics: [{ message: "same message", severity: 2, range }] }), errors = join(w.root, "error.json");
  writeFileSync(errors, JSON.stringify({ diagnostics: [{ message: "same message", severity: 1, range }] }));
  w.configs.secondary = { ...w.configs.fixture, args: [...w.configs.fixture.args!.slice(0, -1), errors], isLinter: true }; w.saveConfig();
  expect((await run(w.args("diagnostics"))).data).toMatchObject({ success: false, hasErrors: true });
});
function git(root: string, ...args: string[]) {
  const proc = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode) throw new Error(proc.stderr.toString());
}
test("changed files: worktree, index, rename, deletion and Unicode paths", async () => {
  const w = workspace(); rmSync(join(w.root, ".git"), { recursive: true }); git(w.root, "init", "-q");
  writeFileSync(join(w.root, ".gitignore"), "*\n!*.fixture\n");
  const old = join(w.root, "old.fixture"), deleted = join(w.root, "deleted.fixture"), unicode = join(w.root, "中文 space\nline.fixture");
  writeFileSync(old, "old"); writeFileSync(deleted, "delete"); git(w.root, "add", ".");
  git(w.root, "-c", "user.name=trotsky1997", "-c", "user.email=30512160+trotsky1997@users.noreply.github.com", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  writeFileSync(w.file, "changed"); rmSync(deleted); git(w.root, "mv", "old.fixture", "new.fixture"); writeFileSync(unicode, "new");
  expect(await changedFiles(w.root)).toEqual([w.file, join(w.root, "new.fixture"), unicode].sort());
});
test("changed files: repositories without a first commit still inspect staged and untracked files", async () => {
  const w = workspace(); rmSync(join(w.root, ".git"), { recursive: true }); git(w.root, "init", "-q");
  writeFileSync(join(w.root, ".gitignore"), "*\n!*.fixture\n"); git(w.root, "add", "source.fixture");
  expect(await changedFiles(w.root)).toEqual([w.file]);
});
test("changed files: failed Git discovery cannot claim a clean workspace", async () => {
  const w = workspace(); rmSync(join(w.root, ".git"), { recursive: true });
  await expect(changedFiles(w.root)).rejects.toThrow("Git");
});
test("changed files: exceeding the file limit fails explicitly", async () => {
  const w = workspace(); rmSync(join(w.root, ".git"), { recursive: true }); git(w.root, "init", "-q");
  writeFileSync(join(w.root, ".gitignore"), "*\n!*.fixture\n");
  for (let i = 0; i < MAX_FILES; i++) writeFileSync(join(w.root, `${i}.fixture`), "value");
  await expect(changedFiles(w.root)).rejects.toThrow("200");
});
test.each(["oversized", "outside symlink"])("changed files: %s cannot disappear from a verified check", async (fault) => {
  const w = workspace(); rmSync(join(w.root, ".git"), { recursive: true }); git(w.root, "init", "-q");
  writeFileSync(join(w.root, ".gitignore"), "*\n!*.fixture\n");
  if (fault === "oversized") truncateSync(w.file, 16 * 1024 * 1024 + 1);
  else { const other = workspace(); symlinkSync(other.file, join(w.root, "outside.fixture")); }
  await expect(changedFiles(w.root)).rejects.toThrow(fault === "oversized" ? "16 MiB" : "outside");
});
test("commands: unknown commands and absent files fail before starting servers", async () => {
  const w = workspace();
  await expect(run(w.args("unknown"))).rejects.toThrow("Unknown command");
  await expect(run({ ...w.args("hover"), file: undefined })).rejects.toThrow("--file");
  mkdirSync(join(w.root, "folder"));
  await expect(run({ ...w.args("hover"), file: join(w.root, "folder") })).rejects.toThrow("regular file");
  expect(fileUri(w.file)).toBe(w.uri);
});
test.each(["utf-8", "utf-32", false])("client initialization: incompatible position encoding %s fails before navigation or edits", async (encoding) => {
  const w = workspace({ capabilities: { positionEncoding: encoding } });
  await expect(run(w.args("definition"))).rejects.toThrow("utf-16");
  expect(readFileSync(w.file, "utf8")).toBe("value = 1\n");
});
test("hover: empty LSP responses label external references and preserve an honest not-found result", async () => {
  const w = workspace(); w.configs.pyright = { ...w.configs.fixture, languageId: "fixture" }; delete w.configs.fixture; w.saveConfig();
  const reference = spyOn(devdocs, "findReference").mockResolvedValue("External reference fixture");
  try {
    expect((await run(w.args("hover"))).data).toMatchObject({ provider: "devdocs", hover: "External reference fixture", found: true });
    expect(reference).toHaveBeenCalledWith("fixture", "value", 400);
    reference.mockResolvedValue(undefined);
    expect((await run(w.args("hover"))).data).toMatchObject({ provider: "lsp", hover: "", found: false });
  } finally { reference.mockRestore(); }
});
test("setup: failed atomic writes preserve the entire existing configuration", async () => {
  const w = workspace(), before = readFileSync(w.configPath), original = fs.renameSync;
  const fault = spyOn(fs, "renameSync").mockImplementation((source, dest) => { if (dest === w.configPath) throw new Error("injected config write failure"); original(source, dest); });
  try {
    await expect(run({ ...w.args("setup", "--project"), languages: ["fixture"] })).rejects.toThrow("config write failure");
    expect(readFileSync(w.configPath)).toEqual(before); expect(readdirSync(join(w.root, ".codex"))).toEqual(["lsp.json"]);
  } finally { fault.mockRestore(); }
});
test("doctor and diagnostics: initialization errors leave useful records and close children", async () => {
  const w = workspace(); w.configs.fixture.args![1] = "exit-init"; w.saveConfig();
  const doctor = await run(w.args("doctor")); expect(doctor.code).toBe(1); expect(doctor.human).toContain("fixture initialization failed");
  const diagnostics = await run(w.args("diagnostics")); expect(diagnostics.code).toBe(1); expect(diagnostics.data.verified).toBe(false); expect(diagnostics.human).toContain("fixture initialization failed");
});
test("empty discovery: status/doctor report absence and semantic commands fail with setup guidance", async () => {
  const w = workspace(); w.configs.fixture.disabled = true; w.saveConfig();
  expect((await run(w.args("status"))).human).toContain("No configured language servers");
  expect((await run(w.args("doctor"))).data.issues).toMatchObject([{ severity: "warning" }]);
  await expect(run(w.args("capabilities"))).rejects.toThrow("No available language server");
  await expect(run(w.args("definition"))).rejects.toThrow("setup <language>");
  await expect(run({ ...w.args("request", "--method", "textDocument/hover"), file: undefined })).rejects.toThrow("No available language server");
});
test("raw requests: workspace requests without --file start and close the selected server", async () => {
  const w = workspace({ responses: { "workspace/symbol": [] } });
  expect((await run({ ...w.args("request", "--method", "workspace/symbol", "--payload", '{"query":"value"}'), file: undefined })).data.result).toEqual([]);
});
test("Rust diagnostics: check-on-save is enabled and completed Cargo progress verifies an empty report", async () => {
  const w = workspace({ serverStatus: { quiescent: true, health: "ok" }, progress: [{ token: "rustAnalyzer/checkOnSave/0", value: { kind: "begin" } }, { token: "rustAnalyzer/checkOnSave/0", value: { kind: "end" } }] });
  w.configs["rust-analyzer"] = { ...w.configs.fixture }; delete w.configs.fixture; w.saveConfig();
  expect((await run(w.args("diagnostics"))).data).toMatchObject({ success: true, verified: true });
  expect(w.events().find((e) => e.method === "workspace/didChangeConfiguration")?.params).toMatchObject({ settings: { "rust-analyzer": { checkOnSave: true } } });
});
