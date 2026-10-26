import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { after, afterEach, before, test, mock } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import type { PathLike } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { LspClient } from "../src/client.ts";
import { parseOptions } from "../src/cli.ts";
import { changedFiles, run } from "../src/commands.ts";
import { fileUri, object, serverRoot } from "../src/config.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, setGlobalServers, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); });
after(() => restore());
afterEach(async () => {
  const leaked = LspClient.active.size;
  await Promise.all([...LspClient.active].map(client => client.close()));
  cleanWorkspaces(); assert.strictEqual(leaked, 0);
});

function monorepo() {
  const w = workspace(), project = join(w.root, "crates/core"), file = join(project, "source.fixture"), sibling = join(w.root, "sibling.fixture");
  fs.mkdirSync(project, { recursive: true }); fs.renameSync(w.file, file);
  fs.writeFileSync(join(project, "fixture.project"), ""); fs.writeFileSync(sibling, "value = 2\n");
  const edit = { changes: { [fileUri(file)]: [{ range, newText: "renamed" }], [fileUri(sibling)]: [{ range, newText: "renamed" }] } };
  return { ...w, project, file, sibling, edit, args: (command: string, ...flags: string[]) => ({ ...w.args(command, ...flags), file }) };
}

for (const [caseIndex, caseValue] of (["rename", "code-actions", "request", "rename-file"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async command => {
  const w = monorepo(), method = command === "rename" ? "textDocument/rename" : command === "code-actions" ? "textDocument/codeAction" : command === "request" ? "fixture/edit" : "workspace/willRenameFiles";
  w.setScenario({ responses: { [method]: command === "code-actions" ? [{ title: "Fix", edit: w.edit }] : w.edit } });
  const flags = command === "code-actions" ? ["--query", "0"] : command === "request" ? ["--method", method] : ["--new-name", command === "rename-file" ? "renamed.fixture" : "renamed"];
  const result = await run(w.args(command, ...flags, "--apply"));
  assert.partialDeepStrictEqual(result.data, { applied: true, verification: "pending" });
  assert.ok((String(result.data.hint)).includes("build/tests")); assert.ok((result.human).includes("verification pending"));
  assert.strictEqual(fs.readFileSync(command === "rename-file" ? join(w.project, "renamed.fixture") : w.file, "utf8"), "renamed = 1\n");
  assert.strictEqual(fs.readFileSync(w.sibling, "utf8"), "renamed = 2\n");
  assert.strictEqual(object(w.events().find(e => e.method === "initialize")?.params).rootUri, fileUri(w.project));
};
  test("monorepo: %s updates sibling packages within the checkout".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("rename: incomplete server edits require project verification after writes", async () => {
  const w = monorepo();
  w.setScenario({ responses: { "textDocument/rename": { changes: { [fileUri(w.file)]: w.edit.changes[fileUri(w.file)] } } } });
  const result = await run(w.args("rename", "--new-name", "renamed", "--apply"));
  assert.partialDeepStrictEqual(result.data, { success: true, applied: true, verification: "pending" });
  assert.ok((String(result.data.hint)).includes("code-actions"));
  assert.strictEqual(fs.readFileSync(w.sibling, "utf8"), "value = 2\n");
  assert.strictEqual(w.events().some(e => e.method === "textDocument/diagnostic"), false);
});
test("raw request: a command with no edits has no pending edit verification", async () => {
  const w = workspace(), result = await run(w.args("request", "--method", "fixture/echo", "--payload", "{}", "--apply"));
  assert.strictEqual(result.data.applied, false); assert.strictEqual(result.data.verification, undefined);
});
for (const [caseIndex, caseValue] of (["no-git", "nested-git", "target-nested-git", "symlink-escape"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async kind => {
  const w = monorepo(), other = workspace();
  if (kind === "no-git") fs.rmSync(join(w.root, ".git"), { recursive: true });
  if (kind === "nested-git") {
    fs.writeFileSync(join(w.project, ".git"), "gitdir: external-metadata\n");
    fs.mkdirSync(join(w.project, ".codex")); fs.copyFileSync(w.configPath, join(w.project, ".codex/lsp.json"));
  }
  if (kind === "target-nested-git") {
    const nested = join(w.root, "vendor/repository"), oldUri = fileUri(w.sibling);
    fs.mkdirSync(nested, { recursive: true }); fs.writeFileSync(join(nested, ".git"), "gitdir: external-metadata\n");
    const target = join(nested, "source.fixture"); fs.renameSync(w.sibling, target); w.sibling = target;
    w.edit.changes[fileUri(target)] = w.edit.changes[oldUri]; delete w.edit.changes[oldUri];
  }
  if (kind === "symlink-escape") { fs.unlinkSync(w.sibling); fs.symlinkSync(other.file, w.sibling); }
  w.setScenario({ responses: { "textDocument/rename": w.edit } });
  await assert.rejects(run(w.args("rename", "--new-name", "renamed", "--apply")), (error) => error instanceof Error && error.message.includes(String("outside the workspace")));
  assert.strictEqual(fs.readFileSync(w.file, "utf8"), "value = 1\n");
  assert.strictEqual(fs.readFileSync(w.sibling, "utf8"), kind === "symlink-escape" ? "value = 1\n" : "value = 2\n");
};
  test("monorepo: %s preserves the edit boundary and every file".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("monorepo: a failed sibling write rolls back earlier changes", async () => {
  const w = monorepo(), rename = fs.renameSync;
  w.setScenario({ responses: { "textDocument/rename": w.edit } });
  const fault = mock.method(fs, "renameSync", (source: PathLike, target: PathLike) => {
    if (target === w.sibling) throw new Error("injected sibling write failure");
    rename(source, target);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(run(w.args("rename", "--new-name", "renamed", "--apply")), (error) => error instanceof Error && error.message.includes(String("injected sibling"))); }
  finally { fault.mock.restore(); syncBuiltinESMExports(); }
  assert.strictEqual(fs.readFileSync(w.file, "utf8"), "value = 1\n");
  assert.strictEqual(fs.readFileSync(w.sibling, "utf8"), "value = 2\n");
  assert.strictEqual(fs.readdirSync(w.project).some(name => name.endsWith(".tmp")), false);
});
for (const [caseIndex, caseValue] of (["sibling", "nested-checkout", "outside-checkout"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async kind => {
  const w = monorepo(), other = workspace(), folder = kind === "outside-checkout" ? other.root : join(w.root, "destination");
  fs.mkdirSync(folder, { recursive: true });
  if (kind === "nested-checkout") fs.writeFileSync(join(folder, ".git"), "gitdir: other-checkout\n");
  const destination = join(folder, "moved.fixture");
  if (kind === "sibling") {
    assert.strictEqual((await run(w.args("rename-file", "--new-name", destination, "--apply"))).data.applied, true);
    assert.strictEqual(fs.readFileSync(destination, "utf8"), "value = 1\n"); assert.strictEqual(fs.existsSync(w.file), false);
  } else {
    await assert.rejects(run(w.args("rename-file", "--new-name", destination, "--apply")), (error) => error instanceof Error && error.message.includes(String("inside the workspace")));
    assert.strictEqual(fs.readFileSync(w.file, "utf8"), "value = 1\n"); assert.strictEqual(fs.existsSync(destination), false);
  }
};
  test("file rename: %s destination respects the checkout boundary".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("missing files: discovery explains how to recover before any server starts", async () => {
  const w = workspace(), start = mock.method(LspClient, "start");
  try {
    await assert.rejects(run({ ...w.args("status"), file: join(w.root, "wrong file.fixture") }), (error) => error instanceof Error && error.message.includes(String("rg --files")));
    assert.strictEqual(start.mock.callCount(), 0);
  } finally { start.mock.restore(); }
});
test("cwd: relative context overrides preserve spaces and canonical paths", () => {
  const w = workspace(), directory = join(w.root, "项目 with spaces"); fs.mkdirSync(directory);
  assert.strictEqual(parseOptions(["status", "--cwd", "项目 with spaces"], w.root).cwd, fs.realpathSync(directory));
});
test("cwd: setup and relative file queries use the selected project", async () => {
  const target = workspace(), caller = workspace(), before = fs.readFileSync(caller.configPath);
  await run(parseOptions(["setup", "fixture", "--project", "--cwd", target.root], caller.root));
  assert.partialDeepStrictEqual((await run(parseOptions(["status", "--file", "source.fixture", "--cwd", target.root], caller.root))).data.servers, [{ name: "fixture", root: target.root }]);
  assert.deepStrictEqual(fs.readFileSync(caller.configPath), before);
  assert.ok((JSON.parse(fs.readFileSync(target.configPath, "utf8")).servers.fixture.rootMarkers).includes(".codex/lsp.json"));
});
test("cwd: files and empty contexts fail before startup", () => {
  const w = workspace();
  for (const path of ["", w.file]) assert.throws(() => parseOptions(["status", "--cwd", path]), (error) => error instanceof Error && error.message.includes(String("--cwd")));
});
for (const [caseIndex, caseValue] of (["fixture.project", "*.sln"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = marker => {
  const w = workspace(), nested = join(w.root, "nested-checkout");
  fs.mkdirSync(nested); fs.writeFileSync(join(nested, ".git"), "gitdir: metadata\n");
  fs.writeFileSync(join(w.root, "external.sln"), "");
  assert.strictEqual(serverRoot(nested, [marker]), undefined);
};
  test("discovery: %s markers stay within the nearest checkout".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("hook startup: Node preserves normal project cwd and ignores project preloads", async () => {
  const w = workspace(), repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), buildRoot = join(repoRoot, ".test-build"), sentinel = join(w.root, "preload-ran"), trap = join(w.root, "trap.mjs");
  assert.strictEqual(childProcess.spawnSync("git", ["init", "-q", w.root]).status, 0);
  fs.writeFileSync(join(w.root, ".gitignore"), "*\n");
  fs.writeFileSync(trap, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, process.cwd());`);
  fs.writeFileSync(join(w.root, ".bunfig.toml"), 'preload = ["./trap.mjs"]\n');
  for (const [file, variable] of [["codex-hooks.json", "PLUGIN_ROOT"], ["hooks.json", "CLAUDE_PLUGIN_ROOT"]]) {
    const manifest = JSON.parse(fs.readFileSync(join(repoRoot, "hooks", file), "utf8"));
    for (const entries of Object.values(manifest.hooks) as { matcher?: string; hooks: { command: string }[] }[][])
      for (const entry of entries) for (const hook of entry.hooks) assert.strictEqual(hook.command, 'node "${' + variable + '}/dist/cli.js" hook ' + (entry.matcher ? "session-start" : "stop"));
  }
  const proc = childProcess.spawnSync(process.execPath, [join(buildRoot, "src/cli.js"), "hook", "stop"], { cwd: w.root, env: { ...process.env, CLAUDE_PLUGIN_ROOT: "" }, input: JSON.stringify({ cwd: w.root, stop_hook_active: true }), encoding: "utf8", timeout: 8000 });
  assert.strictEqual(proc.status, 0, proc.stderr); assert.strictEqual(proc.stderr, ""); assert.deepStrictEqual(JSON.parse(proc.stdout), { continue: true }); assert.strictEqual(fs.existsSync(sentinel), false);
});
for (const [caseIndex, caseValue] of (["inspect --file source.fixture --json", "setup --project typescript"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = command => {
  assert.throws(() => parseOptions([command]), (error) => error instanceof Error && error.message.includes(String("separate arguments")));
  assert.strictEqual(parseOptions(["hover", "--file", "a file with spaces.ts"]).file, "a file with spaces.ts");
};
  test("arguments: a quoted command string %s has a recovery hint".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
for (const [caseIndex, caseValue] of (["{}", '{"textDocument":{}}']).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async payload => {
  const w = workspace(), start = mock.method(LspClient, "start");
  try {
    await assert.rejects(run(w.args("request", "--method", "textDocument/hover", "--payload", payload, "--line", "999")), (error) => error instanceof Error && error.message.includes(String("outside this file")));
    assert.strictEqual(start.mock.callCount(), 0);
  } finally { start.mock.restore(); }
};
  test("raw request: inferred positions are checked before startup with payload=%s".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("raw request: explicit LSP position overrides unused CLI coordinates", async () => {
  const w = workspace();
  assert.strictEqual((await run(w.args("request", "--method", "textDocument/hover", "--payload", '{"position":{"line":0,"character":0}}', "--line", "999"))).data.success, true);
});
for (const [caseIndex, caseValue] of ([{ timeout: 50, hint: "--timeout 120" }, { timeout: 120000, hint: "--timeout 240" }, { timeout: 300000, hint: "project dependencies" }]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async ({ timeout, hint }) => {
  const w = workspace(), client = await LspClient.start({ ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath }, timeout);
  try { await assert.rejects(client.waitWorkspace(15), (error) => error instanceof Error && error.message.includes(String(hint))); }
  finally { await client.close(); }
};
  test("readiness: recovery respects the timeout ceiling %#".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("request: subsecond timeouts retain the actual duration", async () => {
  const w = workspace(), client = await LspClient.start({ ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath }, 1000);
  try { await assert.rejects(client.request("fixture/stall", {}, 15), (error) => error instanceof Error && error.message.includes(String("0.015s"))); }
  finally { await client.close(); }
});
test("inspect: verified code errors have an explicit explanation beside the aggregate status", async () => {
  const w = workspace({ diagnostics: [{ range, message: "project type error", severity: 1 }], responses: { "textDocument/hover": { contents: "value" } } });
  const result = await run(w.args("inspect"));
  assert.partialDeepStrictEqual(result.data, { success: false, failedSections: ["diagnostics"], results: { diagnostics: { verified: true, hasErrors: true } } });
  assert.ok((String(result.data.hint)).includes("project code")); assert.ok((result.human).includes("verified"));
});
for (const [caseIndex, caseValue] of (["json", "sh", "unsupported"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async extension => {
  const w = workspace(), file = join(w.root, `missing server.${extension}`);
  fs.writeFileSync(file, "");
  const result = await run({ ...w.args("diagnostics"), file });
  assert.strictEqual(result.code, 1); assert.partialDeepStrictEqual(result.data, { success: false, verified: false, hasErrors: false });
  const record = (result.data.checked as { errors: string[] }[])[0];
  assert.strictEqual((record.errors).length, 1); assert.ok((record.errors[0]).includes("setup <language>"));
  assert.ok((result.human).includes("No available language server")); assert.strictEqual(LspClient.active.size, 0);
};
  test("diagnostics: unavailable %s servers explain recovery without claiming verification".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("changed diagnostics: untracked helpers have explicit errors alongside verified source", async () => {
  const w = workspace(); fs.rmSync(join(w.root, ".git"), { recursive: true });
  assert.strictEqual(childProcess.spawnSync("git", ["-C", w.root, "init", "-q"]).status, 0);
  fs.writeFileSync(join(w.root, ".gitignore"), "*\n!*.fixture\n!missing.json\n!record.sh\n");
  fs.writeFileSync(join(w.root, "missing.json"), "{}"); fs.writeFileSync(join(w.root, "record.sh"), "");
  const result = await run({ ...w.args("diagnostics"), file: undefined, changed: true });
  assert.strictEqual(result.code, 1); assert.partialDeepStrictEqual(result.data, { success: false, verified: false, hasErrors: false });
  const checked = result.data.checked as { file: string; verified: boolean; errors: string[] }[];
  assert.strictEqual((checked).length, 3); assert.partialDeepStrictEqual(checked.find(x => x.file === w.file), { verified: true, errors: [] });
  for (const record of checked.filter(x => x.file !== w.file)) {
    assert.strictEqual(record.verified, false); assert.ok((record.errors[0]).includes("No available language server"));
  }
});
test("changed diagnostics: a neutral directory identifies its Git context and the cwd fix", async () => {
  const w = workspace(); fs.rmSync(join(w.root, ".git"), { recursive: true });
  const failure = await changedFiles(w.root).catch(error => error);
  assert.ok(((failure) instanceof Error)); assert.ok((failure.message).includes(w.root));
  assert.ok((failure.message).includes("--cwd <project-root> diagnostics --changed"));
  assert.ok((failure.message).includes("--file <source-file>"));
});
test("file rename: destination-directory errors explain source-relative paths before startup", async () => {
  const w = workspace(), start = mock.method(LspClient, "start");
  try { await assert.rejects(run(w.args("rename-file", "--new-name", "missing/new.fixture", "--apply")), /--new-name.*source.*directory/); assert.strictEqual(start.mock.callCount(), 0); assert.strictEqual(fs.readFileSync(w.file, "utf8"), "value = 1\n"); }
  finally { start.mock.restore(); }
});
test("file rename: an internal error mentioning unsupported methods cannot authorize a plain move", async () => {
  const w = workspace({ errors: { "workspace/willRenameFiles": { code: -32603, message: "failed after unsupported method -32601" } } });
  await assert.rejects(run(w.args("rename-file", "--new-name", "moved.fixture", "--apply")), /-32603/); assert.strictEqual(fs.existsSync(w.file), true); assert.strictEqual(fs.existsSync(join(w.root, "moved.fixture")), false);
});
for (const [caseIndex, caseValue] of (["diff", "ls-files"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async stage => {
  const w = workspace(), shimRoot = fs.mkdtempSync(join(tmpdir(), "codex-lsp fake git "));
  const oldPath = process.env.PATH ?? "", realGit = childProcess.execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  fs.rmSync(join(w.root, ".git"), { recursive: true, force: true });
  assert.strictEqual(childProcess.spawnSync(realGit, ["init", "-q", w.root]).status, 0);
  assert.strictEqual(childProcess.spawnSync(realGit, ["-C", w.root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "add", "source.fixture"]).status, 0);
  assert.strictEqual(childProcess.spawnSync(realGit, ["-C", w.root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]).status, 0);
  const fakeGit = join(shimRoot, "git"), quotedGit = `'${realGit.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(fakeGit, `#!/bin/sh\nif [ "$3" = "${stage}" ]; then printf 'source.fixture\\0'; printf '%s\\n' '${"x".repeat(256)}fixture Git permission denied' >&2; exit 7; fi\nexec ${quotedGit} "$@"\n`);
  fs.chmodSync(fakeGit, 0o755);
  process.env.PATH = `${shimRoot}:${oldPath}`;
  try {
    const failure = await changedFiles(w.root).catch(error => error);
    assert.ok(((failure) instanceof Error)); assert.ok((failure.message).includes(`Git ${stage}`), failure.message);
    assert.ok((failure.message).includes(w.root)); assert.ok((failure.message).includes("fixture Git permission denied"), failure.message);
    assert.ok((failure.message).includes("--cwd")); assert.ok(failure.message.length < 1500);
  } finally {
    if (oldPath) process.env.PATH = oldPath; else delete process.env.PATH;
    fs.rmSync(shimRoot, { recursive: true, force: true });
  }
};
  test("Git failure: %s drains stderr, bounds detail and rejects partial file lists".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
for (const [caseIndex, caseValue] of (["executable override", "malformed configuration"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async fault => {
  const w = workspace(), marker = join(w.root, "project-command-executed");
  const trusted = structuredClone(w.configs); trusted.fixture.settings = { fixture: { selected: "user" } };
  setGlobalServers(trusted);
  fs.writeFileSync(w.configPath, fault === "malformed configuration" ? "{ malformed" : JSON.stringify({ servers: {
    fixture: { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "untrusted"); process.exit(17)`] },
  } }));
  const result = await run(w.args("diagnostics", "--global-config-only", "--global-bins-only"));
  assert.partialDeepStrictEqual(result.data, { success: true, verified: true, hasErrors: false });
  assert.strictEqual(fs.existsSync(marker), false);
  const settings = object(w.events().find(event => event.method === "workspace/didChangeConfiguration")?.params).settings;
  assert.deepStrictEqual(settings, { fixture: { selected: "user" } });
};
  test("hook scope: user-selected server survives project %s".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};

function changedConfiguration() {
  const w = workspace(); fs.rmSync(join(w.root, ".git"), { recursive: true });
  assert.strictEqual(childProcess.spawnSync("git", ["-C", w.root, "init", "-q"]).status, 0);
  fs.writeFileSync(join(w.root, ".gitignore"), "*\n!*.fixture\n!.codex/\n!.codex/lsp.json\n");
  return { ...w, options: { ...w.args("diagnostics"), file: undefined, changed: true } };
}
test("configuration diagnostics: CLI metadata is validated separately from changed source", async () => {
  const w = changedConfiguration();
  assert.ok((await changedFiles(w.root)).includes(w.configPath));
  const result = await run(w.options);
  assert.partialDeepStrictEqual(result.data, { success: true, verified: true, hasErrors: false,
    configurationChecks: [{ file: w.configPath, status: "validated" }],
  });
  assert.deepStrictEqual((result.data.checked as { file: string }[]).map(row => row.file), [w.file]);
  assert.ok((result.human).includes(`Validated CLI configuration: ${w.configPath}`));
});
test("configuration diagnostics: metadata-only changes start no language server", async () => {
  const w = changedConfiguration(), start = mock.method(LspClient, "start");
  fs.appendFileSync(join(w.root, ".gitignore"), "*.fixture\n");
  try {
    const result = await run(w.options);
    assert.partialDeepStrictEqual(result.data, { success: true, checked: [], configurationChecks: [{ file: w.configPath, status: "validated" }] });
    assert.ok((result.human).includes("No changed source files")); assert.strictEqual(start.mock.callCount(), 0);
  } finally { start.mock.restore(); }
});
test("configuration diagnostics: explicit file checks still require a JSON language server", async () => {
  const w = changedConfiguration(), result = await run({ ...w.options, changed: false, file: w.configPath });
  assert.partialDeepStrictEqual(result.data, { success: false, verified: false });
  assert.strictEqual(result.data.configurationChecks, undefined);
  assert.ok(((result.data.checked as { errors: string[] }[])[0].errors[0]).includes("No available language server"));
});
for (const [caseIndex, caseValue] of (["malformed JSON", "invalid server"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async fault => {
  const w = changedConfiguration(), start = mock.method(LspClient, "start");
  fs.writeFileSync(w.configPath, fault === "malformed JSON" ? "{ malformed" : JSON.stringify({ servers: { fixture: { command: "" } } }));
  try {
    await assert.rejects(run(w.options), (error) => error instanceof Error && error.message.includes(String(fault === "malformed JSON" ? "Cannot read LSP configuration" : "needs a command")));
    assert.strictEqual(start.mock.callCount(), 0);
  } finally { start.mock.restore(); }
};
  test("configuration diagnostics: %s fails before source analysis".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("configuration diagnostics: hook scope explicitly ignores malformed project metadata", async () => {
  const w = changedConfiguration(); setGlobalServers(structuredClone(w.configs));
  fs.writeFileSync(w.configPath, "{ malformed project configuration");
  const result = await run({ ...w.options, globalConfigOnly: true, globalBinsOnly: true });
  assert.partialDeepStrictEqual(result.data, { success: true, verified: true, configurationChecks: [{ file: w.configPath, status: "ignored" }] });
  assert.ok((result.human).includes("Ignored project LSP configuration"));
  assert.strictEqual(fs.readFileSync(w.configPath, "utf8"), "{ malformed project configuration");
});
test("configuration diagnostics: inactive nested configs remain ordinary unverified JSON files", async () => {
  const w = changedConfiguration(), nested = join(w.root, "nested/.codex/lsp.json");
  fs.mkdirSync(join(w.root, "nested/.codex"), { recursive: true }); fs.writeFileSync(nested, "{ inactive config");
  fs.appendFileSync(join(w.root, ".gitignore"), "!nested/\n!nested/.codex/\n!nested/.codex/lsp.json\n");
  const result = await run(w.options);
  assert.partialDeepStrictEqual(result.data, { success: false, verified: false, configurationChecks: [{ file: w.configPath, status: "validated" }] });
  const record = (result.data.checked as { file: string; verified: boolean; errors: string[] }[]).find(row => row.file === nested)!;
  assert.strictEqual(record.verified, false); assert.ok((record.errors[0]).includes("No available language server"));
});
test("configuration diagnostics: canonical in-checkout metadata aliases remain identifiable", async () => {
  const w = changedConfiguration(), target = join(w.root, "settings.data");
  fs.renameSync(w.configPath, target); fs.symlinkSync(target, w.configPath);
  const result = await run(w.options);
  assert.partialDeepStrictEqual(result.data, { success: true, configurationChecks: [{ file: target, status: "validated" }] });
  assert.deepStrictEqual((result.data.checked as { file: string }[]).map(row => row.file), [w.file]);
});
test("configuration diagnostics: metadata symlink escapes fail before any server starts", async () => {
  const w = changedConfiguration(), other = workspace(), start = mock.method(LspClient, "start");
  fs.rmSync(w.configPath); fs.symlinkSync(other.configPath, w.configPath);
  try { await assert.rejects(run(w.options), (error) => error instanceof Error && error.message.includes(String("outside the workspace"))); assert.strictEqual(start.mock.callCount(), 0); }
  finally { start.mock.restore(); }
});
