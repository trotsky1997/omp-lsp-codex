import assert from "node:assert/strict";
import { after, afterEach, before, test, mock } from "node:test";
import { parseOptions, main } from "../src/cli.ts";
import { hook } from "../src/hooks.ts";
import childProcess from "node:child_process";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";

let restoreConfig: () => void;
before(() => { restoreConfig = isolateGlobalConfig(); });

let event: unknown = {}, result: unknown = { success: true }, stderr = "", exitCode = 0, spawnError = false, instrumented = false, malformedInput = false;
const calls: unknown[][] = [], output: string[] = [];
const stdinSpy = mock.method(process.stdin, Symbol.asyncIterator, async function* () {
  yield Buffer.from(malformedInput ? "{" : JSON.stringify(event));
});
const execSpy = mock.method(childProcess, "execFile", ((file: string, argv: string[], options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
  if (!instrumented) throw new Error("Unexpected real execFile call in hook test");
  calls.push([file, argv, options]);
  if (spawnError) { const error = new Error("injected spawn failure"); callback(error, "", stderr); return; }
  const stdout = typeof result === "string" ? result : JSON.stringify(result);
  const error = exitCode === 0 ? null : Object.assign(new Error("injected child failure"), { code: exitCode, killed: false, signal: null });
  callback(error, stdout, stderr);
}) as never);
const logSpy = mock.method(console, "log", (value: unknown) => { output.push(String(value)); });
const errorSpy = mock.method(console, "error", (value: unknown) => { output.push(String(value)); });
const originalClaude = process.env.CLAUDE_PLUGIN_ROOT;
function instrument() {
  instrumented = true;
}
afterEach(() => {
  instrumented = false; malformedInput = false;
  if (originalClaude === undefined) delete process.env.CLAUDE_PLUGIN_ROOT; else process.env.CLAUDE_PLUGIN_ROOT = originalClaude;
  event = {}; result = { success: true }; stderr = ""; exitCode = 0; spawnError = false;
  calls.length = 0; output.length = 0; cleanWorkspaces();
});
after(() => { stdinSpy.mock.restore(); execSpy.mock.restore(); logSpy.mock.restore(); errorSpy.mock.restore(); restoreConfig(); });
const args = (kind = "stop") => ({ ...parseOptions(["hook", kind]), timeout: 400 });
const decoded = () => output.map((s) => JSON.parse(s));

for (const [caseIndex, caseValue] of (["NaN", "Infinity", "oops"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = (timeout) => { assert.throws(() => parseOptions(["status", "--timeout", timeout]), (error) => error instanceof Error && error.message.includes(String("number"))); };
  test("CLI: timeout %s is rejected".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
for (const [caseIndex, caseValue] of (["0", "-1", "1.5", "NaN"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = (value) => { for (const flag of ["--line", "--column"]) assert.throws(() => parseOptions(["hover", `${flag}=${value}`]), (error) => error instanceof Error && error.message.includes(String("positive integers"))); };
  test("CLI: invalid line/column %s is rejected".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("CLI: clamps timeouts, parses all flags and validates unexpected arguments", () => {
  assert.strictEqual(parseOptions(["status", "--timeout", "0"]).timeout, 5000); assert.strictEqual(parseOptions(["status", "--timeout", "999"]).timeout, 300000);
  assert.partialDeepStrictEqual(parseOptions(["setup", "rust", "python", "--project", "--json", "--apply", "--changed", "--workspace", "--global-config-only", "--global-bins-only"]), { languages: ["rust", "python"], project: true, json: true, apply: true, changed: true, workspace: true, globalConfigOnly: true, globalBinsOnly: true });
  assert.throws(() => parseOptions(["hover", "extra"]), (error) => error instanceof Error && error.message.includes(String("Unexpected argument"))); assert.throws(() => parseOptions(["--unknown"]));
});
test("CLI: help, version, JSON and human errors have the right exit codes", async () => {
  assert.strictEqual(await main(["--help"]), 0); const help = output.pop()!;
  assert.match(help, /Multi-language LSP tools/); assert.ok(help.includes("Commands:"));
  assert.strictEqual(await main(["--version"]), 0); assert.match(output.pop()!, /^codex-lsp \d/);
  assert.strictEqual(await main(["unknown", "--json"]), 2); const error = JSON.parse(output.pop()!); assert.strictEqual(error.success, false); assert.match(error.error, /Unknown command: unknown/);
  assert.strictEqual(await main(["unknown"]), 2); assert.ok((output.pop()!).includes("codex-lsp: Unknown command"));
});
test("CLI: options without a command fail explicitly without starting a backend", async () => {
  assert.equal(await main([]), 0); assert.match(output.pop()!, /Commands:/);
  for (const flags of [["--file", "source.ts", "--json"], ["--json"], ["--cwd", ".", "--budget", "900"]]) {
    assert.equal(await main(flags), 2);
    const error=JSON.parse(output.pop()!); assert.equal(error.success,false); assert.match(error.error,/Missing command.*status --file PATH/);
  }
  assert.equal(await main(["--file", "source.ts"]),2); assert.match(output.pop()!,/codex-lsp: Missing command/);
  assert.equal(calls.length,0);
});
for (const [caseIndex, caseValue] of ([false, true]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (claude) => {
  if (claude) process.env.CLAUDE_PLUGIN_ROOT = "/fixture/plugin"; else delete process.env.CLAUDE_PLUGIN_ROOT;
  instrument(); await hook(args());
  assert.deepStrictEqual(decoded(), claude ? [] : [{ continue: true }]);
  const [file, command, options] = calls[0] as [string, string[], { timeout: number; cwd: string }];
  assert.strictEqual(file, process.execPath);
  assert.deepStrictEqual(command.slice(1), ["diagnostics", "--changed", "--global-config-only", "--global-bins-only", "--limit", "12", "--json", "--cwd", args().cwd]); assert.strictEqual(options.timeout, 110000);
};
  test("hooks: clean checks allow completion for Claude=%s".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
for (const [caseIndex, caseValue] of ([false, true]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (claude) => {
  if (claude) process.env.CLAUDE_PLUGIN_ROOT = "/fixture/plugin"; else delete process.env.CLAUDE_PLUGIN_ROOT;
  event = { stop_hook_active: true }; instrument(); await hook(args());
  assert.deepStrictEqual(calls, []); assert.deepStrictEqual(decoded(), claude ? [] : [{ continue: true }]);
};
  test("hooks: recursion guard never spawns for Claude=%s".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("hooks: session-start supplies bounded context and honors the event cwd", async () => {
  event = { cwd: "/fixture/workspace" }; result = { servers: Array.from({ length: 15 }, (_, i) => ({ name: `server-${i}` })) }; instrument();
  await hook(args("session-start"));
  const response = decoded()[0]; assert.strictEqual(response.hookSpecificOutput.hookEventName, "SessionStart"); assert.ok((response.hookSpecificOutput.additionalContext).includes("server-11")); assert.ok(!(response.hookSpecificOutput.additionalContext).includes("server-12"));
  assert.partialDeepStrictEqual(calls[0]?.[2], { cwd: args().cwd, timeout: 8000 });
  assert.deepStrictEqual((calls[0]?.[1] as string[]).slice(-2), ["--cwd", "/fixture/workspace"]);
});
test("hooks: verified errors block with bounded, actionable diagnostics", async () => {
  result = { success: false, verified: true, hasErrors: true, checked: [{ file: "source.fixture", diagnostics: Array.from({ length: 15 }, (_, i) => ({ message: `error ${i}`, range, severity: i === 14 ? 2 : 1 })) }] }; exitCode = 1; instrument(); await hook(args());
  assert.partialDeepStrictEqual(decoded()[0], { decision: "block" }); assert.ok((decoded()[0].reason).includes("source.fixture:1: error 0")); assert.ok((decoded()[0].reason).includes("and 2 more"));
});
test("hooks: huge provider messages and recovery errors have a fixed output budget", async () => {
  result = { success: false, verified: true, hasErrors: true, counts: { errors: 2 }, checked: [{ file: "source.fixture", diagnostics: [
    { message: "x".repeat(200000), range, severity: 1 }, { message: "second error", range, severity: 1 },
  ] }] }; exitCode = 1; instrument(); await hook(args());
  assert.strictEqual(decoded()[0].decision, "block"); assert.ok(output[0].length < 7000); assert.ok(decoded()[0].reason.includes("second error")); assert.ok(decoded()[0].reason.includes("diagnostics --changed"));
  output.length = 0; result = { success: false, error: "context failure " + "x".repeat(200000) }; exitCode = 2; await hook(args());
  assert.ok(output[0].length < 7000); assert.ok(decoded()[0].systemMessage.includes("context failure")); assert.strictEqual(decoded()[0].continue, undefined);
});
test("hooks: compact child output still reports the full error count", async () => {
  result = { success: false, verified: true, hasErrors: true, truncated: true, counts: { errors: 100 }, checked: [{ file: "source.fixture", diagnostics: Array.from({ length: 12 }, (_, i) => ({ message: `error ${i}`, range, severity: 1 })) }] };
  exitCode = 1; instrument(); await hook(args());
  assert.strictEqual(decoded()[0].decision, "block"); assert.ok(decoded()[0].reason.includes("and 88 more")); assert.ok(decoded()[0].reason.includes("--limit 0")); assert.ok(output[0].length < 1500);
});
test("hooks: CLI context errors retain their actionable detail", async () => {
  result = { success: false, error: "--cwd must name a directory" }; exitCode = 2; instrument();
  await hook(args()); assert.ok((decoded()[0].systemMessage).includes("--cwd must name a directory"));
});
test("hooks: unverified files retain bounded recovery reasons and project context guidance", async () => {
  result = { success: false, verified: false, checked: [
    { file: "config.json", errors: ["No available language server; run codex-lsp setup json"] },
    { file: "source.fixture", errors: Array.from({ length: 10 }, () => "injected server failure " + "x".repeat(2000)) },
  ] }; exitCode = 1; instrument(); await hook(args());
  const message = String(decoded()[0].systemMessage);
  assert.ok((message).includes("config.json: No available language server")); assert.ok((message).includes("setup json"));
  assert.ok((message).includes("--cwd <project-root>")); assert.ok(message.length < 1100);
  assert.strictEqual(decoded()[0].decision, undefined);
});
for (const [caseIndex, caseValue] of (["unverified", "nonzero", "empty", "invalid JSON", "spawn failure"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (fault) => {
  result = fault === "empty" ? "" : fault === "invalid JSON" ? "{" : fault === "unverified" ? { success: false, verified: false } : { success: true };
  exitCode = fault === "nonzero" ? 23 : 0; stderr = "injected child failure"; spawnError = fault === "spawn failure"; instrument(); await hook(args());
  assert.ok((decoded()[0]?.systemMessage).includes("LSP diagnostics")); assert.strictEqual(decoded()[0]?.continue, undefined);
};
  test("hooks: %s cannot grant a verified completion".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("hooks: session-start failures stay quiet; invalid event names fail clearly", async () => {
  spawnError = true; instrument(); await hook(args("session-start")); assert.deepStrictEqual(output, []);
  await assert.rejects(hook(args("invalid")), (error) => error instanceof Error && error.message.includes(String("session-start or hook stop")));
});
test("CLI: hook invalid input surfaces structured errors", async () => {
  malformedInput = true; instrument(); assert.strictEqual(await main(["hook", "stop", "--json"]), 2);
  assert.strictEqual(decoded()[0].success, false); assert.match(String(decoded()[0].error), /JSON/);
});
test("CLI: successful human and JSON command output", async () => {
  const w = workspace();
  assert.strictEqual(await main(["symbols", "--file", w.file, "--json"]), 0); assert.strictEqual(JSON.parse(output.pop()!).success, true);
  assert.strictEqual(await main(["symbols", "--file", w.file]), 0); assert.strictEqual(output.pop(), "No symbols found");
});
