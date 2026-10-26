import assert from "node:assert/strict";
import { after, afterEach, before, test, mock } from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { LspClient } from "../src/client.ts";
import { main, parseOptions } from "../src/cli.ts";
import { run } from "../src/commands.ts";
import { fileUri, object } from "../src/config.ts";
import { selectFields } from "../src/output.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); });
after(() => restore());
afterEach(async () => {
  const leaked = LspClient.active.size;
  await Promise.all([...LspClient.active].map(client => client.close()));
  cleanWorkspaces(); assert.strictEqual(leaked, 0);
});
const signatureMethod = "textDocument/signatureHelp";
test("output: repeated reference paths are grouped while JSON locations stay complete", async () => {
  const w = workspace(), locations = Array.from({ length: 50 }, (_, line) => ({ uri: w.uri, range: { start: { line, character: 0 }, end: { line, character: 1 } } }));
  writeFileSync(w.file, "value = 1\n".repeat(60)); w.setScenario({ responses: { "textDocument/references": locations } });
  const result = await run(w.args("references"));
  assert.partialDeepStrictEqual(result.data, { success: true, found: true, total: 50, shown: 50, truncated: false });
  assert.deepStrictEqual((result.data.locations as { file: string; line: number }[]).map(row => [row.file, row.line]), locations.map((_, line) => [w.file, line + 1]));
  assert.ok((result.human).includes(`Root: ${w.root}`)); assert.strictEqual((result.human.split("source.fixture")).length, 2);
  assert.ok((result.human).includes("50:1")); assert.ok(result.human.length < locations.length * w.file.length / 2);
});
test("output: grouped locations preserve Unicode paths and external absolute targets", async () => {
  const w = workspace(), outside = workspace(), file = join(w.root, "src/中文 file.fixture");
  mkdirSync(join(w.root, "src")); writeFileSync(file, "value = 1\n");
  w.setScenario({ responses: { "textDocument/definition": [{ uri: fileUri(file), range }, { uri: outside.uri, range }, { uri: fileUri(w.root), range }] } });
  const result = await run(w.args("definition"));
  assert.ok((result.human).includes("中文 file.fixture:1:1")); assert.ok((result.human).includes(outside.file));
  assert.ok((result.human).includes(".:1:1"));
  assert.deepStrictEqual((result.data.locations as { file: string }[]).map(row => row.file), [file, outside.file, w.root]);
});
test("output: file symbols group names without dropping coordinates or kinds", async () => {
  const w = workspace({ responses: { "textDocument/documentSymbol": [{ name: "Alpha", kind: 12, range }, { name: "Beta", kind: 13, range }] } });
  const result = await run(w.args("symbols"));
  assert.strictEqual((result.human.split("source.fixture")).length, 2); assert.ok((result.human).includes("Alpha@1:1")); assert.ok((result.human).includes("Beta@1:1"));
  assert.deepStrictEqual((result.data.symbols as { kind: number }[]).map(row => row.kind), [12, 13]);
});
test("output: hover bounds a huge single-line RPC response without splitting Unicode", async () => {
  const w = workspace(), content = "x".repeat(5999) + "😀" + "y".repeat(100000);
  w.setScenario({ responses: { "textDocument/hover": { contents: content } } });
  const result = await run(w.args("hover"));
  assert.partialDeepStrictEqual(result.data, { success: true, found: true, total: 1, shown: 1, truncated: true, characters: { total: content.length, shown: 5999 } });
  assert.strictEqual(result.data.hover, content.slice(0, 5999)); assert.strictEqual(Buffer.from(String(result.data.hover)).toString("utf8"), String(result.data.hover));
  assert.ok(JSON.stringify(result.data).length < 6500); assert.ok((result.human).includes("--limit 0"));
  assert.strictEqual((await run(w.args("hover", "--limit", "0"))).data.hover, content);
});
test("output: inspect retains verified code errors alongside a bounded hover", async () => {
  const w = workspace({ diagnostics: [{ range, message: "existing code error", severity: 1 }], responses: { "textDocument/hover": { contents: "x".repeat(200000) } } });
  const result = await run(w.args("inspect"));
  assert.strictEqual(result.code, 1); assert.partialDeepStrictEqual(result.data, { success: false, failedSections: ["diagnostics"] });
  assert.strictEqual(object(object(result.data.results).hover).truncated, true); assert.ok((result.human).includes("existing code error"));
  assert.ok(result.human.length < 7500); assert.strictEqual((result.human.split("Root:")).length, 2);
});
test("output: diagnostics bound provider text and opaque metadata without changing verification", async () => {
  const diagnostics = [
    { range, severity: 1, message: "x".repeat(2999) + "😀" + "x".repeat(100000), source: "fixture", data: "opaque".repeat(50000), relatedInformation: [{ location: { uri: "file:///related.fixture", range }, message: "related".repeat(30000) }] },
    { range, severity: 2, message: "a separate warning" },
  ];
  const w = workspace({ diagnostics }), result = await run(w.args("diagnostics"));
  assert.strictEqual(result.code, 1);
  assert.partialDeepStrictEqual(result.data, { success: false, verified: true, hasErrors: true, total: 2, shown: 2, truncated: true, textTruncated: true, detailsOmitted: true, counts: { errors: 1, warnings: 1 } });
  const shown = (result.data.checked as { diagnostics: typeof diagnostics }[])[0].diagnostics;
  assert.strictEqual(shown[0].message, "x".repeat(2999)); assert.strictEqual(shown[1].message, diagnostics[1].message);
  assert.strictEqual(Buffer.from(shown[0].message).toString("utf8"), shown[0].message);
  assert.ok(JSON.stringify(result.data).length < 8000); assert.ok(result.human.length < 7000); assert.ok(String(result.data.hint).includes("--limit 0"));
  assert.deepStrictEqual((await run(w.args("diagnostics", "--limit", "0"))).data.checked, [{ file: w.file, diagnostics, verified: true, errors: [], diagnosticCount: 2 }]);
});
test("output: compact diagnostics retain small related locations", async () => {
  const w = workspace(), diagnostic = { range, message: "type mismatch", relatedInformation: Array.from({ length: 4 }, (_, index) => ({ location: { uri: w.uri, range }, message: `declared here ${index}` })) };
  w.setScenario({ diagnostics: [diagnostic] });
  const result = await run(w.args("diagnostics"));
  assert.deepStrictEqual((result.data.checked as { diagnostics: unknown[] }[])[0].diagnostics, [diagnostic]); assert.strictEqual(result.data.detailsOmitted, undefined);
});
test("doctor: huge server health errors are bounded with complete details available explicitly", async () => {
  const w = workspace(), message = "Cargo metadata failed: " + "x".repeat(100000), start = LspClient.start.bind(LspClient);
  w.configs["rust-analyzer"] = { ...w.configs.fixture, disabled: false }; w.configs.fixture = { ...w.configs.fixture, disabled: true }; w.saveConfig();
  const inject = mock.method(LspClient, "start", async (...args: Parameters<typeof LspClient.start>) => {
    const client = await start(...args);
    await client.request("fixture/notification", { method: "experimental/serverStatus", params: { quiescent: true, health: "error", message } });
    return client;
  });
  try {
    const result = await run(w.args("doctor"));
    assert.strictEqual(result.code, 1); assert.strictEqual(result.data.success, false); assert.ok(JSON.stringify(result.data).length < 13500); assert.ok(result.human.length < 6700);
    assert.strictEqual(object((result.data.servers as unknown[])[0]).errorTruncated, true); assert.ok(result.human.includes("--limit 0"));
    const full = await run(w.args("doctor", "--limit", "0")); assert.ok(String(object((full.data.servers as unknown[])[0]).error).includes(message));
  } finally { inject.mock.restore(); }
});
test("output: compact diagnostics tolerate malformed optional provider metadata", async () => {
  const w = workspace({ diagnostics: [{ range: { ...range, providerData: "x".repeat(200000) }, message: "type mismatch", source: { invalid: true }, code: [], data: "x".repeat(200000) }] });
  const result = await run(w.args("diagnostics"));
  assert.strictEqual(result.code, 1); assert.strictEqual(result.data.verified, true); assert.strictEqual(result.data.detailsOmitted, true);
  const diagnostic = (result.data.checked as { diagnostics: { source?: unknown; code?: unknown; message: string }[] }[])[0].diagnostics[0];
  assert.strictEqual(diagnostic.source, undefined); assert.strictEqual(diagnostic.code, undefined); assert.strictEqual(diagnostic.message, "type mismatch");
  assert.ok(JSON.stringify(result.data).length < 2000);
});
test("output: changed-file diagnostic limits prioritize a later file's error over earlier warnings", async () => {
  const w = workspace({ diagnostics: [{ range, severity: 2, message: "first warning" }, { range, severity: 2, message: "second warning" }] }), other = join(w.root, "z.other"), scenario = join(w.root, "errors.json");
  rmSync(join(w.root, ".git"), { recursive: true }); assert.strictEqual(spawnSync("git", ["-C", w.root, "init", "-q"]).status, 0);
  writeFileSync(join(w.root, ".gitignore"), "*\n!*.fixture\n!*.other\n"); writeFileSync(other, "value = 1\n");
  writeFileSync(scenario, JSON.stringify({ diagnostics: [{ range, severity: 1, message: "late error" }] }));
  w.configs.secondary = { ...w.configs.fixture, fileTypes: [".other"], args: [...w.configs.fixture.args!.slice(0, -1), scenario] }; w.saveConfig();
  const result = await run({ ...w.args("diagnostics", "--limit", "1"), file: undefined, changed: true });
  assert.strictEqual(result.code, 1); assert.partialDeepStrictEqual(result.data, { verified: true, hasErrors: true, total: 3, shown: 1, counts: { errors: 1, warnings: 2 } });
  const checked = result.data.checked as { file: string; diagnostics: { message: string }[] }[];
  assert.deepStrictEqual(checked.find(row => row.file === w.file)?.diagnostics, []); assert.strictEqual(checked.find(row => row.file === other)?.diagnostics[0].message, "late error");
});
test("output: RPC failures stay bounded in CLI and inspect with an explicit full-output escape", async () => {
  const message = "server failure: " + "x".repeat(100000), w = workspace({ errors: { "textDocument/hover": { code: -32603, message } } });
  const output: string[] = [], log = mock.method(console, "log", (value: unknown) => output.push(String(value))), error = mock.method(console, "error", (value: unknown) => output.push(String(value)));
  try {
    for (const flags of [[], ["--json"], ["--json", "--limit=0"]]) {
      assert.strictEqual(await main(["hover", "--file", w.file, ...flags]), 2);
      const text = output.pop()!;
      if (flags.includes("--limit=0")) assert.ok(JSON.parse(text).error.includes(message));
      else { assert.ok(text.length < 6500); assert.ok(text.includes("--limit 0")); if (flags.length) assert.strictEqual(JSON.parse(text).errorTruncated, true); }
    }
  } finally { log.mock.restore(); error.mock.restore(); }
  const result = await run(w.args("inspect"));
  assert.strictEqual(result.code, 1); assert.partialDeepStrictEqual(object(object(result.data.results).hover), { success: false, errorTruncated: true }); assert.ok(result.human.length < 8000);
  w.setScenario({ capabilities: { workspaceSymbolProvider: true }, errors: { "workspace/symbol": { code: -32603, message } } });
  const symbols = await run(w.args("symbols", "--workspace", "--query", "value"));
  assert.strictEqual(symbols.code, 1); assert.ok(symbols.human.length < 6500); assert.partialDeepStrictEqual((symbols.data.errors as unknown[])[0], { success: false, errorTruncated: true });
});
test("code-actions: previews expose disabled reasons without executing commands", async () => {
  const w = workspace({ responses: { "textDocument/codeAction": [{ title: "Fix unavailable import", disabled: { reason: "dependency is unavailable" }, command: "fixture.must-not-run" }] } });
  const result = await run(w.args("code-actions"));
  assert.partialDeepStrictEqual(result.data, { success: true, actions: [{ index: 0, title: "Fix unavailable import", disabledReason: "dependency is unavailable" }] });
  assert.ok(result.human.includes("disabled: dependency is unavailable"));
  await assert.rejects(run(w.args("code-actions", "--query", "0", "--apply")), /dependency is unavailable/);
  assert.strictEqual(w.events().some(event => event.method === "workspace/executeCommand"), false);
});
test("code-actions: selecting an index previews edit scope and full data without applying", async () => {
  const w = workspace(), edit = { changes: { [w.uri]: [{ range, newText: "renamed" }] } };
  w.setScenario({ responses: { "textDocument/codeAction": [{ title: "Fix import", edit }] } });
  const list = await run(w.args("code-actions")); assert.ok(String(list.data.hint).includes("--query"));
  const result = await run(w.args("code-actions", "--query", "0"));
  assert.partialDeepStrictEqual(result.data, { success: true, applied: false, executesCommand: false, actions: [{ index: 0 }], editPreview: { fileCount: 1, files: [w.file], total: 1, shown: 1, workspaceEditOmitted: true } });
  assert.ok(result.human.includes(w.file)); assert.ok(result.human.includes("renamed")); assert.strictEqual(readFileSync(w.file, "utf8"), "value = 1\n");
  const full = await run(w.args("code-actions", "--query", "0", "--limit", "0")); assert.deepStrictEqual(object(full.data.editPreview).workspaceEdit, edit);
  const newText = "x".repeat(100000);
  w.setScenario({ responses: { "textDocument/codeAction": [{ title: "Fix import", edit: { changes: { [w.uri]: [{ range, newText }] } } }] } });
  const bounded = await run(w.args("code-actions", "--query", "0")); assert.partialDeepStrictEqual(object(bounded.data.editPreview), { textTruncated: true, truncated: true, workspaceEditOmitted: true }); assert.ok(JSON.stringify(bounded.data).length < 7500);
  await run(w.args("code-actions", "--query", "0", "--apply")); assert.strictEqual(readFileSync(w.file, "utf8"), newText + " = 1\n");
});
test("code-actions: resolved preview identifies server commands and never executes them", async () => {
  const w = workspace({ capabilities: { codeActionProvider: { resolveProvider: true } }, responses: { "textDocument/codeAction": [{ title: "Fix" }], "codeAction/resolve": { title: "Fix", command: { title: "Fix", command: "fixture.must-not-run" } } } });
  const result = await run(w.args("code-actions", "--query", "0"));
  assert.partialDeepStrictEqual(result.data, { success: true, applied: false, executesCommand: true }); assert.ok(String(result.data.hint).includes("server command"));
  assert.strictEqual(w.events().filter(event => event.method === "codeAction/resolve").length, 1); assert.strictEqual(w.events().some(event => event.method === "workspace/executeCommand"), false); assert.strictEqual(readFileSync(w.file, "utf8"), "value = 1\n");
  assert.partialDeepStrictEqual(selectFields(result.data, ["total"]), { applied: false, executesCommand: true, hint: result.data.hint });
  w.setScenario({ capabilities: { codeActionProvider: { resolveProvider: true } }, responses: { "textDocument/codeAction": [{ title: "Fix" }], "codeAction/resolve": { title: "Fix", disabled: { reason: "dependency unavailable" } } } });
  const disabled = await run(w.args("code-actions", "--query", "0")); assert.partialDeepStrictEqual(disabled.data, { actions: [{ index: 0, disabledReason: "dependency unavailable" }] }); assert.ok(String(disabled.data.hint).includes("dependency unavailable"));
});
test("code-actions: ambiguous title selection cannot execute the first matching action", async () => {
  const w = workspace({ responses: { "textDocument/codeAction": [{ title: "Fix first", command: "first" }, { title: "Fix second", command: "second" }] } });
  await assert.rejects(run(w.args("code-actions", "--query", "Fix", "--apply")), /original index/);
  assert.strictEqual(w.events().some(event => event.method === "workspace/executeCommand"), false);
});
test("code-actions: malformed resolved actions fail before writing", async () => {
  const w = workspace({ capabilities: { codeActionProvider: { resolveProvider: true } }, responses: { "textDocument/codeAction": [{ title: "Resolve fix" }], "codeAction/resolve": null } });
  await assert.rejects(run(w.args("code-actions", "--query", "0", "--apply")), /Invalid resolved code action from fixture/);
  assert.strictEqual(readFileSync(w.file, "utf8"), "value = 1\n");
  assert.strictEqual(w.events().some(event => event.method === "workspace/executeCommand"), false);
});
test("code-actions: huge titles stay bounded while index selection applies the complete edit", async () => {
  const w = workspace(), title = "x".repeat(5999) + "😀" + "y".repeat(100000);
  const action = { title, kind: "quickfix", edit: { changes: { [w.uri]: [{ range, newText: "renamed" }] } } };
  w.setScenario({ responses: { "textDocument/codeAction": [action] } });
  const result = await run(w.args("code-actions"));
  assert.partialDeepStrictEqual(result.data, { success: true, total: 1, shown: 1, truncated: true, textTruncated: true });
  assert.ok(result.human.length < 6500); assert.ok(JSON.stringify(result.data).length < 6800); assert.ok(String(result.data.hint).includes("--limit 0"));
  const full = await run(w.args("code-actions", "--limit", "0")); assert.strictEqual(object((full.data.actions as unknown[])[0]).title, title);
  const applied = await run(w.args("code-actions", "--query", "0", "--apply"));
  assert.partialDeepStrictEqual(applied.data, { applied: true, verification: "pending", textTruncated: true }); assert.ok(applied.human.length < 6500);
  assert.strictEqual(readFileSync(w.file, "utf8"), "renamed = 1\n");
});
test("symbols: huge names and containers have bounded previews with complete full output", async () => {
  const w = workspace(), name = "name".repeat(50000), containerName = "container".repeat(30000);
  w.setScenario({ capabilities: { workspaceSymbolProvider: true }, responses: {
    "textDocument/documentSymbol": [{ name, kind: 12, range, containerName }],
    "workspace/symbol": [{ name, kind: 12, location: { uri: w.uri, range }, containerName }],
  } });
  for (const flags of [[], ["--workspace", "--query", "name"]]) {
    const result = await run(w.args("symbols", ...flags));
    assert.partialDeepStrictEqual(result.data, { success: true, shown: 1, truncated: true, textTruncated: true });
    assert.ok(JSON.stringify(result.data).length < 6800); assert.ok(result.human.length < 6500);
    const full = await run(w.args("symbols", ...flags, "--limit", "0")), row = object((full.data.symbols as unknown[])[0]);
    assert.strictEqual(row.name, name); assert.strictEqual(row.container, containerName);
  }
});
test("rename previews: huge replacement text is bounded without clipping ranges or applied edits", async () => {
  for (const command of ["rename", "rename-file"]) {
    const w = workspace(), newText = "x".repeat(5999) + "😀" + "y".repeat(100000), edit = { changes: { [w.uri]: [{ range, newText }] } };
    w.setScenario({ responses: { [command === "rename" ? "textDocument/rename" : "workspace/willRenameFiles"]: edit } });
    const name = command === "rename" ? "renamed" : "renamed.fixture", result = await run(w.args(command, "--new-name", name));
    assert.partialDeepStrictEqual(result.data, { total: 1, shown: 1, truncated: true, textTruncated: true, workspaceEditOmitted: true });
    assert.ok(JSON.stringify(result.data).length < 8000); assert.ok(result.human.length < 7000); assert.ok(result.human.includes(":1:1-1:6 →")); assert.ok(result.human.includes("--limit 0"));
    const full = await run(w.args(command, "--new-name", name, "--limit", "0"));
    if (command === "rename") assert.deepStrictEqual(full.data.workspaceEdit, edit); else assert.deepStrictEqual(object((full.data.workspaceEdits as unknown[])[0]).edit, edit);
    const applied = await run(w.args(command, "--new-name", name, "--apply")); assert.strictEqual(applied.data.applied, true);
    assert.strictEqual(readFileSync(command === "rename" ? w.file : join(w.root, name), "utf8"), newText + " = 1\n");
  }
});
test("rename-file previews share the replacement text budget across servers", async () => {
  const w = workspace(), newText = "x".repeat(100000); writeFileSync(w.file, "value = 1\n".repeat(2));
  w.setScenario({ responses: { "workspace/willRenameFiles": { changes: { [w.uri]: [{ range, newText }] } } } });
  const other = join(w.root, "other.json"), secondRange = { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } };
  writeFileSync(other, JSON.stringify({ responses: { "workspace/willRenameFiles": { changes: { [w.uri]: [{ range: secondRange, newText }] } } } }));
  w.configs.secondary = { ...w.configs.fixture, args: [...w.configs.fixture.args!.slice(0, -1), other] }; w.saveConfig();
  const result = await run(w.args("rename-file", "--new-name", "moved.fixture"));
  assert.partialDeepStrictEqual(result.data, { total: 2, shown: 2, textTruncated: true, workspaceEditOmitted: true }); assert.ok(JSON.stringify(result.data).length < 8000);
});
test("rename previews keep uneven small replacements complete within the shared text budget", async () => {
  const w = workspace(); writeFileSync(w.file, "value = 1\n".repeat(20));
  const replacements = Array.from({ length: 20 }, (_, line) => ({ range: { start: { line, character: 0 }, end: { line, character: 5 } }, newText: line ? "v" : "x".repeat(500) })), edit = { changes: { [w.uri]: replacements } };
  w.setScenario({ responses: { "textDocument/rename": edit } });
  const result = await run(w.args("rename", "--new-name", "new"));
  assert.strictEqual(result.data.truncated, false); assert.strictEqual(result.data.textTruncated, undefined); assert.deepStrictEqual(result.data.workspaceEdit, edit);
});
test("rename preview rejects malformed replacement text before any write", async () => {
  const w = workspace({ responses: { "textDocument/rename": { changes: {} } } });
  w.setScenario({ responses: { "textDocument/rename": { changes: { [w.uri]: [{ range, newText: 42 }] } } } });
  await assert.rejects(run(w.args("rename", "--new-name", "new")), /Invalid LSP text edit/); assert.strictEqual(readFileSync(w.file, "utf8"), "value = 1\n");
});
test("unverified diagnostics include a recovery reason with zero reported findings", async () => {
  const w = workspace({ diagnostics: false }), result = await run(w.args("diagnostics"));
  assert.partialDeepStrictEqual(result.data, { success: false, verified: false, hasErrors: false }); assert.strictEqual(result.code, 1);
  const errors = (result.data.checked as { errors: string[] }[])[0].errors; assert.ok(errors.some(error => /verify.*diagnostic/i.test(error) && error.includes("doctor") && error.includes("--timeout")));
});
for (const response of [42, {}, [null], [{ title: 42 }]]) {
  test(`code-actions: malformed response ${JSON.stringify(response)} fails with provider context`, async () => {
    const w = workspace({ responses: { "textDocument/codeAction": response } });
    await assert.rejects(run(w.args("code-actions")), /Invalid code action response from fixture/);
    assert.strictEqual(w.events().some(event => event.method === "workspace/executeCommand"), false);
  });
}
test("signature-help: active overload and UTF-16 parameter offsets survive compact output", async () => {
  const w = workspace(), label = "call(😀value: string, count: number): boolean", start = label.indexOf("count");
  const response = { activeSignature: 1, activeParameter: 0, signatures: [
    { label: "call(old: string): void", documentation: "old docs" },
    { label, documentation: "large docs ".repeat(20000), activeParameter: 1, parameters: [{ label: "😀value: string" }, { label: [start, start + "count: number".length], documentation: "parameter docs" }] },
  ] };
  w.setScenario({ responses: { [signatureMethod]: response } });
  const result = await run(w.args("signature-help"));
  assert.strictEqual(parseOptions(["signature-help"]).limit, 1);
  assert.partialDeepStrictEqual(result.data, { success: true, found: true, total: 2, shown: 1, truncated: true, activeSignature: 1, activeParameter: 1, activeParameterLabel: "count: number", documentationOmitted: true, signatures: [{ index: 1, label }] });
  assert.ok(JSON.stringify(result.data).length < 1500); assert.ok((result.human).includes(": boolean")); assert.ok((result.human).includes("count: number"));
  const initialize = object(w.events().find(event => event.method === "initialize")?.params);
  assert.partialDeepStrictEqual(object(object(initialize.capabilities).textDocument).signatureHelp, { signatureInformation: { activeParameterSupport: true, parameterInformation: { labelOffsetSupport: true } } });
  assert.strictEqual(object(object(initialize.capabilities).workspace).applyEdit, false);
  const full = await run(w.args("signature-help", "--limit", "0"));
  assert.deepStrictEqual(full.data.signatures, response.signatures.map((signature, index) => ({ ...signature, index }))); assert.strictEqual(full.data.documentationOmitted, undefined);
  const raw = await run(w.args("request", "--method", signatureMethod, "--limit", "1")); assert.deepStrictEqual(raw.data.result, response);
});
for (const [caseIndex, caseValue] of ([undefined, -1, 99, 0.5, "1"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async active => {
  const w = workspace({ responses: { [signatureMethod]: { activeSignature: active, activeParameter: active, signatures: [{ label: "call(value: string)", parameters: [{ label: "value: string" }] }] } } });
  assert.partialDeepStrictEqual((await run(w.args("signature-help"))).data, { activeSignature: 0, activeParameter: 0, activeParameterLabel: "value: string" });
};
  test("signature-help: invalid active indices default according to LSP (%s)".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("signature-help: null results stop promptly and explain the cursor location", async () => {
  const w = workspace(), result = await run(w.args("signature-help"));
  assert.partialDeepStrictEqual(result.data, { success: true, found: false, total: 0, signatures: [], activeSignature: null, activeParameter: null });
  assert.ok((String(result.data.hint)).includes("inside a call")); assert.ok(String(result.data.hint).includes("just after '('")); assert.ok(String(result.data.hint).includes("hover")); assert.strictEqual((w.events().filter(event => event.method === signatureMethod)).length, 1);
});
for (const [caseIndex, caseValue] of ([{}, { signatures: [null] }, { signatures: "invalid" }, 42, []].map(response => ({ response }))).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async ({ response }) => {
  const w = workspace({ responses: { [signatureMethod]: response } });
  await assert.rejects(run(w.args("signature-help")), (error) => error instanceof Error && error.message.includes(String("Invalid signature help response")));
};
  test("signature-help: malformed response %# fails and cleans up".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
test("signature-help: large labels are bounded and the active overload remains first", async () => {
  const w = workspace(), signatures = Array.from({ length: 10 }, (_, index) => ({ label: `call${index}(${'x'.repeat(20000)}): boolean` }));
  w.setScenario({ responses: { [signatureMethod]: { activeSignature: 9, signatures } } });
  const result = await run(w.args("signature-help", "--limit", "3"));
  assert.partialDeepStrictEqual(result.data, { activeSignature: 9, shown: 3, truncated: true, textTruncated: true });
  assert.strictEqual((result.data.signatures as { index: number }[])[0].index, 9); assert.ok(JSON.stringify(result.data).length < 7200);
  assert.deepStrictEqual((await run(w.args("signature-help", "--limit", "0"))).data.signatures, signatures.map((signature, index) => ({ ...signature, index })));
});
test("signature-help: ContentModified recovery and UTF-16 request positions use the navigation path", async () => {
  const w = workspace({ contentModified: { [signatureMethod]: 1 }, responses: { [signatureMethod]: { signatures: [{ label: "call()" }] } } });
  writeFileSync(w.file, '"😀"; call(\n');
  const result = await run(w.args("signature-help", "--column", "12")); assert.strictEqual(result.data.found, true);
  const events = w.events().filter(event => event.method === signatureMethod);
  assert.strictEqual((events).length, 2); assert.deepStrictEqual(object(events[0].params).position, { line: 0, character: 11 });
});
for (const [caseIndex, caseValue] of (["definition", "references", "hover", "type-definition", "implementation", "signature-help"]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async command => {
  const w = workspace(), start = mock.method(LspClient, "start");
  try { await assert.rejects(run(w.args(command, "--apply")), (error) => error instanceof Error && error.message.includes(String("read-only"))); assert.strictEqual(start.mock.callCount(), 0); }
  finally { start.mock.restore(); }
};
  test("output: read-only command %s rejects apply before startup".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
