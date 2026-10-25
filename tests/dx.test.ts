import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LspClient } from "../src/client.ts";
import { run } from "../src/commands.ts";
import { parseOptions } from "../src/cli.ts";
import { loadConfig, serverForLanguage } from "../src/config.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
beforeAll(() => { restore = isolateGlobalConfig(); });
afterAll(() => restore());
afterEach(async () => {
  const leaked = LspClient.active.size;
  await Promise.all([...LspClient.active].map((client) => client.close()));
  cleanWorkspaces(); expect(leaked).toBe(0);
});
const edits = (count = 80, offset = 0) => Array.from({ length: count }, (_, i) => ({ range: { start: { line: i + offset, character: 0 }, end: { line: i + offset, character: 5 } }, newText: "renamed" }));
const source = Array.from({ length: 80 }, () => "value = 1").join("\n") + "\n";

test.each([undefined, "3", "0"])("DX: references honor limit=%s and retain complete counts", async (limit) => {
  const w = workspace(); w.setScenario({ responses: { "textDocument/references": Array.from({ length: 80 }, () => ({ uri: w.uri, range })) } });
  const result = await run(w.args("references", ...(limit === undefined ? [] : ["--limit", limit])));
  const shown = limit === undefined ? 50 : limit === "0" ? 80 : 3;
  expect(result.data).toMatchObject({ success: true, total: 80, shown, truncated: shown < 80 });
  expect((result.data.locations as unknown[]).length).toBe(shown);
  if (shown < 80) expect(result.data.hint).toContain("--limit 0");
});
test("DX: large rename previews omit the incomplete workspace edit", async () => {
  const w = workspace(); writeFileSync(w.file, source);
  w.setScenario({ responses: { "textDocument/rename": { changes: { [w.uri]: edits() } } } });
  const result = await run(w.args("rename", "--new-name", "renamed"));
  expect(result.data).toMatchObject({ applied: false, total: 80, shown: 50, truncated: true, workspaceEditOmitted: true });
  expect(result.data.workspaceEdit).toBeUndefined(); expect(result.human.split("\n").length).toBeLessThan(56);
  expect(readFileSync(w.file, "utf8")).toBe(source);
});
test("DX: unlimited rename previews retain every workspace edit", async () => {
  const w = workspace(); writeFileSync(w.file, source);
  w.setScenario({ responses: { "textDocument/rename": { changes: { [w.uri]: edits() } } } });
  const result = await run(w.args("rename", "--new-name", "renamed", "--limit", "0"));
  expect(result.data).toMatchObject({ total: 80, shown: 80, truncated: false });
  expect(result.data.workspaceEdit).toEqual({ changes: { [w.uri]: edits() } });
});
test("DX: display limits never reduce applied edits", async () => {
  const w = workspace(); writeFileSync(w.file, source);
  w.setScenario({ responses: { "textDocument/rename": { changes: { [w.uri]: edits() } } } });
  expect((await run(w.args("rename", "--new-name", "renamed", "--limit", "1", "--apply"))).data).toMatchObject({ applied: true, total: 80, shown: 1 });
  expect(readFileSync(w.file, "utf8")).toBe(source.replaceAll("value", "renamed"));
});
test("DX: errors in hidden rename edits still prevent every write", async () => {
  const w = workspace(); writeFileSync(w.file, source); const changes = edits(); changes[79].range.end.line = 999;
  w.setScenario({ responses: { "textDocument/rename": { changes: { [w.uri]: changes } } } });
  await expect(run(w.args("rename", "--new-name", "renamed", "--limit", "1", "--apply"))).rejects.toThrow("range");
  expect(readFileSync(w.file, "utf8")).toBe(source);
});
test("DX: rename-file shares one display budget across servers", async () => {
  const w = workspace(); writeFileSync(w.file, source);
  w.setScenario({ responses: { "workspace/willRenameFiles": { changes: { [w.uri]: edits(40) } } } });
  const other = join(w.root, "secondary.json"); writeFileSync(other, JSON.stringify({ responses: { "workspace/willRenameFiles": { changes: { [w.uri]: edits(40, 40) } } } }));
  w.configs.secondary = { ...w.configs.fixture, args: [...w.configs.fixture.args!.slice(0, -1), other] }; w.saveConfig();
  const result = await run(w.args("rename-file", "--new-name", "renamed.fixture"));
  expect(result.data).toMatchObject({ total: 80, shown: 50, truncated: true, workspaceEditOmitted: true });
  expect(result.data.workspaceEdits).toBeUndefined(); expect(result.human.split("\n").length).toBeLessThan(57);
  await run(w.args("rename-file", "--new-name", "renamed.fixture", "--limit", "1", "--apply"));
  expect(readFileSync(join(w.root, "renamed.fixture"), "utf8")).toBe(source.replaceAll("value", "renamed"));
});
test("DX: hidden diagnostics keep complete severity totals and the failure exit code", async () => {
  const diagnostics = Array.from({ length: 80 }, (_, i) => ({ range, message: `issue ${i}`, severity: i === 79 ? 1 : 2 }));
  const w = workspace({ diagnostics });
  for (const flags of [[], ["--limit", "1"], ["--limit", "0"]]) {
    const result = await run(w.args("diagnostics", ...flags)), shown = flags[1] === "0" ? 80 : flags[1] === "1" ? 1 : 50;
    expect(result.code).toBe(1); expect(result.data).toMatchObject({ success: false, verified: true, hasErrors: true, total: 80, shown, counts: { errors: 1, warnings: 79, information: 0, hints: 0 } });
    expect((result.data.checked as { diagnostics: unknown[]; diagnosticCount: number }[])[0].diagnostics.length).toBe(shown);
    expect((result.data.checked as { diagnosticCount: number }[])[0].diagnosticCount).toBe(80);
  }
});
test("DX: code-action display preserves original indexes and selection beyond the limit", async () => {
  const w = workspace({ responses: { "textDocument/codeAction": Array.from({ length: 80 }, (_, i) => ({ title: `Fix ${i}`, command: `fixture.fix${i}` })) } });
  const result = await run(w.args("code-actions", "--query", "Fix"));
  expect(result.data).toMatchObject({ total: 80, shown: 50, truncated: true });
  expect((result.data.actions as { index: number }[]).at(-1)?.index).toBe(49);
  expect((await run(w.args("code-actions", "--query", "70", "--limit", "1", "--apply"))).data.applied).toBe(true);
  expect(w.events().some((e) => e.method === "workspace/executeCommand" && (e.params as { command: string }).command === "fixture.fix70")).toBe(true);
});
test("DX: symbols bound both document and workspace results without a silent hard cap", async () => {
  const w = workspace(); const values = Array.from({ length: 201 }, (_, i) => ({ name: `Value${i}`, range, location: { uri: w.uri, range } }));
  w.setScenario({ capabilities: { workspaceSymbolProvider: true }, responses: { "textDocument/documentSymbol": values, "workspace/symbol": values } });
  for (const flags of [[], ["--workspace"]]) {
    const result = await run(w.args("symbols", "--query", "Value", ...flags));
    expect(result.data).toMatchObject({ total: 201, shown: 50, truncated: true }); expect((result.data.symbols as unknown[]).length).toBe(50);
    expect(((await run(w.args("symbols", "--query", "Value", "--limit", "0", ...flags))).data.symbols as unknown[]).length).toBe(201);
  }
});
test("DX: empty document-symbol searches suggest a scoped workspace query", async () => {
  const w = workspace(), result = await run(w.args("symbols", "--query", "Runtime"));
  expect(result.data.hint).toContain("--workspace"); expect(result.human).toContain("--file");
  expect(w.events().some((e) => e.method === "workspace/symbol")).toBe(false);
});
test.each([undefined, "0"])("DX: hover docs honor line limit=%s", async (limit) => {
  const hover = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"), w = workspace({ responses: { "textDocument/hover": { contents: hover } } });
  const result = await run(w.args("hover", ...(limit === undefined ? [] : ["--limit", limit])));
  expect(result.data).toMatchObject({ found: true, total: 100, shown: limit === "0" ? 100 : 50, truncated: limit !== "0" });
  expect(String(result.data.hover).split("\n").length).toBe(limit === "0" ? 100 : 50);
});
test("DX: clipping blank hover lines cannot change found to false", async () => {
  const w = workspace({ responses: { "textDocument/hover": { contents: "\n\nvalue: number" } } });
  const result = await run(w.args("hover", "--limit", "1"));
  expect(result.data).toMatchObject({ found: true, total: 3, shown: 1, truncated: true });
  expect(result.human).not.toContain("No hover information");
});
test.each(["-1", "1.5", "NaN", "Infinity", "9007199254740993"])("DX: invalid limit=%s fails before startup", (value) => {
  expect(() => parseOptions(["status", `--limit=${value}`])).toThrow("--limit");
});
test("DX: invalid positions fail before starting a language server", async () => {
  const w = workspace(), start = spyOn(LspClient, "start");
  try {
    await expect(run(w.args("definition", "--line", "99"))).rejects.toThrow("outside this file");
    await expect(run(w.args("definition", "--symbol", "missing"))).rejects.toThrow("not found on line");
    expect(start).not.toHaveBeenCalled();
  } finally { start.mockRestore(); }
});
test("DX: wrong symbol lines suggest nearby token matches", async () => {
  const w = workspace(); writeFileSync(w.file, "values = 0\nvalue = 1\nvalue = 2\n");
  await expect(run(w.args("definition", "--symbol", "value"))).rejects.toThrow("matching lines: 2, 3");
});
test.each(["constructor", "__proto__", "toString"])("DX: unknown command %s cannot enter navigation", async (command) => {
  const w = workspace(), start = spyOn(LspClient, "start");
  try { await expect(run(w.args(command))).rejects.toThrow("Unknown command"); expect(start).not.toHaveBeenCalled(); }
  finally { start.mockRestore(); }
});
test("DX: status --file selects the target project from another directory", async () => {
  const w = workspace(); w.configs.other = { ...w.configs.fixture, fileTypes: [".other"] }; w.saveConfig();
  const result = await run({ ...w.args("status"), cwd: tmpdir() });
  expect(result.data.servers).toMatchObject([{ name: "fixture", root: w.root }]); expect((result.data.servers as unknown[]).length).toBe(1);
});
test("DX: invalid UTF-8 is rejected before starting navigation", async () => {
  const w = workspace(); writeFileSync(w.file, Buffer.from([0xff])); const start = spyOn(LspClient, "start");
  try { await expect(run(w.args("definition"))).rejects.toThrow(); expect(start).not.toHaveBeenCalled(); }
  finally { start.mockRestore(); }
});
test.each(["constructor", "__proto__"])("DX: unknown language %s fails with setup guidance", (language) => {
  expect(() => serverForLanguage(language, {})).toThrow("No bundled language server");
});
test("DX: server IDs cannot change the configuration dictionary prototype", () => {
  const w = workspace();
  writeFileSync(w.configPath, JSON.stringify({ servers: JSON.parse('{"__proto__":{"command":"fixture-bin","fileTypes":[".fixture"]}}') }));
  const configs = loadConfig(w.root);
  expect(Object.hasOwn(configs, "__proto__")).toBe(true);
  expect(configs["__proto__"].command).toBe("fixture-bin");
  expect(serverForLanguage("__proto__", configs)).toBe("__proto__");
});
