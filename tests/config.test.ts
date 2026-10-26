import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ancestors, availableServers, configPaths, executable, fileServers, gitRoot, languageId, loadConfig, matchesFile, MAX_FILE_BYTES, readText, resolveCommand, resolveFile, serverForLanguage, serverRoot, workspaceSource } from "../src/config.ts";
import { cleanWorkspaces, isolateGlobalConfig, setGlobalServers, workspace } from "./fixtures/workspace.ts";

let restoreConfig: () => void;
before(() => { restoreConfig = isolateGlobalConfig(); });
after(() => restoreConfig());
afterEach(cleanWorkspaces);

test("config: project overrides inherit builtins, preserve user overrides, and never mutate defaults", () => {
  const w = workspace();
  setGlobalServers({ "typescript-language-server": { args: ["--stdio", "--global-fixture"] } });
  const inheritedArgs = loadConfig(w.root)["typescript-language-server"].args;
  writeFileSync(w.configPath, JSON.stringify({ servers: { "typescript-language-server": { initOptions: { tsserver: { useSyntaxServer: "auto", fallbackPath: "custom" } } } } }));
  const first = loadConfig(w.root), second = loadConfig(w.root, true);
  assert.deepStrictEqual(first["typescript-language-server"].args, inheritedArgs);
  assert.deepStrictEqual(first["typescript-language-server"].args, ["--stdio", "--global-fixture"]);
  assert.deepStrictEqual(first["typescript-language-server"].initOptions?.tsserver, { useSyntaxServer: "auto", fallbackPath: "custom" });
  assert.deepStrictEqual(second["typescript-language-server"].initOptions?.tsserver, { useSyntaxServer: "never" });
  first["typescript-language-server"].args!.push("mutated");
  assert.deepStrictEqual(loadConfig(w.root, true)["typescript-language-server"].args, ["--stdio", "--global-fixture"]);
  assert.deepStrictEqual(loadConfig(w.root)["typescript-language-server"].args, ["--stdio", "--global-fixture"]);
});
test("config: hook scope preserves user overrides without reading malformed project configuration", () => {
  const w = workspace();
  setGlobalServers({ "typescript-language-server": { command: process.execPath, args: ["--global-server"], settings: { selected: "user" } } });
  writeFileSync(w.configPath, "{ malformed project configuration");
  assert.strictEqual((configPaths(w.root, true)).length, 1); assert.ok(!(configPaths(w.root, true)).includes(w.configPath));
  assert.partialDeepStrictEqual(loadConfig(w.root, true)["typescript-language-server"], { command: process.execPath, args: ["--global-server"], settings: { selected: "user" } });
  assert.throws(() => loadConfig(w.root), (error) => error instanceof Error && error.message.includes(String(w.configPath)));
});
for (const [caseIndex, caseValue] of ([
  { command: "" }, { command: 5 }, { args: "--stdio" }, { args: [1] }, { fileTypes: null }, { rootMarkers: [false] },
  { settings: [] }, { initOptions: null }, { disabled: "false" }, { isLinter: "true" }, { languageId: 1 },
  { warmupTimeoutMs: -1 }, { warmupTimeoutMs: "500" }, { warmupTimeoutMs: 2147483648 },
  { setup: { install: { default: 1 } } }, { setup: { docs: [] } },
]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = (override) => {
  const w = workspace(); writeFileSync(w.configPath, JSON.stringify({ servers: { fixture: { ...w.configs.fixture, ...override } } }));
  assert.throws(() => { loadConfig(w.root); }, (error) => error instanceof Error && error.message.includes(String("fixture")));
};
  test("config: invalid field %# is rejected before execution".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("config: invalid TypeScript init options and Python settings have clear errors", () => {
  const w = workspace(); writeFileSync(w.configPath, JSON.stringify({ servers: { "typescript-language-server": { initOptions: { tsserver: [] } } } }));
  assert.throws(() => loadConfig(w.root), (error) => error instanceof Error && error.message.includes(String("tsserver")));
  assert.throws(() => availableServers({ pyright: { ...w.configs.fixture, settings: { python: [] } } }, w.root), (error) => error instanceof Error && error.message.includes(String("settings.python")));
});
test("discovery: nearest roots, glob markers and disabled/missing servers", () => {
  const w = workspace(), sub = join(w.root, "nested/src"); mkdirSync(sub, { recursive: true });
  writeFileSync(join(w.root, "nested/inner.project"), "");
  assert.strictEqual(gitRoot(sub), w.root); assert.strictEqual(ancestors(sub)[0], sub);
  assert.strictEqual(serverRoot(sub, ["*.project"]), join(w.root, "nested"));
  assert.strictEqual(serverRoot(sub, ["missing.marker"]), undefined);
  assert.deepStrictEqual(availableServers({ disabled: { ...w.configs.fixture, disabled: true }, missing: { ...w.configs.fixture, command: "codex-lsp-no-such-bin" }, fixture: w.configs.fixture }, sub).map((s) => s.name), ["fixture"]);
});
test("discovery: local executables win, explicit relative paths resolve, and non-executable files are ignored", () => {
  const w = workspace(), bin = join(w.root, "node_modules/.bin"); mkdirSync(bin, { recursive: true });
  const name = process.platform === "win32" ? "fixture.exe" : "fixture", path = join(bin, name);
  writeFileSync(path, "binary"); chmodSync(path, 0o755);
  assert.strictEqual(resolveCommand("fixture", w.root), path);
  assert.strictEqual(resolveCommand(`./node_modules/.bin/${name}`, w.root), path);
  assert.strictEqual(executable(bin), false);
  if (process.platform !== "win32") { chmodSync(path, 0o600); assert.strictEqual(executable(path), false); }
});
test("discovery: basenames, case-insensitive extensions, server ordering and language aliases", () => {
  const w = workspace(), config = { ...w.configs.fixture, fileTypes: [".TS", "Dockerfile"] };
  assert.strictEqual(matchesFile(config, "a.ts"), true); assert.strictEqual(matchesFile(config, "Dockerfile"), true); assert.strictEqual(matchesFile(config, "a.py"), false);
  const base = { ...config, root: w.root, resolvedCommand: process.execPath };
  assert.deepStrictEqual(fileServers([{ ...base, name: "lint", isLinter: true }, { ...base, name: "semantic" }], "a.ts").map((s) => s.name), ["semantic", "lint"]);
  const configs = loadConfig(w.root, true);
  for (const [language, server] of [["Rust", "rust-analyzer"], ["python", "pyright"], ["typescript", "typescript-language-server"], ["c++", "clangd"], ["docker", "dockerls"], [".rs", "rust-analyzer"]]) assert.strictEqual(serverForLanguage(language, configs), server);
  assert.strictEqual(languageId(config, "Dockerfile"), "dockerfile"); assert.strictEqual(languageId(config, "a.tsx"), "typescriptreact"); assert.strictEqual(languageId(config, "unknown"), "plaintext"); assert.strictEqual(languageId({ ...config, languageId: "custom" }, "a.ts"), "custom");
});
test("files: resolve symlinks, reject directories/oversized/binary files and preserve BOM", () => {
  const w = workspace(), link = join(w.root, "link.fixture"); symlinkSync(w.file, link);
  assert.strictEqual(resolveFile(link, w.root), w.file); assert.throws(() => resolveFile(w.root, w.root), (error) => error instanceof Error && error.message.includes(String("regular file")));
  writeFileSync(w.file, "\uFEFFvalue\r\n"); assert.strictEqual(readText(w.file), "\uFEFFvalue\r\n");
  writeFileSync(w.file, Buffer.from([0xff])); assert.throws(() => readText(w.file));
  truncateSync(w.file, MAX_FILE_BYTES + 1); assert.throws(() => resolveFile(w.file, w.root), (error) => error instanceof Error && error.message.includes(String("16 MiB")));
});
test("workspace source: skip dependencies, symlink directories and oversized files", () => {
  const w = workspace();
  for (const name of [".git", ".codex", ".claude", "node_modules", ".venv", "venv", "target", "dist", "build"]) { mkdirSync(join(w.root, name), { recursive: true }); writeFileSync(join(w.root, name, "first.fixture"), "ignored"); }
  const big = join(w.root, "a.fixture"); writeFileSync(big, ""); truncateSync(big, MAX_FILE_BYTES + 1);
  const other = workspace(); symlinkSync(other.root, join(w.root, "b-link"));
  const server = { ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath };
  assert.strictEqual(workspaceSource(server), w.file);
  assert.strictEqual(readFileSync(w.file, "utf8"), "value = 1\n");
});
