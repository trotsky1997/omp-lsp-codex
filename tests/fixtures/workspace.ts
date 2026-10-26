import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOptions } from "../../src/cli.ts";
import { type ObjectValue, type ServerConfig, fileUri } from "../../src/config.ts";
import defaults from "../../src/defaults.json" with { type: "json" };

const roots: string[] = [];
let globalServers: Record<string, unknown> = {};
let isolatedHome = "";
export function setGlobalServers(servers: Record<string, unknown>) {
  globalServers = servers;
  if (isolatedHome) writeFileSync(join(isolatedHome, ".codex/lsp.json"), JSON.stringify({ servers }));
}
export function isolateGlobalConfig() {
  const oldHome = process.env.HOME, oldUserProfile = process.env.USERPROFILE;
  isolatedHome = mkdtempSync(join(tmpdir(), "codex-lsp home "));
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  globalServers = {};
  mkdirSync(join(isolatedHome, ".codex"));
  setGlobalServers(globalServers);
  return () => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUserProfile;
    rmSync(isolatedHome, { recursive: true, force: true });
    isolatedHome = "";
  };
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
    fixture: { command: process.execPath, args: [join(dirname(fileURLToPath(import.meta.url)), "lsp-server.js"), "scenario", trace, scenarioPath], fileTypes: [".fixture"], rootMarkers: ["fixture.project"] },
  };
  const configPath = join(root, ".codex/lsp.json");
  const saveConfig = () => writeFileSync(configPath, JSON.stringify({ servers: configs }));
  saveConfig();
  return {
    root, file, uri: fileUri(file), configPath, configs, saveConfig,
    setScenario: (value: ObjectValue) => writeFileSync(scenarioPath, JSON.stringify(value)),
    args: (command: string, ...flags: string[]) => ({ ...parseOptions([command, "--file", file, ...flags], root), timeout: 400 }),
    events: (): ObjectValue[] => readFileSync(trace, "utf8").split("\n").filter(Boolean).map((line: string) => JSON.parse(line) as ObjectValue),
  };
}
export function cleanWorkspaces() {
  setGlobalServers({});
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
export const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };
