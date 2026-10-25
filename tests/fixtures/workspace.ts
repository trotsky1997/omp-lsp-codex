import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import * as fs from "node:fs";
import { spyOn } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseOptions } from "../../src/cli.ts";
import { type ObjectValue, type ServerConfig, fileUri } from "../../src/config.ts";
import defaults from "../../src/defaults.json";

const roots: string[] = [];
let globalServers: Record<string, unknown> = {};
export function setGlobalServers(servers: Record<string, unknown>) { globalServers = servers; }
export function isolateGlobalConfig() {
  const path = join(homedir(), ".codex/lsp.json"), exists = fs.existsSync, read = fs.readFileSync;
  const existsSpy = spyOn(fs, "existsSync").mockImplementation((file) => file === path || exists(file));
  const readSpy = spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: BufferEncoding) => {
    if (file !== path) return Reflect.apply(read, fs, [file, options]);
    const text = JSON.stringify({ servers: globalServers });
    return options ? text : Buffer.from(text);
  }) as typeof fs.readFileSync);
  return () => { existsSpy.mockRestore(); readSpy.mockRestore(); };
}
export function workspace(scenario: ObjectValue = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-lsp commands ")));
  roots.push(root);
  mkdirSync(join(root, ".git")); mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, "fixture.project"), "");
  const file = join(root, "source.fixture"), trace = join(root, "wire.ndjson"), scenarioPath = join(root, "scenario.json");
  writeFileSync(file, "value = 1\n"); writeFileSync(scenarioPath, JSON.stringify(scenario));
  const configs: Record<string, ServerConfig> = {
    ...Object.fromEntries(Object.keys(defaults).map((name) => [name, { command: "missing", disabled: true }])),
    fixture: { command: process.execPath, args: [join(import.meta.dir, "lsp-server.ts"), "scenario", trace, scenarioPath], fileTypes: [".fixture"], rootMarkers: ["fixture.project"] },
  };
  const configPath = join(root, ".codex/lsp.json");
  const saveConfig = () => writeFileSync(configPath, JSON.stringify({ servers: configs }));
  saveConfig();
  return {
    root, file, uri: fileUri(file), configPath, configs, saveConfig,
    setScenario: (value: ObjectValue) => writeFileSync(scenarioPath, JSON.stringify(value)),
    args: (command: string, ...flags: string[]) => ({ ...parseOptions([command, "--file", file, ...flags], root), timeout: 400 }),
    events: () => readFileSync(trace, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as ObjectValue),
  };
}
export function cleanWorkspaces() {
  globalServers = {};
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
export const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };
