import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LspClient } from "../src/client.ts";
import { parseOptions } from "../src/cli.ts";
import { run } from "../src/commands.ts";
import { fileUri, object } from "../src/config.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
beforeAll(() => { restore = isolateGlobalConfig(); });
afterAll(() => restore());
afterEach(async () => {
  const leaked = LspClient.active.size;
  await Promise.all([...LspClient.active].map(client => client.close()));
  cleanWorkspaces(); expect(leaked).toBe(0);
});
const signatureMethod = "textDocument/signatureHelp";
test("output: repeated reference paths are grouped while JSON locations stay complete", async () => {
  const w = workspace(), locations = Array.from({ length: 50 }, (_, line) => ({ uri: w.uri, range: { start: { line, character: 0 }, end: { line, character: 1 } } }));
  writeFileSync(w.file, "value = 1\n".repeat(60)); w.setScenario({ responses: { "textDocument/references": locations } });
  const result = await run(w.args("references"));
  expect(result.data).toMatchObject({ success: true, found: true, total: 50, shown: 50, truncated: false });
  expect((result.data.locations as { file: string; line: number }[]).map(row => [row.file, row.line])).toEqual(locations.map((_, line) => [w.file, line + 1]));
  expect(result.human).toContain(`Root: ${w.root}`); expect(result.human.split("source.fixture")).toHaveLength(2);
  expect(result.human).toContain("50:1"); expect(result.human.length).toBeLessThan(locations.length * w.file.length / 2);
});
test("output: grouped locations preserve Unicode paths and external absolute targets", async () => {
  const w = workspace(), outside = workspace(), file = join(w.root, "src/中文 file.fixture");
  mkdirSync(join(w.root, "src")); writeFileSync(file, "value = 1\n");
  w.setScenario({ responses: { "textDocument/definition": [{ uri: fileUri(file), range }, { uri: outside.uri, range }, { uri: fileUri(w.root), range }] } });
  const result = await run(w.args("definition"));
  expect(result.human).toContain("中文 file.fixture:1:1"); expect(result.human).toContain(outside.file);
  expect(result.human).toContain(".:1:1");
  expect((result.data.locations as { file: string }[]).map(row => row.file)).toEqual([file, outside.file, w.root]);
});
test("output: file symbols group names without dropping coordinates or kinds", async () => {
  const w = workspace({ responses: { "textDocument/documentSymbol": [{ name: "Alpha", kind: 12, range }, { name: "Beta", kind: 13, range }] } });
  const result = await run(w.args("symbols"));
  expect(result.human.split("source.fixture")).toHaveLength(2); expect(result.human).toContain("Alpha@1:1"); expect(result.human).toContain("Beta@1:1");
  expect((result.data.symbols as { kind: number }[]).map(row => row.kind)).toEqual([12, 13]);
});
test("output: hover bounds a huge single-line RPC response without splitting Unicode", async () => {
  const w = workspace(), content = "x".repeat(5999) + "😀" + "y".repeat(100000);
  w.setScenario({ responses: { "textDocument/hover": { contents: content } } });
  const result = await run(w.args("hover"));
  expect(result.data).toMatchObject({ success: true, found: true, total: 1, shown: 1, truncated: true, characters: { total: content.length, shown: 5999 } });
  expect(result.data.hover).toBe(content.slice(0, 5999)); expect(Buffer.from(String(result.data.hover)).toString("utf8")).toBe(String(result.data.hover));
  expect(JSON.stringify(result.data).length).toBeLessThan(6500); expect(result.human).toContain("--limit 0");
  expect((await run(w.args("hover", "--limit", "0"))).data.hover).toBe(content);
});
test("output: inspect retains verified code errors alongside a bounded hover", async () => {
  const w = workspace({ diagnostics: [{ range, message: "existing code error", severity: 1 }], responses: { "textDocument/hover": { contents: "x".repeat(200000) } } });
  const result = await run(w.args("inspect"));
  expect(result.code).toBe(1); expect(result.data).toMatchObject({ success: false, failedSections: ["diagnostics"] });
  expect(object(object(result.data.results).hover).truncated).toBe(true); expect(result.human).toContain("existing code error");
  expect(result.human.length).toBeLessThan(7500); expect(result.human.split("Root:")).toHaveLength(2);
});
test("signature-help: active overload and UTF-16 parameter offsets survive compact output", async () => {
  const w = workspace(), label = "call(😀value: string, count: number): boolean", start = label.indexOf("count");
  const response = { activeSignature: 1, activeParameter: 0, signatures: [
    { label: "call(old: string): void", documentation: "old docs" },
    { label, documentation: "large docs ".repeat(20000), activeParameter: 1, parameters: [{ label: "😀value: string" }, { label: [start, start + "count: number".length], documentation: "parameter docs" }] },
  ] };
  w.setScenario({ responses: { [signatureMethod]: response } });
  const result = await run(w.args("signature-help"));
  expect(parseOptions(["signature-help"]).limit).toBe(1);
  expect(result.data).toMatchObject({ success: true, found: true, total: 2, shown: 1, truncated: true, activeSignature: 1, activeParameter: 1, activeParameterLabel: "count: number", documentationOmitted: true, signatures: [{ index: 1, label }] });
  expect(JSON.stringify(result.data).length).toBeLessThan(1500); expect(result.human).toContain(": boolean"); expect(result.human).toContain("count: number");
  const initialize = object(w.events().find(event => event.method === "initialize")?.params);
  expect(object(object(initialize.capabilities).textDocument).signatureHelp).toMatchObject({ signatureInformation: { activeParameterSupport: true, parameterInformation: { labelOffsetSupport: true } } });
  expect(object(object(initialize.capabilities).workspace).applyEdit).toBe(false);
  const full = await run(w.args("signature-help", "--limit", "0"));
  expect(full.data.signatures).toEqual(response.signatures.map((signature, index) => ({ ...signature, index }))); expect(full.data.documentationOmitted).toBeUndefined();
  const raw = await run(w.args("request", "--method", signatureMethod, "--limit", "1")); expect(raw.data.result).toEqual(response);
});
test.each([undefined, -1, 99, 0.5, "1"])("signature-help: invalid active indices default according to LSP (%s)", async active => {
  const w = workspace({ responses: { [signatureMethod]: { activeSignature: active, activeParameter: active, signatures: [{ label: "call(value: string)", parameters: [{ label: "value: string" }] }] } } });
  expect((await run(w.args("signature-help"))).data).toMatchObject({ activeSignature: 0, activeParameter: 0, activeParameterLabel: "value: string" });
});
test("signature-help: null results stop promptly and explain the cursor location", async () => {
  const w = workspace(), result = await run(w.args("signature-help"));
  expect(result.data).toMatchObject({ success: true, found: false, total: 0, signatures: [], activeSignature: null, activeParameter: null });
  expect(String(result.data.hint)).toContain("inside a call"); expect(w.events().filter(event => event.method === signatureMethod)).toHaveLength(1);
});
test.each([{}, { signatures: [null] }, { signatures: "invalid" }, 42, []].map(response => ({ response })))("signature-help: malformed response %# fails and cleans up", async ({ response }) => {
  const w = workspace({ responses: { [signatureMethod]: response } });
  await expect(run(w.args("signature-help"))).rejects.toThrow("Invalid signature help response");
});
test("signature-help: large labels are bounded and the active overload remains first", async () => {
  const w = workspace(), signatures = Array.from({ length: 10 }, (_, index) => ({ label: `call${index}(${'x'.repeat(20000)}): boolean` }));
  w.setScenario({ responses: { [signatureMethod]: { activeSignature: 9, signatures } } });
  const result = await run(w.args("signature-help", "--limit", "3"));
  expect(result.data).toMatchObject({ activeSignature: 9, shown: 3, truncated: true, textTruncated: true });
  expect((result.data.signatures as { index: number }[])[0].index).toBe(9); expect(JSON.stringify(result.data).length).toBeLessThan(7200);
  expect((await run(w.args("signature-help", "--limit", "0"))).data.signatures).toEqual(signatures.map((signature, index) => ({ ...signature, index })));
});
test("signature-help: ContentModified recovery and UTF-16 request positions use the navigation path", async () => {
  const w = workspace({ contentModified: { [signatureMethod]: 1 }, responses: { [signatureMethod]: { signatures: [{ label: "call()" }] } } });
  writeFileSync(w.file, '"😀"; call(\n');
  const result = await run(w.args("signature-help", "--column", "12")); expect(result.data.found).toBe(true);
  const events = w.events().filter(event => event.method === signatureMethod);
  expect(events).toHaveLength(2); expect(object(events[0].params).position).toEqual({ line: 0, character: 11 });
});
test.each(["definition", "references", "hover", "type-definition", "implementation", "signature-help"])("output: read-only command %s rejects apply before startup", async command => {
  const w = workspace(), start = spyOn(LspClient, "start");
  try { await expect(run(w.args(command, "--apply"))).rejects.toThrow("read-only"); expect(start).not.toHaveBeenCalled(); }
  finally { start.mockRestore(); }
});
