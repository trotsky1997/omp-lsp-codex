import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { LspClient } from "../src/client.ts";
import { parseOptions } from "../src/cli.ts";
import { run } from "../src/commands.ts";
import { fileUri, object, serverRoot } from "../src/config.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
beforeAll(() => { restore = isolateGlobalConfig(); });
afterAll(() => restore());
afterEach(async () => {
  const leaked = LspClient.active.size;
  await Promise.all([...LspClient.active].map(client => client.close()));
  cleanWorkspaces(); expect(leaked).toBe(0);
});

function monorepo() {
  const w = workspace(), project = join(w.root, "crates/core"), file = join(project, "source.fixture"), sibling = join(w.root, "sibling.fixture");
  fs.mkdirSync(project, { recursive: true }); fs.renameSync(w.file, file);
  fs.writeFileSync(join(project, "fixture.project"), ""); fs.writeFileSync(sibling, "value = 2\n");
  const edit = { changes: { [fileUri(file)]: [{ range, newText: "renamed" }], [fileUri(sibling)]: [{ range, newText: "renamed" }] } };
  return { ...w, project, file, sibling, edit, args: (command: string, ...flags: string[]) => ({ ...w.args(command, ...flags), file }) };
}

test.each(["rename", "code-actions", "request", "rename-file"])("monorepo: %s updates sibling packages within the checkout", async command => {
  const w = monorepo(), method = command === "rename" ? "textDocument/rename" : command === "code-actions" ? "textDocument/codeAction" : command === "request" ? "fixture/edit" : "workspace/willRenameFiles";
  w.setScenario({ responses: { [method]: command === "code-actions" ? [{ title: "Fix", edit: w.edit }] : w.edit } });
  const flags = command === "code-actions" ? ["--query", "0"] : command === "request" ? ["--method", method] : ["--new-name", command === "rename-file" ? "renamed.fixture" : "renamed"];
  const result = await run(w.args(command, ...flags, "--apply"));
  expect(result.data).toMatchObject({ applied: true, verification: "pending" });
  expect(String(result.data.hint)).toContain("build/tests"); expect(result.human).toContain("verification pending");
  expect(fs.readFileSync(command === "rename-file" ? join(w.project, "renamed.fixture") : w.file, "utf8")).toBe("renamed = 1\n");
  expect(fs.readFileSync(w.sibling, "utf8")).toBe("renamed = 2\n");
  expect(object(w.events().find(e => e.method === "initialize")?.params).rootUri).toBe(fileUri(w.project));
});
test("rename: incomplete server edits require project verification after writes", async () => {
  const w = monorepo();
  w.setScenario({ responses: { "textDocument/rename": { changes: { [fileUri(w.file)]: w.edit.changes[fileUri(w.file)] } } } });
  const result = await run(w.args("rename", "--new-name", "renamed", "--apply"));
  expect(result.data).toMatchObject({ success: true, applied: true, verification: "pending" });
  expect(String(result.data.hint)).toContain("code-actions");
  expect(fs.readFileSync(w.sibling, "utf8")).toBe("value = 2\n");
  expect(w.events().some(e => e.method === "textDocument/diagnostic")).toBe(false);
});
test("raw request: a command with no edits has no pending edit verification", async () => {
  const w = workspace(), result = await run(w.args("request", "--method", "fixture/echo", "--payload", "{}", "--apply"));
  expect(result.data.applied).toBe(false); expect(result.data.verification).toBeUndefined();
});
test.each(["no-git", "nested-git", "target-nested-git", "symlink-escape"])("monorepo: %s preserves the edit boundary and every file", async kind => {
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
  await expect(run(w.args("rename", "--new-name", "renamed", "--apply"))).rejects.toThrow("outside the workspace");
  expect(fs.readFileSync(w.file, "utf8")).toBe("value = 1\n");
  expect(fs.readFileSync(w.sibling, "utf8")).toBe(kind === "symlink-escape" ? "value = 1\n" : "value = 2\n");
});
test("monorepo: a failed sibling write rolls back earlier changes", async () => {
  const w = monorepo(), rename = fs.renameSync;
  w.setScenario({ responses: { "textDocument/rename": w.edit } });
  const fault = spyOn(fs, "renameSync").mockImplementation((source, target) => {
    if (target === w.sibling) throw new Error("injected sibling write failure");
    rename(source, target);
  });
  try { await expect(run(w.args("rename", "--new-name", "renamed", "--apply"))).rejects.toThrow("injected sibling"); }
  finally { fault.mockRestore(); }
  expect(fs.readFileSync(w.file, "utf8")).toBe("value = 1\n");
  expect(fs.readFileSync(w.sibling, "utf8")).toBe("value = 2\n");
  expect(fs.readdirSync(w.project).some(name => name.endsWith(".tmp"))).toBe(false);
});
test.each(["sibling", "nested-checkout", "outside-checkout"])("file rename: %s destination respects the checkout boundary", async kind => {
  const w = monorepo(), other = workspace(), folder = kind === "outside-checkout" ? other.root : join(w.root, "destination");
  fs.mkdirSync(folder, { recursive: true });
  if (kind === "nested-checkout") fs.writeFileSync(join(folder, ".git"), "gitdir: other-checkout\n");
  const destination = join(folder, "moved.fixture");
  if (kind === "sibling") {
    expect((await run(w.args("rename-file", "--new-name", destination, "--apply"))).data.applied).toBe(true);
    expect(fs.readFileSync(destination, "utf8")).toBe("value = 1\n"); expect(fs.existsSync(w.file)).toBe(false);
  } else {
    await expect(run(w.args("rename-file", "--new-name", destination, "--apply"))).rejects.toThrow("inside the workspace");
    expect(fs.readFileSync(w.file, "utf8")).toBe("value = 1\n"); expect(fs.existsSync(destination)).toBe(false);
  }
});
test("missing files: discovery explains how to recover before any server starts", async () => {
  const w = workspace(), start = spyOn(LspClient, "start");
  try {
    await expect(run({ ...w.args("status"), file: join(w.root, "wrong file.fixture") })).rejects.toThrow("rg --files");
    expect(start).not.toHaveBeenCalled();
  } finally { start.mockRestore(); }
});
test("cwd: relative context overrides preserve spaces and canonical paths", () => {
  const w = workspace(), directory = join(w.root, "项目 with spaces"); fs.mkdirSync(directory);
  expect(parseOptions(["status", "--cwd", "项目 with spaces"], w.root).cwd).toBe(fs.realpathSync(directory));
});
test("cwd: setup and relative file queries use the selected project", async () => {
  const target = workspace(), caller = workspace(), before = fs.readFileSync(caller.configPath);
  await run(parseOptions(["setup", "fixture", "--project", "--cwd", target.root], caller.root));
  expect((await run(parseOptions(["status", "--file", "source.fixture", "--cwd", target.root], caller.root))).data.servers).toMatchObject([{ name: "fixture", root: target.root }]);
  expect(fs.readFileSync(caller.configPath)).toEqual(before);
  expect(JSON.parse(fs.readFileSync(target.configPath, "utf8")).servers.fixture.rootMarkers).toContain(".codex/lsp.json");
});
test("cwd: files and empty contexts fail before startup", () => {
  const w = workspace();
  for (const path of ["", w.file]) expect(() => parseOptions(["status", "--cwd", path])).toThrow("--cwd");
});
test.each(["fixture.project", "*.sln"])("discovery: %s markers stay within the nearest checkout", marker => {
  const w = workspace(), nested = join(w.root, "nested-checkout");
  fs.mkdirSync(nested); fs.writeFileSync(join(nested, ".git"), "gitdir: metadata\n");
  fs.writeFileSync(join(w.root, "external.sln"), "");
  expect(serverRoot(nested, [marker])).toBeUndefined();
});
test("hook startup: runtime directory and project context stay independent", async () => {
  const w = workspace(), root = resolve(import.meta.dir, ".."), sentinel = join(w.root, "preload-ran"), trap = join(w.root, "trap.ts");
  expect(Bun.spawnSync(["git", "init", "-q", w.root]).exitCode).toBe(0);
  fs.writeFileSync(join(w.root, ".gitignore"), "*\n");
  fs.writeFileSync(trap, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, process.cwd()); if (process.cwd() === ${JSON.stringify(w.root)}) process.exit(91);`);
  const control = Bun.spawn([process.execPath, "--preload", trap, join(root, "src/cli.ts"), "hook", "stop"], { cwd: w.root, stdout: "pipe", stderr: "pipe", timeout: 2000 });
  await Promise.all([new Response(control.stdout).text(), new Response(control.stderr).text()]);
  expect(await control.exited).toBe(91); expect(fs.existsSync(sentinel)).toBe(true); fs.unlinkSync(sentinel);
  for (const [file, variable] of [["codex-hooks.json", "PLUGIN_ROOT"], ["hooks.json", "CLAUDE_PLUGIN_ROOT"]]) {
    const manifest = JSON.parse(fs.readFileSync(join(root, "hooks", file), "utf8"));
    for (const entries of Object.values(manifest.hooks) as { hooks: { command: string }[] }[][])
      for (const entry of entries) for (const hook of entry.hooks) expect(hook.command.startsWith('bun --cwd "${' + variable + '}" ')).toBe(true);
  }
  const proc = Bun.spawn([process.execPath, "--cwd", root, "--preload", trap, join(root, "src/cli.ts"), "hook", "stop"], { cwd: w.root, env: { ...process.env, CLAUDE_PLUGIN_ROOT: "" }, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 8000 });
  proc.stdin.write(JSON.stringify({ cwd: w.root })); await proc.stdin.flush(); proc.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(exit).toBe(0); expect(stderr).toBe(""); expect(JSON.parse(stdout)).toEqual({ continue: true }); expect(fs.readFileSync(sentinel, "utf8")).toBe(root);
});
test.each(["inspect --file source.fixture --json", "setup --project typescript"])("arguments: a quoted command string %s has a recovery hint", command => {
  expect(() => parseOptions([command])).toThrow("separate arguments");
  expect(parseOptions(["hover", "--file", "a file with spaces.ts"]).file).toBe("a file with spaces.ts");
});
test.each(["{}", '{"textDocument":{}}'])("raw request: inferred positions are checked before startup with payload=%s", async payload => {
  const w = workspace(), start = spyOn(LspClient, "start");
  try {
    await expect(run(w.args("request", "--method", "textDocument/hover", "--payload", payload, "--line", "999"))).rejects.toThrow("outside this file");
    expect(start).not.toHaveBeenCalled();
  } finally { start.mockRestore(); }
});
test("raw request: explicit LSP position overrides unused CLI coordinates", async () => {
  const w = workspace();
  expect((await run(w.args("request", "--method", "textDocument/hover", "--payload", '{"position":{"line":0,"character":0}}', "--line", "999"))).data.success).toBe(true);
});
test.each([{ timeout: 50, hint: "--timeout 120" }, { timeout: 120000, hint: "--timeout 240" }, { timeout: 300000, hint: "project dependencies" }])("readiness: recovery respects the timeout ceiling %#", async ({ timeout, hint }) => {
  const w = workspace(), client = await LspClient.start({ ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath }, timeout);
  try { await expect(client.waitWorkspace(15)).rejects.toThrow(hint); }
  finally { await client.close(); }
});
test("request: subsecond timeouts retain the actual duration", async () => {
  const w = workspace(), client = await LspClient.start({ ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath }, 1000);
  try { await expect(client.request("fixture/stall", {}, 15)).rejects.toThrow("0.015s"); }
  finally { await client.close(); }
});
test("inspect: verified code errors have an explicit explanation beside the aggregate status", async () => {
  const w = workspace({ diagnostics: [{ range, message: "project type error", severity: 1 }], responses: { "textDocument/hover": { contents: "value" } } });
  const result = await run(w.args("inspect"));
  expect(result.data).toMatchObject({ success: false, failedSections: ["diagnostics"], results: { diagnostics: { verified: true, hasErrors: true } } });
  expect(String(result.data.hint)).toContain("project code"); expect(result.human).toContain("verified");
});
