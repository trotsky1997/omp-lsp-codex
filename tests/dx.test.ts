import assert from "node:assert/strict";
import { after, afterEach, before, test, mock } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LspClient } from "../src/client.ts";
import { run } from "../src/commands.ts";
import { parseOptions } from "../src/cli.ts";
import { loadConfig, serverForLanguage } from "../src/config.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); });
after(() => restore());
afterEach(async () => {
  const leaked = LspClient.active.size;
  await Promise.all([...LspClient.active].map((client) => client.close()));
  cleanWorkspaces(); assert.strictEqual(leaked, 0);
});
const edits = (count = 80, offset = 0) => Array.from({ length: count }, (_, i) => ({ range: { start: { line: i + offset, character: 0 }, end: { line: i + offset, character: 5 } }, newText: "renamed" }));
const source = Array.from({ length: 80 }, () => "value = 1").join("\n") + "\n";

for (const [caseIndex, caseValue] of ([undefined, "3", "0"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (limit) => {
  const w = workspace(); w.setScenario({ responses: { "textDocument/references": Array.from({ length: 80 }, () => ({ uri: w.uri, range })) } });
  const result = await run(w.args("references", ...(limit === undefined ? [] : ["--limit", limit])));
  const shown = limit === undefined ? 50 : limit === "0" ? 80 : 3;
  assert.partialDeepStrictEqual(result.data, { success: true, total: 80, shown, truncated: shown < 80 });
  assert.strictEqual((result.data.locations as unknown[]).length, shown);
  if (shown < 80) assert.ok(String(result.data.hint).includes("--limit 0"));
};
  test("DX: references honor limit=%s and retain complete counts".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("DX: large rename previews omit the incomplete workspace edit", async () => {
  const w = workspace(); writeFileSync(w.file, source);
  w.setScenario({ responses: { "textDocument/rename": { changes: { [w.uri]: edits() } } } });
  const result = await run(w.args("rename", "--new-name", "renamed"));
  assert.partialDeepStrictEqual(result.data, { applied: false, total: 80, shown: 50, truncated: true, workspaceEditOmitted: true });
  assert.strictEqual(result.data.workspaceEdit, undefined); assert.ok(result.human.split("\n").length < 56);
  assert.strictEqual(readFileSync(w.file, "utf8"), source);
});
test("DX: unlimited rename previews retain every workspace edit", async () => {
  const w = workspace(); writeFileSync(w.file, source);
  w.setScenario({ responses: { "textDocument/rename": { changes: { [w.uri]: edits() } } } });
  const result = await run(w.args("rename", "--new-name", "renamed", "--limit", "0"));
  assert.partialDeepStrictEqual(result.data, { total: 80, shown: 80, truncated: false });
  assert.deepStrictEqual(result.data.workspaceEdit, { changes: { [w.uri]: edits() } });
});
test("DX: display limits never reduce applied edits", async () => {
  const w = workspace(); writeFileSync(w.file, source);
  w.setScenario({ responses: { "textDocument/rename": { changes: { [w.uri]: edits() } } } });
  assert.partialDeepStrictEqual((await run(w.args("rename", "--new-name", "renamed", "--limit", "1", "--apply"))).data, { applied: true, total: 80, shown: 1 });
  assert.strictEqual(readFileSync(w.file, "utf8"), source.replaceAll("value", "renamed"));
});
test("DX: errors in hidden rename edits still prevent every write", async () => {
  const w = workspace(); writeFileSync(w.file, source); const changes = edits(); changes[79].range.end.line = 999;
  w.setScenario({ responses: { "textDocument/rename": { changes: { [w.uri]: changes } } } });
  await assert.rejects(run(w.args("rename", "--new-name", "renamed", "--limit", "1", "--apply")), (error) => error instanceof Error && error.message.includes(String("range")));
  assert.strictEqual(readFileSync(w.file, "utf8"), source);
});
test("DX: rename-file shares one display budget across servers", async () => {
  const w = workspace(); writeFileSync(w.file, source);
  w.setScenario({ responses: { "workspace/willRenameFiles": { changes: { [w.uri]: edits(40) } } } });
  const other = join(w.root, "secondary.json"); writeFileSync(other, JSON.stringify({ responses: { "workspace/willRenameFiles": { changes: { [w.uri]: edits(40, 40) } } } }));
  w.configs.secondary = { ...w.configs.fixture, args: [...w.configs.fixture.args!.slice(0, -1), other] }; w.saveConfig();
  const result = await run(w.args("rename-file", "--new-name", "renamed.fixture"));
  assert.partialDeepStrictEqual(result.data, { total: 80, shown: 50, truncated: true, workspaceEditOmitted: true });
  assert.strictEqual(result.data.workspaceEdits, undefined); assert.ok(result.human.split("\n").length < 57);
  await run(w.args("rename-file", "--new-name", "renamed.fixture", "--limit", "1", "--apply"));
  assert.strictEqual(readFileSync(join(w.root, "renamed.fixture"), "utf8"), source.replaceAll("value", "renamed"));
});
test("DX: hidden diagnostics keep complete severity totals and the failure exit code", async () => {
  const diagnostics = Array.from({ length: 80 }, (_, i) => ({ range, message: `issue ${i}`, severity: i === 79 ? 1 : 2 }));
  const w = workspace({ diagnostics });
  for (const flags of [[], ["--limit", "1"], ["--limit", "0"]]) {
    const result = await run(w.args("diagnostics", ...flags)), shown = flags[1] === "0" ? 80 : flags[1] === "1" ? 1 : 50;
    assert.strictEqual(result.code, 1); assert.partialDeepStrictEqual(result.data, { success: false, verified: true, hasErrors: true, total: 80, shown, counts: { errors: 1, warnings: 79, information: 0, hints: 0 } });
    assert.strictEqual((result.data.checked as { diagnostics: unknown[]; diagnosticCount: number }[])[0].diagnostics.length, shown);
    assert.strictEqual((result.data.checked as { diagnosticCount: number }[])[0].diagnosticCount, 80);
    const visible = (result.data.checked as { diagnostics: typeof diagnostics }[])[0].diagnostics;
    if (flags[1] === "0") assert.deepStrictEqual(visible, diagnostics);
    else assert.strictEqual(visible[0].severity, 1);
  }
});
test("DX: code-action display preserves original indexes and selection beyond the limit", async () => {
  const w = workspace({ responses: { "textDocument/codeAction": Array.from({ length: 80 }, (_, i) => ({ title: `Fix ${i}`, command: `fixture.fix${i}` })) } });
  const result = await run(w.args("code-actions", "--query", "Fix"));
  assert.partialDeepStrictEqual(result.data, { total: 80, shown: 50, truncated: true });
  assert.strictEqual((result.data.actions as { index: number }[]).at(-1)?.index, 49);
  assert.strictEqual((await run(w.args("code-actions", "--query", "70", "--limit", "1", "--apply"))).data.applied, true);
  assert.strictEqual(w.events().some((e) => e.method === "workspace/executeCommand" && (e.params as { command: string }).command === "fixture.fix70"), true);
});
test("DX: symbols bound both document and workspace results without a silent hard cap", async () => {
  const w = workspace(); const values = Array.from({ length: 201 }, (_, i) => ({ name: `Value${i}`, range, location: { uri: w.uri, range } }));
  w.setScenario({ capabilities: { workspaceSymbolProvider: true }, responses: { "textDocument/documentSymbol": values, "workspace/symbol": values } });
  for (const flags of [[], ["--workspace"]]) {
    const result = await run(w.args("symbols", "--query", "Value", ...flags));
    assert.partialDeepStrictEqual(result.data, { total: 201, shown: 50, truncated: true }); assert.strictEqual((result.data.symbols as unknown[]).length, 50);
    assert.strictEqual(((await run(w.args("symbols", "--query", "Value", "--limit", "0", ...flags))).data.symbols as unknown[]).length, 201);
  }
});
test("DX: empty document-symbol searches suggest a scoped workspace query", async () => {
  const w = workspace(), result = await run(w.args("symbols", "--query", "Runtime"));
  assert.ok(String(result.data.hint).includes("--workspace")); assert.ok((result.human).includes("--file"));
  assert.strictEqual(w.events().some((e) => e.method === "workspace/symbol"), false);
});
for (const [caseIndex, caseValue] of ([undefined, "0"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (limit) => {
  const hover = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"), w = workspace({ responses: { "textDocument/hover": { contents: hover } } });
  const result = await run(w.args("hover", ...(limit === undefined ? [] : ["--limit", limit])));
  assert.partialDeepStrictEqual(result.data, { found: true, total: 100, shown: limit === "0" ? 100 : 50, truncated: limit !== "0" });
  assert.strictEqual(String(result.data.hover).split("\n").length, limit === "0" ? 100 : 50);
};
  test("DX: hover docs honor line limit=%s".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("DX: clipping blank hover lines cannot change found to false", async () => {
  const w = workspace({ responses: { "textDocument/hover": { contents: "\n\nvalue: number" } } });
  const result = await run(w.args("hover", "--limit", "1"));
  assert.partialDeepStrictEqual(result.data, { found: true, total: 3, shown: 1, truncated: true });
  assert.ok(!(result.human).includes("No hover information"));
});
for (const [caseIndex, caseValue] of (["-1", "1.5", "NaN", "Infinity", "9007199254740993"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = (value) => {
  assert.throws(() => parseOptions(["status", `--limit=${value}`]), (error) => error instanceof Error && error.message.includes(String("--limit")));
};
  test("DX: invalid limit=%s fails before startup".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("DX: invalid positions fail before starting a language server", async () => {
  const w = workspace(), start = mock.method(LspClient, "start");
  try {
    await assert.rejects(run(w.args("definition", "--line", "99")), (error) => error instanceof Error && error.message.includes(String("outside this file")));
    await assert.rejects(run(w.args("definition", "--symbol", "missing")), (error) => error instanceof Error && error.message.includes(String("not found on line")));
    assert.strictEqual(start.mock.callCount(), 0);
  } finally { start.mock.restore(); }
});
test("DX: wrong symbol lines suggest nearby token matches", async () => {
  const w = workspace(); writeFileSync(w.file, "values = 0\nvalue = 1\nvalue = 2\n");
  await assert.rejects(run(w.args("definition", "--symbol", "value")), (error) => error instanceof Error && error.message.includes(String("matching lines: 2, 3")));
});
for (const [caseIndex, caseValue] of (["constructor", "__proto__", "toString"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async (command) => {
  const w = workspace(), start = mock.method(LspClient, "start");
  try { await assert.rejects(run(w.args(command)), (error) => error instanceof Error && error.message.includes(String("Unknown command"))); assert.strictEqual(start.mock.callCount(), 0); }
  finally { start.mock.restore(); }
};
  test("DX: unknown command %s cannot enter navigation".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("DX: status --file selects the target project from another directory", async () => {
  const w = workspace(); w.configs.other = { ...w.configs.fixture, fileTypes: [".other"] }; w.saveConfig();
  const result = await run({ ...w.args("status"), cwd: tmpdir() });
  assert.partialDeepStrictEqual(result.data.servers, [{ name: "fixture", root: w.root }]); assert.strictEqual((result.data.servers as unknown[]).length, 1);
});
test("DX: invalid UTF-8 is rejected before starting navigation", async () => {
  const w = workspace(); writeFileSync(w.file, Buffer.from([0xff])); const start = mock.method(LspClient, "start");
  try { await assert.rejects(run(w.args("definition"))); assert.strictEqual(start.mock.callCount(), 0); }
  finally { start.mock.restore(); }
});
for (const [caseIndex, caseValue] of (["constructor", "__proto__"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = (language) => {
  assert.throws(() => serverForLanguage(language, {}), (error) => error instanceof Error && error.message.includes(String("No bundled language server")));
};
  test("DX: unknown language %s fails with setup guidance".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("DX: server IDs cannot change the configuration dictionary prototype", () => {
  const w = workspace();
  writeFileSync(w.configPath, JSON.stringify({ servers: JSON.parse('{"__proto__":{"command":"fixture-bin","fileTypes":[".fixture"]}}') }));
  const configs = loadConfig(w.root);
  assert.strictEqual(Object.hasOwn(configs, "__proto__"), true);
  assert.strictEqual(configs["__proto__"].command, "fixture-bin");
  assert.strictEqual(serverForLanguage("__proto__", configs), "__proto__");
});
