import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { spawnSync } from "node:child_process";
import { parseOptions } from "../src/cli.ts";
import { run, outputData } from "../src/commands.ts";
import { availableServers, loadConfig, object, type ObjectValue } from "../src/config.ts";
import { LspClient } from "../src/client.ts";
import { queryOptions } from "../src/batch.ts";
import { typeGraph } from "../src/tsp.ts";
import { stdioSession } from "../src/session.ts";
import { cleanWorkspaces, isolateGlobalConfig, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); }); after(() => restore());
afterEach(async () => { const active = LspClient.active.size; await Promise.all([...LspClient.active].map(client => client.close())); cleanWorkspaces(); assert.equal(active, 0); });
const computed = "typeServer/getComputedType", declared = "typeServer/getDeclaredType", expected = "typeServer/getExpectedType";
const version = "typeServer/getSupportedProtocolVersion", snapshot = "typeServer/getSnapshot";
const builtin = (id = 1, name = "any") => ({ id, kind: 0, flags: 0, name });
const responses = { [version]: "0.4.1", [snapshot]: 1, [computed]: builtin(), [declared]: builtin(2, "unknown"), [expected]: builtin(3, "never") };
const changed = (old: number, next: number) => ({ method: "typeServer/snapshotChanged", params: { old, new: next } });
function fixture(scenario: ObjectValue = {}) {
  const w = workspace({ responses, ...scenario }); w.configs.fixture.protocol = "tsp"; w.saveConfig();
  const source = readFileSync(w.file), stable = () => assert.deepEqual(readFileSync(w.file), source);
  return { ...w, stable, calls: (method: string) => w.events().filter(event => event.direction === "receive" && event.method === method) };
}

test("TSP: each view sends a source node with UTF-16 range, negotiated version and current snapshot", async () => {
  for (const [view, method] of [["computed", computed], ["declared", declared], ["expected", expected]]) {
    const w = fixture(), result = await run(w.args("types", "--line", "1", "--symbol", "value", "--view", view));
    assert.equal(result.data.success, true); assert.equal(result.data.protocolVersion, "0.4.1"); assert.equal(result.data.snapshot, 1); assert.equal(result.data.provider, "tsp");
    assert.deepEqual(object(w.calls(method)[0].params), { arg: { uri: w.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }, snapshot: 1 });
    assert.equal(w.calls(version)[0].params, undefined); assert.equal(w.calls(snapshot)[0].params, undefined);
    assert.equal(object(object(object(w.calls("initialize")[0].params).capabilities).workspace).applyEdit, false);
    assert.equal(w.calls("typeServer/connection").length, 0); w.stable();
  }
});

test("TSP: protocol filters isolate ordinary navigation, diagnostics and hook discovery", async () => {
  const w = fixture(); w.configs.ordinary = { ...w.configs.fixture, protocol: "lsp" }; w.saveConfig();
  assert.deepEqual(availableServers(loadConfig(w.root), w.root).map(server => server.name), ["ordinary"]);
  assert.deepEqual(availableServers(loadConfig(w.root), w.root, false, "tsp").map(server => server.name), ["fixture"]);
  const status = await run(w.args("status"));
  assert.deepEqual((status.data.servers as ObjectValue[]).map(server => server.protocol), ["tsp", "lsp"]);
  const doctor = await run(w.args("doctor")); assert.equal(doctor.data.success, true);
  assert.equal((doctor.data.servers as ObjectValue[]).find(row => row.name === "fixture")?.protocolVersion, "0.4.1");
  w.configs.fixture.protocol = "invalid" as "tsp"; w.saveConfig(); assert.throws(() => loadConfig(w.root), /protocol/);
});

test("TSP: missing provider gives install and official documentation guidance; setup persists dedicated tsp arguments", async () => {
  const w = workspace();
  await assert.rejects(run(w.args("types")), /uv tool install pyrefly.*setup pyrefly-tsp.*https:\/\/pyrefly.org/);
  w.configs["pyrefly-tsp"] = { command: process.execPath, disabled: true }; w.saveConfig();
  const result = await run(parseOptions(["setup", "pyrefly-tsp", "--project"], w.root)); assert.equal(result.data.success, true);
  const config = loadConfig(w.root)["pyrefly-tsp"];
  assert.deepEqual(config.args, ["tsp"]); assert.equal(config.protocol, "tsp"); assert.equal(config.disabled, false);
});

test("TSP: CLI and JSONL validate view, range and provider before starting a process", async () => {
  const w = fixture();
  for (const argv of [["hover", "--view", "expected"], ["types", "--view", "garbage"], ["types", "--range", "1:1-1:3", "--column", "1"]]) assert.throws(() => parseOptions(argv, w.root));
  for (const row of [{ command: "types", file: w.file, view: [] }, { command: "hover", file: w.file, view: "expected" }]) assert.throws(() => queryOptions(w.args("session"), row, true), /view/);
  const row = queryOptions(w.args("session"), { command: "types", file: w.file, range: "1:1-1:6", view: "expected", server: "fixture" }, true);
  const result = await run(row); assert.equal(result.data.summary, "Never");
  assert.deepEqual(object(object(w.calls(expected)[0].params).arg).range, { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } });
  await assert.rejects(run(w.args("types", "--apply")), /read-only/);
});

test("TSP: ast-grep declaration lookup and source-bound target IDs work without an explicit line", async () => {
  if (spawnSync("ast-grep", ["--version"]).status !== 0) return;
  const w = fixture(), file = join(w.root, "source.py"); writeFileSync(file, "# comment\n\ndef example(value: int) -> str:\n    return str(value)\n");
  w.configs.fixture.fileTypes = [".py"]; w.saveConfig();
  const result = await run({ ...w.args("types", "--symbol", "example", "--targets"), file });
  assert.equal(object(result.data.cursor).line, 3);
  assert.deepEqual(result.data.type, responses[computed]);
  const targets = result.data.targets as ObjectValue[]; assert(targets.length > 0);
  const next = await run(parseOptions(["types", "--target", String(targets[0].id)], w.root)); assert.equal(next.data.found, true);
});

test("TSP: batch negotiates once per session, refreshes snapshots per query and returns each independent type graph", async () => {
  const w = fixture(), input = join(w.root, "queries.jsonl");
  writeFileSync(input, ["computed", "declared", "expected"].map(view => JSON.stringify({ command: "types", file: w.file, view })).join("\n"));
  const result = await run({ ...parseOptions(["batch", "--input", input], w.root), timeout: 2000 });
  assert.equal(result.data.failed, 0); assert.deepEqual((result.data.results as ObjectValue[]).map(row => row.view), ["computed", "declared", "expected"]);
  assert.equal(w.calls(version).length, 1); assert.equal(w.calls(snapshot).length, 3); assert.equal(w.calls("initialize").length, 1); assert.equal(w.calls("shutdown").length, 1); w.stable();
});

test("TSP: stdio session synchronizes an external disk edit before querying a fresh snapshot", async () => {
  const w = fixture({ capabilities: { textDocumentSync: 2 }, diagnosticVersionFromDocument: true, responses,
    responsesByCall: { [snapshot]: [1, 2] }, responsesByText: { [computed]: { "value = 1\n": builtin(), "value = 2\n": builtin(4, "unknown") } } });
  const rows: ObjectValue[] = [];
  let release!: () => void; const first = new Promise<void>(resolve => { release = resolve; });
  const output = new Writable({ write(chunk, _encoding, callback) { rows.push(JSON.parse(String(chunk))); release(); callback(); } });
  const sequential = Readable.from((async function* () {
    yield JSON.stringify({ command: "types", file: w.file }) + "\n"; await first;
    writeFileSync(w.file, "value = 2\n");
    yield JSON.stringify({ command: "types", file: w.file }) + "\n";
    yield '{"command":"close"}\n';
  })(), { objectMode: false });
  const code = await stdioSession(parseOptions(["session", "--stdio"], w.root), sequential, output);
  assert.equal(code, 0); assert.deepEqual(rows.slice(0, 2).map(row => row.snapshot), [1, 2]);
  assert.deepEqual(rows.slice(0, 2).map(row => row.summary), ["Any", "Unknown"]);
  assert.equal(w.calls("textDocument/didChange").length, 1); assert.equal(w.calls(version).length, 1);
});

test("TSP: unsupported methods and incompatible versions never fall back to unrelated hover text", async () => {
  for (const value of ["0.3.0", "0.5.0", "1.4.0", "0.4.1-beta", null, 4]) {
    const w = fixture({ responses: { ...responses, [version]: value } }), result = await run(w.args("types"));
    assert.equal(result.data.supported, false); assert.equal(result.code, 1); assert.equal(w.calls(snapshot).length, 0); assert.equal(w.calls("textDocument/hover").length, 0);
  }
  const w = fixture({ errors: { [version]: { code: -32601, message: "Unknown method" } } }), result = await run(w.args("types"));
  assert.equal(result.data.supported, false); assert.match(result.human, /pyrefly tsp/);
  for (const value of ["0.4.0", "0.4.99+build.2"]) {
    const good = fixture({ responses: { ...responses, [version]: value } }); assert.equal((await run(good.args("types"))).data.protocolVersion, value);
  }
});

test("TSP: snapshot cancellation and ContentModified retry with a newly acquired snapshot", async () => {
  for (const code of [-32802, -32801]) {
    const w = fixture({ responses, responsesByCall: { [snapshot]: [1, 2] }, errorsByCall: { [computed]: [{ code, message: "stale" }] } });
    const result = await run(w.args("types")); assert.equal(result.data.snapshot, 2); assert.equal(result.data.retries, 1);
    assert.deepEqual(w.calls(computed).map(row => object(row.params).snapshot), [1, 2]); w.stable();
  }
});

test("TSP: a provider missing one view returns unsupported state without substituting another query", async () => {
  const w = fixture({ responses, errors: { [expected]: { code: -32601, message: "unsupported" } } });
  const result = await run(w.args("types", "--view", "expected"));
  assert.equal(result.data.supported, false); assert.equal(result.data.view, "expected"); assert.equal(result.code, 1); assert.match(result.human, /getExpectedType/);
  assert.equal(w.calls(computed).length, 0); assert.equal(w.calls("textDocument/hover").length, 0);
});

test("TSP: session-local snapshot IDs cannot decrease and a transient handshake error can be retried", async () => {
  const w = fixture({ responses, responsesByCall: { [snapshot]: [2, 1] } }), pool = { clients: new Map<string, LspClient>(), diagnostics: false };
  try {
    await run(w.args("types"), pool); await assert.rejects(run(w.args("types"), pool), /snapshot regressed/);
  } finally { await Promise.all([...pool.clients.values()].map(client => client.close())); }
  const retry = fixture({ responses, errorsByCall: { [version]: [{ code: -32603, message: "warming up" }] } }), session = { clients: new Map<string, LspClient>(), diagnostics: false };
  try {
    await assert.rejects(run(retry.args("types"), session), /warming up/);
    assert.equal((await run(retry.args("types"), session)).data.found, true); assert.equal(retry.calls(version).length, 2); assert.equal(retry.calls("initialize").length, 1);
  } finally { await Promise.all([...session.clients.values()].map(client => client.close())); }
});

test("TSP: snapshotChanged during a response discards that graph and retries without reusing IDs", async () => {
  const w = fixture({ responses, responsesByCall: { [snapshot]: [1, 2], [computed]: [builtin(10, "unknown"), builtin(11)] }, notificationsByCall: { [computed]: [[changed(1, 2)]] } });
  const result = await run(w.args("types")); assert.equal(result.data.snapshot, 2); assert.equal(object(result.data.type).id, 11); assert.equal(result.data.retries, 1);
});

test("TSP: a snapshot notification racing with getSnapshot is recovered; actual regression and malformed IDs fail", async () => {
  const w = fixture({ responses, responsesByCall: { [snapshot]: [1, 2] }, notificationsByCall: { [snapshot]: [[changed(0, 2)]] } });
  assert.equal((await run(w.args("types"))).data.snapshot, 2); assert.equal(w.calls(computed).length, 1);
  for (const value of [-1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    const bad = fixture({ responses: { ...responses, [snapshot]: value } }); await assert.rejects(run(bad.args("types")), /snapshot identifier/);
  }
});

test("TSP: persistent cancellation is bounded and malformed or decreasing notifications fail closed", async () => {
  const w = fixture({ responses, errors: { [computed]: { code: -32802, message: "busy" } } });
  await assert.rejects(run(w.args("types")), /3 attempts/); assert.equal(w.calls(computed).length, 3); assert.equal(w.calls(snapshot).length, 3);
  for (const notification of [changed(2, 1), changed(1, -1), changed(1, NaN), { method: "typeServer/snapshotChanged", params: {} }]) {
    const bad = fixture({ responses, notificationsByCall: { [computed]: [[notification]] } }); await assert.rejects(run(bad.args("types")), /snapshotChanged/);
  }
});

test("TSP: timeouts cancel the request and changing source cannot return an accepted type", async () => {
  const w = fixture({ responses, stallMethods: [computed] });
  await assert.rejects(run({ ...w.args("types"), timeout: 120 }), /timed out/i); assert.equal(w.calls("$/cancelRequest").length, 1); w.stable();
  const changed = fixture(); changed.setScenario({ responses, beforeResponse: { [computed]: { file: changed.file, text: "changed = 2\n" } } });
  await assert.rejects(run(changed.args("types")), /Source changed/);
});

test("TSP: absent type remains a successful empty response, with its actual view and cursor", async () => {
  const w = fixture({ responses: { ...responses, [expected]: null } }), result = await run(w.args("types", "--view", "expected"));
  assert.equal(result.data.success, true); assert.equal(result.data.found, false); assert.equal(result.data.type, null); assert.match(result.human, /No expected type/);
});

test("TSP: read-only raw methods are allowed; connection control still requires explicit apply", async () => {
  const w = fixture(), raw = await run(w.args("request", "--method", version)); assert.equal(raw.data.result, "0.4.1");
  assert.equal(w.calls(version)[0].params, undefined);
  await assert.rejects(run(w.args("request", "--method", "typeServer/connection", "--payload", '{"type":"open","kind":"ipc"}')), /require --apply/);
  assert.equal(w.calls("typeServer/connection").length, 0); w.stable();
});

test("TSP type graphs: validate all variants, aliases, forward references and recursion without following external paths", () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
  const declaration = { kind: 0, category: 6, name: "Node", node: { uri: "file:///unreadable.py", range } };
  const ref = { id: 99, kind: 9, flags: 0, typeReferenceId: 4 };
  const graph = { id: 4, kind: 4, flags: 0, subTypes: [ref, { id: 2, kind: 3, flags: 2, declaration, typeArgs: [builtin()], literalValue: null }] };
  assert.equal(typeGraph(graph).summary, "#4 | Node[Any]");
  for (const type of [
    { id: 1, kind: 1, flags: 0, declaration }, { id: 1, kind: 6, flags: 0, declaration },
    { id: 1, kind: 2, flags: 0, declaration, returnType: builtin(2), specializedTypes: { parameterTypes: [builtin(3)], parameterDefaultTypes: [null], returnType: builtin(5) } },
    { id: 1, kind: 7, flags: 0, overloads: [builtin(2)], implementation: builtin(3) },
    { id: 1, kind: 8, flags: 0, stubContent: "class A: ...", metadata: { primaryDefinitionOffset: 0, module: { id: 2, kind: 5, flags: 0, moduleName: "app", uri: "file:///app.py" } } },
    { id: 1, kind: 10, flags: 0, candidates: [builtin(2)], baselineType: builtin(3), uncertaintyKind: "any" },
    { id: 1, kind: 3, flags: 0, declaration, literalValue: { className: "Node", itemName: "A", itemType: builtin(2) } },
    { id: 1, kind: 3, flags: 0, declaration, literalValue: { className: "Node", moduleName: "app", classNode: { uri: "file:///app.py", range } } },
    { ...builtin(), typeAliasInfo: { name: "A", fullName: "app.A", moduleName: "app", scopeId: "scope", fileUri: "file:///app.py", isTypeAliasType: true, typeParams: [builtin(2)], typeArgs: [builtin(3)], computedVariance: [1] } },
  ]) assert.equal(typeGraph(type).type, type);
  const dangling = { ...graph, subTypes: [ref] }; assert.equal(typeGraph(dangling).type, dangling);
  assert.throws(() => typeGraph(ref), /Invalid TSP/);
});

test("TSP type graphs: malformed nested types, declarations, offsets, aliases and limits are rejected", () => {
  const invalid: unknown[] = [null, [], {}, builtin(-1), { ...builtin(), kind: 11 }, { ...builtin(), flags: -1 }, { ...builtin(), name: "made-up" },
    { id: 1, kind: 4, flags: 0, subTypes: [builtin(2), builtin(2, "unknown")] },
    { id: 1, kind: 3, flags: 0, declaration: { kind: 0, category: 6, name: "X", node: { uri: "bad", range: {} } } },
    { id: 1, kind: 8, flags: 0, stubContent: "x", metadata: { primaryDefinitionOffset: 20, module: builtin(2) } },
    { ...builtin(), typeAliasInfo: { name: "X" } }, { id: 1, kind: 7, flags: 0, overloads: null },
  ];
  let deep: unknown = builtin(); for (let i = 2; i < 70; i++) deep = { id: i, kind: 4, flags: 0, subTypes: [deep] }; invalid.push(deep);
  invalid.push({ id: 0, kind: 4, flags: 0, subTypes: Array.from({ length: 2001 }, (_, i) => builtin(i + 1)) });
  for (const graph of invalid) assert.throws(() => typeGraph(graph), /Invalid TSP/);
});

test("TSP output: a bounded response omits its whole graph, retains snapshot/view and never exposes dangling handles", async () => {
  const graph = { id: 0, kind: 4, flags: 0, subTypes: Array.from({ length: 50 }, (_, i) => builtin(i + 1)) };
  const w = fixture({ responses: { ...responses, [computed]: graph } }), result = await run(w.args("types"));
  const output = outputData(result.data, { budget: 1000 });
  assert(JSON.stringify(output).length <= 1000); assert.equal(output.type, undefined); assert.equal(output.typeOmitted, true); assert.equal(output.snapshot, 1);
  assert.equal(output.view, "computed"); assert.equal(output.truncated, true); assert.equal(object(output.budget).clipped, true);
  const full = outputData(result.data, { budget: 16000 }); assert.deepEqual(full.type, graph);
  const selected = outputData(result.data, { fields: ["summary"] }); assert.equal(selected.summary, result.data.summary); assert.equal(selected.protocolVersion, "0.4.1"); assert.equal(selected.view, "computed");
  assert.deepEqual(result.data.type, graph); w.stable();
});

test("TSP Pyrefly regression: generated Callable allows an empty source URI and repeated identical return definitions", async () => {
  const callable = { id: 2, kind: 2, flags: 4, declaration: { kind: 1, uri: "" }, returnType: builtin(), specializedTypes: null };
  assert.equal(typeGraph(callable).summary, "Callable[..., Any]");
  const w = fixture({ responses: { ...responses, [computed]: callable } });
  assert.equal((await run(w.args("types"))).data.summary, "Callable[..., Any]"); w.stable();
  const repeated = { ...callable, specializedTypes: { parameterTypes: [builtin(3, "unknown")], parameterDefaultTypes: null, returnType: { name: "any", flags: 0, kind: 0, id: 1 } } };
  assert.equal(typeGraph(repeated).summary, "Callable[[Unknown], Any]");
  assert.throws(() => typeGraph({ ...repeated, returnType: builtin(1, "never") }), /conflicting definitions/);
});

test("TSP Pyrefly regression: absent enum literal values stay explicit; supplied enum names retain member identity", () => {
  const declaration = { kind: 1, uri: "" };
  const type = { id: 1, kind: 3, flags: 8, declaration, literalValue: null };
  const named = { ...type, declaration: { kind: 0, category: 6, name: "Status", node: { uri: "file:///app.py", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } } } };
  const graph = { id: 4, kind: 4, flags: 0, subTypes: [named, { ...named, id: 2 }, { ...named, id: 3 }] };
  assert.equal(typeGraph(graph).summary, "Status (literal value unavailable) (3 variants)");
  assert.equal(typeGraph({ ...named, literalValue: { className: "Status", itemName: "READY", itemType: builtin(2) } }).summary, "Status.READY");
});
