import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LspClient } from "../src/client.ts";
import { typeHierarchy, inlayHints } from "../src/type-hints.ts";
import { object, MAX_FILES, fileUri, type ObjectValue, type Server } from "../src/config.ts";
import type { Options } from "../src/commands.ts";
import type { Range } from "../src/omp/types.ts";
const roots: string[] = [];
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };
function workspace(scenario: ObjectValue = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-lsp type hints "))); roots.push(root);
  const file = join(root, "source.fixture"), trace = join(root, "wire.ndjson"), scenarioPath = join(root, "scenario.json");
  writeFileSync(file, "value = 1\n"); writeFileSync(scenarioPath, JSON.stringify(scenario));
  const server: Server = { name: "fixture", root, command: process.execPath, resolvedCommand: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/lsp-server.js", import.meta.url)), "scenario", trace, scenarioPath] };
  const args: Options = { command: "hover", cwd: root, file, languages: [], line: 1, timeout: 400, limit: 50, json: true,
    changed: false, workspace: false, apply: false, project: false, globalBinsOnly: false, globalConfigOnly: false };
  return { root, file, uri: fileUri(file), server, args, setScenario: (value: ObjectValue) => writeFileSync(scenarioPath, JSON.stringify(value)),
    events: (): ObjectValue[] => readFileSync(trace, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) };
}
afterEach(async () => { const leaked = LspClient.active.size; await Promise.all([...LspClient.active].map(client => client.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); assert.equal(leaked, 0); });
const list = (value: unknown) => value as Record<string, unknown>[];
const item = (uri: string, name: string, line = 0) => ({ uri, name, kind: 5, range: { start: { line, character: 0 }, end: { line, character: 9 } }, selectionRange: { start: { line, character: 0 }, end: { line, character: 5 } }, data: { key: name, opaque: [1, { keep: true }] } });
async function query(w: ReturnType<typeof workspace>, command: string, options: Partial<Options> = {}, requested: Range = range) {
  const client = await LspClient.start(w.server, 1000);
  try {
    await client.open(w.file);
    const args = { ...w.args, command, ...options };
    return command === "inlay-hints" ? await inlayHints(args, client, w.uri, requested) : await typeHierarchy(args, client, w.uri, { line: 0, character: 0 });
  } finally { await client.close(); }
}

test("type hierarchy: supertypes preserve opaque items, cycles and subtype-to-supertype edges in one read-only session", async () => {
  const w = workspace(), a = item(w.uri, "Child"), b = item(w.uri, "Parent", 1), c = item(w.uri, "Base", 2);
  w.setScenario({ capabilities: { typeHierarchyProvider: true }, responses: { "textDocument/prepareTypeHierarchy": [a] }, responsesByItem: { "typeHierarchy/supertypes": { Child: [b], Parent: [c, a] } } });
  const result = await query(w, "supertypes", { depth: 2 });
  assert.equal(result.data.success, true); assert.equal(result.data.complete, true); assert.equal(result.data.total, 3);
  assert.deepEqual(list(result.data.edges), [{ from: "0", to: "1" }, { from: "1", to: "2" }, { from: "1", to: "0" }]);
  const requests = w.events().filter(event => event.method === "typeHierarchy/supertypes");
  assert.equal(requests.length, 2); assert.deepEqual(object(requests[1].params).item, b);
  assert.equal(w.events().filter(event => event.method === "initialize").length, 1);
  assert.equal(object(object(object(w.events().find(event => event.method === "initialize")?.params).capabilities).workspace).applyEdit, false);
});
test("type hierarchy: subtype traversal keeps edge direction, deduplicates branches and clips without dangling IDs", async () => {
  const w = workspace(), base = item(w.uri, "Base"), child = item("file:///child.fixture", "Child");
  w.setScenario({ capabilities: { typeHierarchyProvider: true }, responses: { "textDocument/prepareTypeHierarchy": [base], "typeHierarchy/subtypes": [child, child] } });
  const result = await query(w, "subtypes");
  assert.deepEqual(list(result.data.edges), [{ from: "1", to: "0" }]); assert.equal(result.data.totalEdges, 1);
  const clipped = await query(w, "subtypes", { limit: 1 });
  assert.equal(clipped.data.shown, 1); assert.deepEqual(clipped.data.edges, []); assert.equal(clipped.data.totalEdges, 1); assert.equal(clipped.data.shownEdges, 0); assert.equal(clipped.data.truncated, true);
});
test("type hierarchy: binding selections before expression bodies retain original provider data", async () => {
  const w = workspace(), binding = { ...item(w.uri, "Assigned"), range: { start: { line: 0, character: 30 }, end: { line: 4, character: 1 } }, selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 14 } } };
  w.setScenario({ capabilities: { typeHierarchyProvider: true }, responses: { "textDocument/prepareTypeHierarchy": [binding] } });
  const result = await query(w, "supertypes");
  assert.equal(list(result.data.nodes)[0].selectionBeforeRange, true); assert.equal(list(result.data.nodes)[0].column, 7);
  assert.deepEqual(object(w.events().find(event => event.method === "typeHierarchy/supertypes")?.params).item, binding);
});
test("type hierarchy: a failed branch preserves sibling results and identifies its source node", async () => {
  const w = workspace(), a = item(w.uri, "A"), b = item(w.uri, "B"), c = item(w.uri, "C");
  w.setScenario({ capabilities: { typeHierarchyProvider: true }, responses: { "textDocument/prepareTypeHierarchy": [a, b] }, errorsByItem: { "typeHierarchy/supertypes": { A: { code: -32603, message: "failed branch" } } }, responsesByItem: { "typeHierarchy/supertypes": { B: [c] } } });
  const result = await query(w, "supertypes");
  assert.equal(result.code, 1); assert.equal(result.data.found, true); assert.equal(result.data.complete, false);
  assert.equal(result.data.total, 3); assert.deepEqual(list(result.data.edges), [{ from: "1", to: "2" }]);
  assert.equal(list(result.data.errors)[0].node, "0"); assert.match(String(list(result.data.errors)[0].error), /failed branch/);
});
test("type hierarchy: node and edge budgets retain explicit incomplete state", async () => {
  const w = workspace();
  w.setScenario({ capabilities: { typeHierarchyProvider: true }, responses: { "textDocument/prepareTypeHierarchy": [item(w.uri, "Root")], "typeHierarchy/subtypes": Array.from({ length: MAX_FILES + 1 }, (_, i) => item(w.uri, `Child${i}`, i + 1)) } });
  const result = await query(w, "subtypes", { depth: 10, limit: 0 });
  assert.equal(result.data.total, MAX_FILES); assert.equal(result.data.complete, false); assert.equal(result.data.bounded, true); assert.equal(result.data.truncated, true);
  const ids = new Set(list(result.data.nodes).map(node => node.id)); assert.ok(list(result.data.edges).every(edge => ids.has(edge.from) && ids.has(edge.to)));
});
test("type hierarchy: dense graphs stop after 1000 unique edges", async () => {
  const w = workspace(), roots = Array.from({ length: MAX_FILES }, (_, i) => item(w.uri, `Type${i}`, i));
  w.setScenario({ capabilities: { typeHierarchyProvider: true }, responses: { "textDocument/prepareTypeHierarchy": roots, "typeHierarchy/supertypes": roots } });
  const result = await query(w, "supertypes", { limit: 0, timeout: 1000 });
  assert.equal(result.data.totalEdges, MAX_FILES * 5); assert.equal(result.data.bounded, true); assert.equal(result.data.complete, false);
  assert.equal(w.events().filter(event => event.method === "typeHierarchy/supertypes").length, 6);
});
test("type hierarchy: stalled traversal cancels its request and preserves the prepared root", async () => {
  const w = workspace(); w.setScenario({ capabilities: { typeHierarchyProvider: true }, responses: { "textDocument/prepareTypeHierarchy": [item(w.uri, "Root")] }, stallMethods: ["typeHierarchy/supertypes"] });
  const result = await query(w, "supertypes", { timeout: 200 });
  assert.equal(result.code, 1); assert.equal(result.data.total, 1); assert.equal(result.data.bounded, true);
  assert.equal(result.data.complete, false); assert.ok(w.events().some(event => event.method === "$/cancelRequest"));
});
test("type hierarchy: invalid items and relation responses fail explicitly", async () => {
  for (const invalid of [null, { name: "Missing" }, { ...item("file:///x", "Bad"), selectionRange: { start: { line: 1, character: 0 }, end: { line: 0, character: 1 } } }]) {
    const w = workspace({ capabilities: { typeHierarchyProvider: true }, responses: { "textDocument/prepareTypeHierarchy": [invalid] } });
    await assert.rejects(query(w, "supertypes"), /Invalid type hierarchy item/);
  }
  const w = workspace(); w.setScenario({ capabilities: { typeHierarchyProvider: true }, responses: { "textDocument/prepareTypeHierarchy": [item(w.uri, "Root")], "typeHierarchy/subtypes": { items: [] } } });
  const result = await query(w, "subtypes"); assert.equal(result.code, 1); assert.equal(result.data.totalEdges, 0); assert.match(String(list(result.data.errors)[0].error), /Invalid typeHierarchy/);
});
test("new semantic features: unsupported providers remain distinct from empty results", async () => {
  for (const command of ["supertypes", "subtypes", "inlay-hints"]) {
    const w = workspace({ capabilities: {} }), unsupported = await query(w, command);
    assert.equal(unsupported.data.supported, false); assert.equal(unsupported.code, 1);
    assert.equal(w.events().some(event => String(event.method).includes("TypeHierarchy") || event.method === "textDocument/inlayHint"), false);
  }
  const w = workspace({ capabilities: { typeHierarchyProvider: true, inlayHintProvider: {} } });
  for (const command of ["supertypes", "inlay-hints"]) {
    const empty = await query(w, command); assert.equal(empty.data.success, true); assert.equal(empty.data.supported, true); assert.equal(empty.data.found, false); assert.equal(empty.data.total, 0);
  }
});

test("inlay hints: composite labels and opaque resolution are read-only and retain query range", async () => {
  const w = workspace(), typed = { position: { line: 0, character: 1 }, label: ": number", kind: 1, data: { key: "typed", opaque: [1, 2] }, textEdits: [{ range, newText: "corrupt" }] };
  const parameter = { position: { line: 0, character: 4 }, label: [{ value: "value:", location: { uri: w.uri, range }, command: { command: "danger.execute" } }], kind: 2, data: { key: "parameter" } };
  w.setScenario({ capabilities: { inlayHintProvider: { resolveProvider: true } }, responses: { "textDocument/inlayHint": [typed, parameter] }, responsesByItem: { "inlayHint/resolve": {
    typed: { ...typed, tooltip: { kind: "markdown", value: "A number" } }, parameter: { ...parameter, label: [{ ...parameter.label[0], tooltip: "The argument" }] },
  } } });
  const before = readFileSync(w.file), result = await query(w, "inlay-hints", { resolveCompletion: true });
  assert.equal(result.data.success, true); assert.deepEqual(list(result.data.hints).map(hint => [hint.label, hint.kind, hint.tooltip]), [[": number", 1, "A number"], ["value:", 2, "The argument"]]);
  assert.equal(result.data.detailsOmitted, true); assert.deepEqual(list(result.data.hints).map(hint => [hint.line, hint.column]), [[1, 2], [1, 5]]);
  const requests = w.events().filter(event => event.method === "inlayHint/resolve"); assert.deepEqual(requests.map(event => event.params), [typed, parameter]);
  assert.deepEqual(object(w.events().find(event => event.method === "textDocument/inlayHint")?.params).range, range);
  assert.equal(w.events().some(event => event.method === "workspace/executeCommand" || event.method === "textDocument/didChange"), false); assert.deepEqual(readFileSync(w.file), before);
});
test("inlay hints: resolution failures preserve labels and successful siblings", async () => {
  const bad = { position: { line: 0, character: 1 }, label: "bad", data: { key: "bad" } }, good = { position: { line: 0, character: 2 }, label: "good", data: { key: "good" } };
  const w = workspace({ capabilities: { inlayHintProvider: { resolveProvider: true } }, responses: { "textDocument/inlayHint": [bad, good] }, errorsByItem: { "inlayHint/resolve": { bad: { code: -32603, message: "resolve failed" } } }, responsesByItem: { "inlayHint/resolve": { good: { ...good, tooltip: "available" } } } });
  const result = await query(w, "inlay-hints", { resolveCompletion: true });
  assert.equal(result.code, 1); assert.equal(list(result.data.hints).length, 2); assert.equal(list(result.data.hints)[0].label, "bad"); assert.equal(list(result.data.hints)[1].tooltip, "available"); assert.match(String(list(result.data.errors)[0].error), /resolve failed/);
});
test("inlay hints: malformed payloads and out-of-range positions are rejected", async () => {
  const position = { line: 0, character: 1 };
  for (const response of [{ items: [] }, [null], [{ position, label: "" }], [{ position, label: "\ud800" }], [{ position: { line: -1, character: 0 }, label: "x" }], [{ position, label: [null] }], [{ position, label: "x", kind: "1" }], [{ position, label: "x", tooltip: { kind: "html", value: "x" } }], [{ position, label: [{ value: "x", location: { uri: "file:///x", range: {} } }] }]]) {
    const w = workspace({ capabilities: { inlayHintProvider: {} }, responses: { "textDocument/inlayHint": response } });
    await assert.rejects(query(w, "inlay-hints"), /Invalid inlay/);
  }
  const w = workspace({ capabilities: { inlayHintProvider: {} }, responses: { "textDocument/inlayHint": [{ position: { line: 0, character: 6 }, label: "out" }] } });
  await assert.rejects(query(w, "inlay-hints"), /outside the requested range/);
});
test("inlay hints: unsupported resolution retains available labels with explicit capability state", async () => {
  const w = workspace({ capabilities: { inlayHintProvider: {} }, responses: { "textDocument/inlayHint": [{ position: { line: 0, character: 1 }, label: "number" }] } });
  const result = await query(w, "inlay-hints", { resolveCompletion: true });
  assert.equal(result.data.success, true); assert.deepEqual(result.data.resolution, { supported: false, attempted: 0, limited: false }); assert.equal(w.events().some(event => event.method === "inlayHint/resolve"), false);
});
test("inlay hints: interior line lengths and surrogate-pair boundaries are validated against the opened source", async () => {
  for (const position of [{ line: 1, character: 2 }, { line: 0, character: 1 }]) {
    const w = workspace({ capabilities: { inlayHintProvider: {} }, responses: { "textDocument/inlayHint": [{ position, label: "number" }] } });
    writeFileSync(w.file, "😀value\r\n\r\nend\n");
    await assert.rejects(query(w, "inlay-hints", {}, { start: { line: 0, character: 0 }, end: { line: 2, character: 3 } }), /Invalid inlay hint source position/);
  }
});
test("inlay hints: provider edit callbacks are rejected and cannot modify source", async () => {
  const w = workspace(), original = { position: { line: 0, character: 1 }, label: "number" };
  w.setScenario({ capabilities: { inlayHintProvider: { resolveProvider: true } }, responses: { "textDocument/inlayHint": [original] }, callbacks: { "inlayHint/resolve": { method: "workspace/applyEdit", params: { edit: { changes: { [w.uri]: [{ range, newText: "corrupt" }] } } } } } });
  const before = readFileSync(w.file), result = await query(w, "inlay-hints", { resolveCompletion: true });
  assert.equal(result.code, 1); assert.equal(list(result.data.hints)[0].label, "number"); assert.deepEqual(readFileSync(w.file), before);
  assert.ok(w.events().some(event => event.direction === "receive" && object(event.result).applied === false));
});
test("inlay hints: previews share a Unicode-safe text budget while full output retains provider edits and parts", async () => {
  const value = { position: { line: 0, character: 1 }, label: [{ value: "😀".repeat(4000), command: { command: "data.only" } }], tooltip: { kind: "markdown", value: "😀".repeat(4000) }, textEdits: [{ range, newText: "data" }], data: { opaque: true } };
  const w = workspace({ capabilities: { inlayHintProvider: {} }, responses: { "textDocument/inlayHint": [value] } });
  const preview = await query(w, "inlay-hints"), shown = list(preview.data.hints)[0];
  assert.equal(preview.data.textTruncated, true); assert.equal(preview.data.truncated, true);
  assert.ok(String(shown.label).length + String(shown.tooltip).length <= 6000); assert.ok(String(shown.label).isWellFormed()); assert.ok(String(shown.tooltip).isWellFormed()); assert.equal(shown.textEdits, undefined);
  const full = list((await query(w, "inlay-hints", { limit: 0 })).data.hints)[0];
  assert.deepEqual(full.label, value.label); assert.deepEqual(full.tooltip, value.tooltip); assert.deepEqual(full.textEdits, value.textEdits); assert.deepEqual(full.data, value.data);
});
test("inlay hints: resolve budget bounds native requests and marks unresolved candidates", async () => {
  const hints = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ position: { line: 0, character: 1 }, label: `value${i}`, data: { key: String(i) } }));
  const w = workspace({ capabilities: { inlayHintProvider: { resolveProvider: true } }, responses: { "textDocument/inlayHint": hints }, responsesByItem: { "inlayHint/resolve": Object.fromEntries(hints.map(hint => [hint.data.key, { ...hint, tooltip: "resolved" }])) } });
  const result = await query(w, "inlay-hints", { limit: 0, resolveCompletion: true, timeout: 2000 });
  assert.equal(result.data.total, MAX_FILES + 1); assert.equal(result.data.truncated, true); assert.deepEqual(result.data.resolution, { supported: true, attempted: MAX_FILES, limited: true });
  assert.equal(w.events().filter(event => event.method === "inlayHint/resolve").length, MAX_FILES); assert.equal(list(result.data.hints).at(-1)!.tooltip, undefined);
});
test("inlay hints: resolver anchor changes retain the original location and report an error", async () => {
  const original = { position: { line: 0, character: 1 }, label: "original" };
  const w = workspace({ capabilities: { inlayHintProvider: { resolveProvider: true } }, responses: { "textDocument/inlayHint": [original], "inlayHint/resolve": { ...original, position: { line: 0, character: 2 } } } });
  const result = await query(w, "inlay-hints", { resolveCompletion: true });
  assert.equal(result.code, 1); assert.equal(list(result.data.hints)[0].column, 2); assert.match(String(list(result.data.errors)[0].error), /changed its anchor or label/);
});
test("new semantic features: transient ContentModified replies retry within their request deadline", async () => {
  const w = workspace(); w.setScenario({ capabilities: { typeHierarchyProvider: true, inlayHintProvider: {} }, contentModified: { "textDocument/prepareTypeHierarchy": 1, "textDocument/inlayHint": 1 }, responses: { "textDocument/prepareTypeHierarchy": [item(w.uri, "Root")], "textDocument/inlayHint": [{ position: { line: 0, character: 1 }, label: "number" }] } });
  assert.equal((await query(w, "supertypes")).data.found, true); assert.equal((await query(w, "inlay-hints")).data.found, true);
  assert.equal(w.events().filter(event => event.method === "textDocument/prepareTypeHierarchy").length, 2); assert.equal(w.events().filter(event => event.method === "textDocument/inlayHint").length, 2);
});
