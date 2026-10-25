import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { parseOptions, main } from "../src/cli.ts";
import { hook } from "../src/hooks.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";

let restoreConfig: () => void;
beforeAll(() => { restoreConfig = isolateGlobalConfig(); });

let event: unknown = {}, result: unknown = { success: true }, stderr = "", exitCode = 0, spawnError = false, instrumented = false, malformedInput = false;
const calls: unknown[][] = [], output: string[] = [];
const stdinSpy = spyOn(Bun.stdin, "json").mockImplementation(async () => { if (malformedInput) throw new Error("Invalid JSON input"); return event; });
const originalSpawn = Bun.spawn;
const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
  if (!instrumented) return Reflect.apply(originalSpawn, Bun, args);
  calls.push(args);
  if (spawnError) throw new Error("injected spawn failure");
  return { stdout: new Response(typeof result === "string" ? result : JSON.stringify(result)).body, stderr: new Response(stderr).body, exited: Promise.resolve(exitCode) };
}) as typeof Bun.spawn);
const logSpy = spyOn(console, "log").mockImplementation((value) => { output.push(String(value)); });
const errorSpy = spyOn(console, "error").mockImplementation((value) => { output.push(String(value)); });
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
afterAll(() => { stdinSpy.mockRestore(); spawnSpy.mockRestore(); logSpy.mockRestore(); errorSpy.mockRestore(); restoreConfig(); });
const args = (kind = "stop") => ({ ...parseOptions(["hook", kind]), timeout: 400 });
const decoded = () => output.map((s) => JSON.parse(s));

test.each(["NaN", "Infinity", "oops"])("CLI: timeout %s is rejected", (timeout) => { expect(() => parseOptions(["status", "--timeout", timeout])).toThrow("number"); });
test.each(["0", "-1", "1.5", "NaN"])("CLI: invalid line/column %s is rejected", (value) => { for (const flag of ["--line", "--column"]) expect(() => parseOptions(["hover", `${flag}=${value}`])).toThrow("positive integers"); });
test("CLI: clamps timeouts, parses all flags and validates unexpected arguments", () => {
  expect(parseOptions(["status", "--timeout", "0"]).timeout).toBe(5000); expect(parseOptions(["status", "--timeout", "999"]).timeout).toBe(300000);
  expect(parseOptions(["setup", "rust", "python", "--project", "--json", "--apply", "--changed", "--workspace", "--builtins-only", "--global-bins-only"])).toMatchObject({ languages: ["rust", "python"], project: true, json: true, apply: true, changed: true, workspace: true, builtinsOnly: true, globalBinsOnly: true });
  expect(() => parseOptions(["hover", "extra"])).toThrow("Unexpected argument"); expect(() => parseOptions(["--unknown"])).toThrow();
});
test("CLI: help, version, JSON and human errors have the right exit codes", async () => {
  expect(await main(["--help"])).toBe(0); expect(output.pop()).toContain("Commands:");
  expect(await main(["--version"])).toBe(0); expect(output.pop()).toMatch(/^codex-lsp \d/);
  expect(await main(["unknown", "--json"])).toBe(2); expect(JSON.parse(output.pop()!)).toMatchObject({ success: false, error: "Unknown command: unknown" });
  expect(await main(["unknown"])).toBe(2); expect(output.pop()).toContain("codex-lsp: Unknown command");
});
test.each([false, true])("hooks: clean checks allow completion for Claude=%s", async (claude) => {
  if (claude) process.env.CLAUDE_PLUGIN_ROOT = "/fixture/plugin"; else delete process.env.CLAUDE_PLUGIN_ROOT;
  instrument(); await hook(args());
  expect(decoded()).toEqual(claude ? [] : [{ continue: true }]);
  const [command, options] = calls[0] as [string[], { timeout: number }];
  expect(command.slice(2)).toEqual(["diagnostics", "--changed", "--builtins-only", "--global-bins-only", "--limit", "0", "--json"]); expect(options.timeout).toBe(110000);
});
test.each([false, true])("hooks: recursion guard never spawns for Claude=%s", async (claude) => {
  if (claude) process.env.CLAUDE_PLUGIN_ROOT = "/fixture/plugin"; else delete process.env.CLAUDE_PLUGIN_ROOT;
  event = { stop_hook_active: true }; instrument(); await hook(args());
  expect(calls).toEqual([]); expect(decoded()).toEqual(claude ? [] : [{ continue: true }]);
});
test("hooks: session-start supplies bounded context and honors the event cwd", async () => {
  event = { cwd: "/fixture/workspace" }; result = { servers: Array.from({ length: 15 }, (_, i) => ({ name: `server-${i}` })) }; instrument();
  await hook(args("session-start"));
  const response = decoded()[0]; expect(response.hookSpecificOutput.hookEventName).toBe("SessionStart"); expect(response.hookSpecificOutput.additionalContext).toContain("server-11"); expect(response.hookSpecificOutput.additionalContext).not.toContain("server-12");
  expect(calls[0]?.[1]).toMatchObject({ cwd: "/fixture/workspace", timeout: 8000 });
});
test("hooks: verified errors block with bounded, actionable diagnostics", async () => {
  result = { success: false, verified: true, hasErrors: true, checked: [{ file: "source.fixture", diagnostics: Array.from({ length: 15 }, (_, i) => ({ message: `error ${i}`, range, severity: i === 14 ? 2 : 1 })) }] }; exitCode = 1; instrument(); await hook(args());
  expect(decoded()[0]).toMatchObject({ decision: "block" }); expect(decoded()[0].reason).toContain("source.fixture:1: error 0"); expect(decoded()[0].reason).toContain("and 2 more");
});
test.each(["unverified", "nonzero", "empty", "invalid JSON", "spawn failure"])("hooks: %s cannot grant a verified completion", async (fault) => {
  result = fault === "empty" ? "" : fault === "invalid JSON" ? "{" : fault === "unverified" ? { success: false, verified: false } : { success: true };
  exitCode = fault === "nonzero" ? 23 : 0; stderr = "injected child failure"; spawnError = fault === "spawn failure"; instrument(); await hook(args());
  expect(decoded()[0]?.systemMessage).toContain("LSP diagnostics"); expect(decoded()[0]?.continue).toBeUndefined();
});
test("hooks: session-start failures stay quiet; invalid event names fail clearly", async () => {
  spawnError = true; instrument(); await hook(args("session-start")); expect(output).toEqual([]);
  await expect(hook(args("invalid"))).rejects.toThrow("session-start or hook stop");
});
test("CLI: hook invalid input surfaces structured errors", async () => {
  malformedInput = true; instrument(); expect(await main(["hook", "stop", "--json"])).toBe(2);
  expect(decoded()[0]).toEqual({ success: false, error: "Invalid JSON input" });
});
test("CLI: successful human and JSON command output", async () => {
  const w = workspace();
  expect(await main(["symbols", "--file", w.file, "--json"])).toBe(0); expect(JSON.parse(output.pop()!).success).toBe(true);
  expect(await main(["symbols", "--file", w.file])).toBe(0); expect(output.pop()).toBe("No symbols found");
});
