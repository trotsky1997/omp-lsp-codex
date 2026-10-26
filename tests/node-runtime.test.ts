import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsCommand } from "../src/windows-command.ts";
import { resolveCommand } from "../src/config.ts";
import { cleanWorkspaces, isolateGlobalConfig, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); });
after(() => restore());
afterEach(() => cleanWorkspaces());
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("global discovery: a project PATH entry cannot hide an eligible global server", () => {
  const project = workspace(), global = workspace(), name = process.platform === "win32" ? "fixture-server.EXE" : "fixture-server";
  for (const root of [project.root, global.root]) {
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", name), "fixture"); chmodSync(join(root, "bin", name), 0o755);
  }
  const previous = process.env.PATH;
  process.env.PATH = [join(project.root, "bin"), join(global.root, "bin")].join(delimiter);
  try {
    assert.equal(resolveCommand(name, project.root), join(project.root, "bin", name));
    assert.equal(resolveCommand(name, project.root, true), join(global.root, "bin", name));
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
  }
});

test("Node launcher: project cwd and package type do not alter the installed CLI", () => {
  const w = workspace(), marker = join(w.root, "unexpected-preload");
  writeFileSync(join(w.root, "package.json"), '{"type":"commonjs"}\n');
  writeFileSync(join(w.root, "trap.cjs"), 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "loaded");\n');
  writeFileSync(join(w.root, "bunfig.toml"), 'preload = ["./trap.cjs"]\n');
  const result = spawnSync(process.execPath, [cli, "doctor", "--file", "source.fixture", "--json"], {
    cwd: w.root, encoding: "utf8", timeout: 10000, killSignal: "SIGKILL",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const data = JSON.parse(result.stdout);
  assert.equal(data.runtime.node, process.versions.node);
  assert.equal(data.runtime.executable, process.execPath);
  assert.equal(Object.hasOwn(data.runtime, "bun"), false);
  assert(data.servers.some((server: { name: string; root: string }) => server.name === "fixture" && server.root === w.root));
  assert.equal(existsSync(marker), false);
});

test("Node launcher: a version subcommand mistake names the supported flag", () => {
  const w = workspace(), result = spawnSync(process.execPath, [cli, "version", "--json"], {
    cwd: w.root, encoding: "utf8", timeout: 5000, killSignal: "SIGKILL",
  });
  assert.equal(result.status, 2);
  assert.match(JSON.parse(result.stdout).error, /codex-lsp --version/);
});

test("Windows command shims: spaces and empty arguments survive cmd quoting", () => {
  const result = windowsCommand("C:/Program Files/server.cmd", ["--stdio", ""]);
  assert.deepEqual(result.args, ["/d", "/s", "/c", '"C:\\Program^ Files\\server.cmd ^"--stdio^" ^"^""']);
  assert.equal(result.windowsVerbatimArguments, true);
});

test("Windows npm shims: forwarded metacharacters retain both escaping layers", () => {
  const args = ["a&b", 'a"b', "C:\\trailing\\"], before = [...args];
  const result = windowsCommand("C:\\project\\node_modules\\.bin\\server.cmd", args);
  assert(result.args[3].includes("a^^^&b"));
  assert(result.args[3].includes("^^^\""));
  assert.deepEqual(args, before);
});
