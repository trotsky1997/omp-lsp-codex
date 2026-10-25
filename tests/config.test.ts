import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ancestors, availableServers, executable, fileServers, gitRoot, languageId, loadConfig, matchesFile, MAX_FILE_BYTES, readText, resolveCommand, resolveFile, serverForLanguage, serverRoot, workspaceSource } from "../src/config.ts";
import { cleanWorkspaces, isolateGlobalConfig, setGlobalServers, workspace } from "./fixtures/workspace.ts";

let restoreConfig: () => void;
beforeAll(() => { restoreConfig = isolateGlobalConfig(); });
afterAll(() => restoreConfig());
afterEach(cleanWorkspaces);

test("config: project overrides inherit builtins, preserve user overrides, and never mutate defaults", () => {
  const w = workspace();
  setGlobalServers({ "typescript-language-server": { args: ["--stdio", "--global-fixture"] } });
  const inheritedArgs = loadConfig(w.root)["typescript-language-server"].args;
  writeFileSync(w.configPath, JSON.stringify({ servers: { "typescript-language-server": { initOptions: { tsserver: { useSyntaxServer: "auto", fallbackPath: "custom" } } } } }));
  const first = loadConfig(w.root), second = loadConfig(w.root, true);
  expect(first["typescript-language-server"].args).toEqual(inheritedArgs);
  expect(first["typescript-language-server"].args).toEqual(["--stdio", "--global-fixture"]);
  expect(first["typescript-language-server"].initOptions?.tsserver).toEqual({ useSyntaxServer: "auto", fallbackPath: "custom" });
  expect(second["typescript-language-server"].initOptions?.tsserver).toEqual({ useSyntaxServer: "never" });
  first["typescript-language-server"].args!.push("mutated");
  expect(loadConfig(w.root, true)["typescript-language-server"].args).toEqual(["--stdio"]);
});
test.each([
  { command: "" }, { command: 5 }, { args: "--stdio" }, { args: [1] }, { fileTypes: null }, { rootMarkers: [false] },
  { settings: [] }, { initOptions: null }, { disabled: "false" }, { isLinter: "true" }, { languageId: 1 },
  { warmupTimeoutMs: -1 }, { warmupTimeoutMs: "500" }, { warmupTimeoutMs: 2147483648 },
  { setup: { install: { default: 1 } } }, { setup: { docs: [] } },
])("config: invalid field %# is rejected before execution", (override) => {
  const w = workspace(); writeFileSync(w.configPath, JSON.stringify({ servers: { fixture: { ...w.configs.fixture, ...override } } }));
  expect(() => { loadConfig(w.root); }).toThrow("fixture");
});
test("config: invalid TypeScript init options and Python settings have clear errors", () => {
  const w = workspace(); writeFileSync(w.configPath, JSON.stringify({ servers: { "typescript-language-server": { initOptions: { tsserver: [] } } } }));
  expect(() => loadConfig(w.root)).toThrow("tsserver");
  expect(() => availableServers({ pyright: { ...w.configs.fixture, settings: { python: [] } } }, w.root)).toThrow("settings.python");
});
test("discovery: nearest roots, glob markers and disabled/missing servers", () => {
  const w = workspace(), sub = join(w.root, "nested/src"); mkdirSync(sub, { recursive: true });
  writeFileSync(join(w.root, "nested/inner.project"), "");
  expect(gitRoot(sub)).toBe(w.root); expect(ancestors(sub)[0]).toBe(sub);
  expect(serverRoot(sub, ["*.project"])).toBe(join(w.root, "nested"));
  expect(serverRoot(sub, ["missing.marker"])).toBeUndefined();
  expect(availableServers({ disabled: { ...w.configs.fixture, disabled: true }, missing: { ...w.configs.fixture, command: "codex-lsp-no-such-bin" }, fixture: w.configs.fixture }, sub).map((s) => s.name)).toEqual(["fixture"]);
});
test("discovery: local executables win, explicit relative paths resolve, and non-executable files are ignored", () => {
  const w = workspace(), bin = join(w.root, "node_modules/.bin"); mkdirSync(bin, { recursive: true });
  const name = process.platform === "win32" ? "fixture.exe" : "fixture", path = join(bin, name);
  writeFileSync(path, "binary"); chmodSync(path, 0o755);
  expect(resolveCommand("fixture", w.root)).toBe(path);
  expect(resolveCommand(`./node_modules/.bin/${name}`, w.root)).toBe(path);
  expect(executable(bin)).toBe(false);
  if (process.platform !== "win32") { chmodSync(path, 0o600); expect(executable(path)).toBe(false); }
});
test("discovery: basenames, case-insensitive extensions, server ordering and language aliases", () => {
  const w = workspace(), config = { ...w.configs.fixture, fileTypes: [".TS", "Dockerfile"] };
  expect(matchesFile(config, "a.ts")).toBe(true); expect(matchesFile(config, "Dockerfile")).toBe(true); expect(matchesFile(config, "a.py")).toBe(false);
  const base = { ...config, root: w.root, resolvedCommand: process.execPath };
  expect(fileServers([{ ...base, name: "lint", isLinter: true }, { ...base, name: "semantic" }], "a.ts").map((s) => s.name)).toEqual(["semantic", "lint"]);
  const configs = loadConfig(w.root, true);
  for (const [language, server] of [["Rust", "rust-analyzer"], ["python", "pyright"], ["typescript", "typescript-language-server"], ["c++", "clangd"], ["docker", "dockerls"], [".rs", "rust-analyzer"]]) expect(serverForLanguage(language, configs)).toBe(server);
  expect(languageId(config, "Dockerfile")).toBe("dockerfile"); expect(languageId(config, "a.tsx")).toBe("typescriptreact"); expect(languageId(config, "unknown")).toBe("plaintext"); expect(languageId({ ...config, languageId: "custom" }, "a.ts")).toBe("custom");
});
test("files: resolve symlinks, reject directories/oversized/binary files and preserve BOM", () => {
  const w = workspace(), link = join(w.root, "link.fixture"); symlinkSync(w.file, link);
  expect(resolveFile(link, w.root)).toBe(w.file); expect(() => resolveFile(w.root, w.root)).toThrow("regular file");
  writeFileSync(w.file, "\uFEFFvalue\r\n"); expect(readText(w.file)).toBe("\uFEFFvalue\r\n");
  writeFileSync(w.file, Buffer.from([0xff])); expect(() => readText(w.file)).toThrow();
  truncateSync(w.file, MAX_FILE_BYTES + 1); expect(() => resolveFile(w.file, w.root)).toThrow("16 MiB");
});
test("workspace source: skip dependencies, symlink directories and oversized files", () => {
  const w = workspace();
  for (const name of [".git", ".codex", ".claude", "node_modules", ".venv", "venv", "target", "dist", "build"]) { mkdirSync(join(w.root, name), { recursive: true }); writeFileSync(join(w.root, name, "first.fixture"), "ignored"); }
  const big = join(w.root, "a.fixture"); writeFileSync(big, ""); truncateSync(big, MAX_FILE_BYTES + 1);
  const other = workspace(); symlinkSync(other.root, join(w.root, "b-link"));
  const server = { ...w.configs.fixture, name: "fixture", root: w.root, resolvedCommand: process.execPath };
  expect(workspaceSource(server)).toBe(w.file);
  expect(readFileSync(w.file, "utf8")).toBe("value = 1\n");
});
