import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/commands.ts";
import { parseOptions } from "../src/cli.ts";
import { LspClient } from "../src/client.ts";
import { object, MAX_FILES } from "../src/config.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); }); after(() => restore());
afterEach(async () => { const leaked = LspClient.active.size; await Promise.all([...LspClient.active].map(c => c.close())); cleanWorkspaces(); assert.equal(leaked, 0); });
const list = (value: unknown) => value as Record<string, unknown>[];
function item(uri: string, name: string, line = 0) { return { uri, name, kind: 12, range: { start: { line, character: 0 }, end: { line, character: 9 } }, selectionRange: { start: { line, character: 0 }, end: { line, character: 5 } }, data: { key: name, opaque: [1, { keep: true }] } }; }

test("read-only commands reject --apply before opening a server or authorizing callbacks", async () => {
  const w = workspace();
  for (const command of ["symbols", "diagnostics", "callers", "callees", "complete", "impact"])
    await assert.rejects(run(w.args(command, "--apply")), /read-only/);
  assert.equal(existsSync(join(w.root, "wire.ndjson")), false);
});

test("callers: two-level traversal preserves opaque data, call sites and cycles in one read-only session", async () => {
  const w = workspace(), a = item(w.uri, "a"), b = item(w.uri, "b", 1), c = item(w.uri, "c", 2);
  w.setScenario({ capabilities: { callHierarchyProvider: true }, responses: { "textDocument/prepareCallHierarchy": [a] }, responsesByItem: { "callHierarchy/incomingCalls": {
    a: [{ from: b, fromRanges: [range] }], b: [{ from: c, fromRanges: [range] }, { from: a, fromRanges: [range] }],
  } } });
  const response = await run(w.args("callers", "--depth", "2"));
  assert.equal(response.data.success, true); assert.equal(response.data.total, 3);
  assert.deepEqual(list(response.data.edges).map(e => [e.from, e.to]), [["1", "0"], ["2", "1"], ["0", "1"]]);
  assert.equal(list(response.data.edges)[0].locations instanceof Array, true);
  const requests = w.events().filter(e => e.method === "callHierarchy/incomingCalls");
  assert.equal(requests.length, 2); assert.deepEqual(object(requests[1].params).item, b);
  assert.equal(w.events().filter(e => e.method === "initialize").length, 1);
  assert.equal(object(object(object(w.events().find(e => e.method === "initialize")?.params).capabilities).workspace).applyEdit, false);
});
test("callees: outgoing call sites belong to the caller and graph display never has dangling edges", async () => {
  const w = workspace(), a = item(w.uri, "a"), b = item("file:///callee.fixture", "b");
  w.setScenario({ capabilities: { callHierarchyProvider: true }, responses: { "textDocument/prepareCallHierarchy": [a], "callHierarchy/outgoingCalls": [{ to: b, fromRanges: [range] }] } });
  const result = await run(w.args("callees"));
  assert.deepEqual(list(result.data.edges).map(e => [e.from, e.to]), [["0", "1"]]);
  assert.equal(list(result.data.nodes).find(n => n.id === list(result.data.edges)[0].from)?.file, w.file);
  assert.deepEqual(list(result.data.edges)[0].locations, [{ line: 1, column: 1 }]);
  const limited = await run(w.args("callees", "--limit", "1"));
  assert.equal(limited.data.truncated, true); assert.equal(list(limited.data.nodes).length, 1); assert.deepEqual(limited.data.edges, []);
  assert.equal(limited.data.totalEdges, 1); assert.equal(limited.data.shownEdges, 0);
});
test("hierarchy: compact call sites reconstruct every incoming location from the caller node", async () => {
  const w = workspace(), caller = item(w.uri, "caller"), sites = Array.from({ length: 30 }, (_, line) => ({ start: { line, character: 3 }, end: { line, character: 8 } }));
  w.setScenario({ capabilities: { callHierarchyProvider: true }, responses: { "textDocument/prepareCallHierarchy": [item("file:///different-callee.fixture", "callee")], "callHierarchy/incomingCalls": [{ from: caller, fromRanges: sites }] } });
  const result = await run(w.args("callers", "--limit", "0")), edge = list(result.data.edges)[0], node = list(result.data.nodes).find(n => n.id === edge.from)!;
  const reconstructed = list(edge.locations).map(site => ({ file: node.file, ...site }));
  assert.deepEqual(reconstructed, sites.map(site => ({ file: w.file, line: site.start.line + 1, column: 4 })));
  assert.ok(list(edge.locations).every(site => !Object.hasOwn(site, "file")));
  assert.ok(JSON.stringify(reconstructed).length - JSON.stringify(edge.locations).length > 1000);
  assert.equal(result.data.totalEdges, 1); assert.equal(result.data.shownEdges, 1);
});
for (const command of ["callers", "callees", "complete"]) test(`${command}: invalid cursor ranges fail before starting a server`, async () => {
  const w = workspace();
  await assert.rejects(run(w.args(command, "--line", "1", "--column", "99")), /valid columns: 1-10 \(UTF-16\)/);
  assert.equal(existsSync(join(w.root, "wire.ndjson")), false);
});
test("hierarchy: a function-expression binding can precede its expression range without changing the provider item", async () => {
  const w = workspace(), binding = { ...item(w.uri, "assigned"), range: { start: { line: 0, character: 30 }, end: { line: 4, character: 1 } }, selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 14 } } };
  w.setScenario({ capabilities: { callHierarchyProvider: true }, responses: { "textDocument/prepareCallHierarchy": [binding] } });
  const result = await run(w.args("callers"));
  assert.equal(result.data.success, true); assert.equal(list(result.data.nodes)[0].column, 7);
  assert.equal(list(result.data.nodes)[0].selectionBeforeRange, true);
  assert.deepEqual(object(w.events().find(e => e.method === "callHierarchy/incomingCalls")?.params).item, binding);
});
test("hierarchy: a failed branch retains siblings and exposes its node error", async () => {
  const w = workspace(), a = item(w.uri, "a"), b = item(w.uri, "b", 1), c = item(w.uri, "c", 2);
  w.setScenario({ capabilities: { callHierarchyProvider: true }, responses: { "textDocument/prepareCallHierarchy": [a, b] }, errorsByItem: { "callHierarchy/outgoingCalls": { a: { code: -32603, message: "branch failed" } } }, responsesByItem: { "callHierarchy/outgoingCalls": { b: [{ to: c, fromRanges: [range] }] } } });
  const result = await run(w.args("callees"));
  assert.equal(result.code, 1); assert.equal(result.data.found, true); assert.equal(result.data.total, 3);
  assert.match(String(list(result.data.errors)[0].error), /branch failed/);
});
test("hierarchy: hard node bounds terminate a large response and retain valid graph IDs", async () => {
  const w = workspace();
  w.setScenario({ capabilities: { callHierarchyProvider: true }, responses: { "textDocument/prepareCallHierarchy": [item(w.uri, "a")], "callHierarchy/outgoingCalls": Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ to: item(w.uri, `n${i}`, i + 1), fromRanges: [range] })) } });
  const result = await run(w.args("callees", "--limit", "0", "--depth", "10"));
  assert.equal(result.data.total, MAX_FILES); assert.equal(result.data.bounded, true); assert.equal(result.data.truncated, true);
  const ids = new Set(list(result.data.nodes).map(n => n.id));
  assert.ok(list(result.data.edges).every(e => ids.has(e.from) && ids.has(e.to)));
});
test("hierarchy: repeated edges and large call-site lists have bounded, explicit previews", async () => {
  const w = workspace(), edge = { to: item(w.uri, "b"), fromRanges: Array.from({ length: 20 }, (_, i) => ({ start: { line: 0, character: i }, end: { line: 0, character: i + 1 } })) };
  w.setScenario({ capabilities: { callHierarchyProvider: true }, responses: { "textDocument/prepareCallHierarchy": [item(w.uri, "a")], "callHierarchy/outgoingCalls": [edge, edge] } });
  const result = await run(w.args("callees", "--limit", "2"));
  assert.equal(list(result.data.edges).length, 1); assert.equal((list(result.data.edges)[0].locations as unknown[]).length, 2);
  assert.equal(list(result.data.edges)[0].totalLocations, 20); assert.equal(result.data.truncated, true);
});
test("hierarchy: duplicate provider call-site positions are exposed once with their duplicate count", async () => {
  const w = workspace(); w.setScenario({ capabilities: { callHierarchyProvider: true }, responses: { "textDocument/prepareCallHierarchy": [item(w.uri, "a")], "callHierarchy/incomingCalls": [{ from: item(w.uri, "b"), fromRanges: [range, range] }] } });
  const result = await run(w.args("callers")), edge = list(result.data.edges)[0];
  assert.equal((edge.locations as unknown[]).length, 1); assert.equal(edge.totalLocations, 1); assert.equal(edge.duplicateLocations, 1);
});
for (const bad of [null, { name: "bad" }, { ...item("file:///x", "bad"), selectionRange: { start: { line: 0, character: 99 }, end: { line: 0, character: 100 } } }])
  test(`hierarchy: invalid seed ${JSON.stringify(bad)} fails explicitly`, async () => {
    const w = workspace({ capabilities: { callHierarchyProvider: true }, responses: { "textDocument/prepareCallHierarchy": [bad] } });
    await assert.rejects(run(w.args("callers")), /Invalid call hierarchy item/);
  });
test("hierarchy: malformed call ranges retain the prepared node without inventing edges", async () => {
  const w = workspace(); w.setScenario({ capabilities: { callHierarchyProvider: true }, responses: { "textDocument/prepareCallHierarchy": [item(w.uri, "a")], "callHierarchy/incomingCalls": [{ from: item(w.uri, "b"), fromRanges: [null] }] } });
  const result = await run(w.args("callers"));
  assert.equal(result.code, 1); assert.equal(result.data.total, 1); assert.deepEqual(result.data.edges, []);
});
for (const command of ["callers", "callees", "complete"]) test(`${command}: unsupported capabilities are distinct from an empty answer`, async () => {
  const w = workspace({ capabilities: {} }), result = await run(w.args(command));
  assert.equal(result.code, 1); assert.equal(result.data.supported, false); assert.equal(result.data.success, false);
  assert.equal(w.events().some(e => String(e.method).startsWith("callHierarchy/") || e.method === "textDocument/completion"), false);
});
test("completion: ranking, incomplete lists and resolve preserve opaque items without executing commands", async () => {
  const w = workspace(), candidate = { label: "open", sortText: "2", data: { key: "open", token: ["opaque"] }, command: { command: "danger.execute" }, textEdit: { range, newText: "corrupt" } };
  w.setScenario({ capabilities: { completionProvider: { resolveProvider: true } }, responses: { "textDocument/completion": { isIncomplete: true, items: [{ label: "reopen", sortText: "0" }, candidate, { label: "Open" }, { label: "other" }] } }, responsesByItem: { "completionItem/resolve": { open: { ...candidate, detail: "open(path: string)", documentation: { kind: "markdown", value: "Open a file" } }, Open: { label: "Open", detail: "class Open" }, reopen: { label: "reopen" } } } });
  const before = readFileSync(w.file), result = await run(w.args("complete", "--query", "open", "--resolve"));
  assert.equal(result.data.total, 3); assert.equal(result.data.incomplete, true); assert.deepEqual(list(result.data.items).map(i => i.label), ["open", "Open", "reopen"]);
  assert.equal(list(result.data.items)[0].documentation, "Open a file"); assert.equal(list(result.data.items)[0].textEdit, undefined);
  const request = w.events().find(e => e.method === "completionItem/resolve"); assert.deepEqual(request?.params, candidate);
  assert.equal(w.events().some(e => e.method === "workspace/executeCommand" || e.method === "textDocument/didChange"), false);
  assert.deepEqual(readFileSync(w.file), before);
});
test("completion: resolution failures preserve candidates and remaining successful documentation", async () => {
  const w = workspace({ capabilities: { completionProvider: { resolveProvider: true } }, responses: { "textDocument/completion": [{ label: "bad" }, { label: "good" }] }, errorsByItem: { "completionItem/resolve": { bad: { code: -32603, message: "resolve failed" } } }, responsesByItem: { "completionItem/resolve": { good: { label: "good", documentation: "available" } } } });
  const result = await run(w.args("complete", "--resolve"));
  assert.equal(result.code, 1); assert.equal(list(result.data.items).length, 2); assert.equal(list(result.data.items)[1].documentation, "available");
  assert.match(String(list(result.data.errors)[0].error), /resolve failed/);
});
test("completion: empty results distinguish cursor absence from a query filtering all candidates", async () => {
  const w = workspace({ capabilities: { completionProvider: {} }, responses: { "textDocument/completion": [{ label: "available" }] } });
  const filtered = await run(w.args("complete", "--column", "2", "--query", "missing"));
  assert.equal(filtered.data.found, false); assert.equal(filtered.data.providerCount, 1); assert.deepEqual(filtered.data.cursor, { line: 1, column: 2 }); assert.ok(String(filtered.data.hint).includes("--query"));
  w.setScenario({ capabilities: { completionProvider: {} }, responses: { "textDocument/completion": [] } });
  const empty = await run(w.args("complete", "--column", "2"));
  assert.equal(empty.data.providerCount, 0); assert.equal(empty.data.found, false); assert.ok(String(empty.data.hint).includes("1:2"));
});
for (const response of [{ items: [] }, { isIncomplete: true, items: [null] }, [{ label: 1 }], [{ label: "x", detail: {} }]])
  test(`completion: malformed response ${JSON.stringify(response)} is rejected`, async () => {
    const w = workspace({ capabilities: { completionProvider: {} }, responses: { "textDocument/completion": response } });
    await assert.rejects(run(w.args("complete")), /Invalid completion/);
  });
test("completion: preview budgets preserve Unicode and full mode retains provider edit metadata", async () => {
  const value = { label: "target", detail: "😀".repeat(5000), documentation: "doc".repeat(5000), data: { opaque: true }, textEdit: { range, newText: "x" } };
  const w = workspace({ capabilities: { completionProvider: {} }, responses: { "textDocument/completion": { isIncomplete: false, items: [value], itemDefaults: { insertTextMode: 1 } } } });
  const result = await run(w.args("complete")), preview = list(result.data.items)[0];
  assert.equal(result.data.textTruncated, true); assert.ok(String(preview.detail).isWellFormed());
  assert.ok([preview.label, preview.detail, preview.documentation].reduce((n: number, t) => n + String(t).length, 0) <= 6000);
  const full = await run(w.args("complete", "--limit", "0"));
  assert.deepEqual(list(full.data.items)[0], value); assert.deepEqual(full.data.itemDefaults, { insertTextMode: 1 });
});
test("completion: label details share the preview budget and resolution has a hard request ceiling", async () => {
  const items = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ label: `n${i}`, labelDetails: { detail: "detail".repeat(2000), description: "description".repeat(1000) } }));
  const w = workspace({ capabilities: { completionProvider: { resolveProvider: true } }, responses: { "textDocument/completion": items, "completionItem/resolve": { label: "different" } } });
  const preview = await run(w.args("complete", "--limit", "1"));
  assert.equal(preview.data.textTruncated, true); assert.ok(JSON.stringify(preview.data).length < 8000);
  const result = await run({ ...w.args("complete", "--limit", "0", "--resolve"), timeout: 3000 });
  assert.equal(object(result.data.resolution).attempted, MAX_FILES); assert.equal(object(result.data.resolution).limited, true);
  assert.equal(w.events().filter(e => e.method === "completionItem/resolve").length, MAX_FILES);
  assert.equal(list(result.data.items).length, MAX_FILES + 1);
});
test("new raw methods are read-only and position methods fill missing document/anchor context", async () => {
  const w = workspace();
  for (const method of ["textDocument/prepareCallHierarchy", "callHierarchy/incomingCalls", "callHierarchy/outgoingCalls", "textDocument/completion", "completionItem/resolve"]) {
    const result = await run(w.args("request", "--method", method, "--line", "1", "--column", "2"));
    assert.equal(result.data.applied, false);
    const event = w.events().findLast(e => e.method === method);
    if (method.startsWith("textDocument/")) assert.partialDeepStrictEqual(event?.params, { textDocument: { uri: w.uri }, position: { line: 0, character: 1 } });
  }
});
test("semantic queries: ContentModified retries and CLI depth/resolve validation stay bounded", async () => {
  const w = workspace({ capabilities: { completionProvider: {} }, contentModified: { "textDocument/completion": 1 }, responses: { "textDocument/completion": [{ label: "ok" }] } });
  assert.equal((await run(w.args("complete"))).data.found, true);
  assert.equal(w.events().filter(e => e.method === "textDocument/completion").length, 2);
  for (const depth of ["0", "11", "1.5", "NaN"]) assert.throws(() => parseOptions(["callers", "--depth", depth]), /depth/);
  assert.throws(() => parseOptions(["hover", "--resolve"]), /only available/);
});
