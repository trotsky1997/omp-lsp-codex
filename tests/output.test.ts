import assert from "node:assert/strict";
import { after, afterEach, before, test, mock } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LspClient } from "../src/client.ts";
import { parseOptions } from "../src/cli.ts";
import { run } from "../src/commands.ts";
import { fileUri, object } from "../src/config.ts";
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
