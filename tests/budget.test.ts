import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetData } from "../src/budget.ts";
import { selectFields } from "../src/output.ts";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown) => value as ObjectValue;
const path = "/project/src/中文.ts";
const range = { start: { line: 1, column: 1 }, end: { line: 10, column: 2 } };
function inspect() {
  const source = "function parse(value: string) {\n" + "  return value; // 😀中文\n".repeat(500) + "}";
  return { success: false, applied: false, failedSections: ["diagnostics"], results: {
    hover: { success: true, found: true, total: 502, shown: 502, truncated: false, hover: source },
    definition: { success: true, found: true, total: 2, shown: 2, truncated: false, locations: [{ file: path, line: 1, column: 1 }, { file: "/project/second.ts", line: 2, column: 3 }] },
    references: { success: true, found: true, total: 40, shown: 40, truncated: false, locations: Array.from({ length: 40 }, (_, line) => ({ file: path, line: line + 1, column: 3 })) },
    diagnostics: { success: false, verified: true, hasErrors: true, total: 2, shown: 2, truncated: false, counts: { errors: 1, warnings: 1, information: 0, hints: 0 }, checked: [
      { file: path, verified: true, diagnosticCount: 2, errors: [], diagnostics: [{ range, severity: 1, message: "type mismatch " + "原因😀".repeat(1000) }, { range, severity: 2, message: "warning " + "x".repeat(1000) }] },
    ] },
    context: { success: true, total: 3, shown: 3, omittedLocations: 0, truncated: false, snippets: Array.from({ length: 3 }, (_, index) => ({ file: path, range, roles: [index ? "definition" : "source"], snippet: source, characters: { total: source.length, shown: source.length } })), errors: [] },
  } };
}
const fits = (data: ObjectValue, maximum: number) => {
  const json = JSON.stringify(data); assert.ok(json.length <= maximum, `${json.length} > ${maximum}`);
  assert.equal(object(data.budget).characters, json.length);
};

test("budget: one 3000-character envelope retains states and counts across all inspect sections", () => {
  const data = inspect(), original = structuredClone(data), result = budgetData(data, 3000);
  fits(result, 3000); assert.deepEqual(data, original);
  assert.equal(result.success, false); assert.equal(result.applied, false); assert.deepEqual(result.failedSections, ["diagnostics"]);
  const sections = object(result.results), diagnostic = object(sections.diagnostics), context = object(sections.context);
  assert.equal(diagnostic.verified, true); assert.equal(diagnostic.hasErrors, true); assert.deepEqual(diagnostic.counts, data.results.diagnostics.counts);
  assert.equal(diagnostic.total, 2); assert.equal(context.total, 3); assert.equal(object(sections.references).total, 40);
  assert.equal(diagnostic.shown, (diagnostic.checked as ObjectValue[]).reduce((n, row) => n + (row.diagnostics as unknown[]).length, 0));
  assert.equal(context.shown, (context.snippets as unknown[]).length); assert.equal(result.truncated, true);
  assert.ok(Number(object(result.budget).omittedItems) > 0);
  const locations = object(sections.definition).locations as ObjectValue[]; assert.ok(locations.length); assert.equal(locations[0].file, path);
  for (const snippet of context.snippets as ObjectValue[]) { assert.equal(snippet.file, path); assert.deepEqual(snippet.range, range); assert.equal(object(snippet.characters).shown, String(snippet.snippet).length); }
});

test("budget: compact 512-character output preserves selected ancestor verification and whole ranges", () => {
  const selected = selectFields(inspect(), ["results.diagnostics.counts", "results.context.snippets"]);
  const data = budgetData(selected, 512); fits(data, 512);
  const diagnostic = object(object(data.results).diagnostics);
  assert.equal(diagnostic.verified, true); assert.equal(diagnostic.hasErrors, true);
  assert.deepEqual(diagnostic.counts, { errors: 1, warnings: 1, information: 0, hints: 0 });
  assert.deepEqual(data.failedSections, ["diagnostics"]);
});

test("budget: clipped inspect includes copyable field selectors that recover focused source within the same budget", () => {
  const data = inspect(), result = budgetData(data, 3000);
  const hint = String(object(result.budget).hint);
  assert.match(hint, /--fields results\.context\.snippets/);
  assert.match(hint, /results\.hover/);
  const fields = /--fields (\S+)/.exec(hint)![1];
  const focused = budgetData(selectFields(data, [fields]), 3000); fits(focused, 3000);
  assert.deepEqual(focused.failedSections, ["diagnostics"]);
  const snippets = object(object(focused.results).context).snippets as ObjectValue[];
  assert.match(String(snippets[0].snippet), /function parse/);
  assert.equal(object(object(result.results).diagnostics).hasErrors, true);
});

test("budget: Unicode text is clipped at scalar boundaries and JSON escaping counts toward the budget", () => {
  const data = { success: true, applied: false, results: { hover: { success: true, found: true, total: 1, shown: 1, hover: "😀中文\\\"\n".repeat(3000), truncated: false } } };
  const result = budgetData(data, 512); fits(result, 512);
  const hover = object(object(result.results).hover), text = String(hover.hover);
  assert.ok(text.length > 0); assert.equal(Buffer.from(text).toString("utf8"), text); assert.equal(hover.textTruncated, true);
});

test("budget: failures keep all error entries and a bounded cause with recovery guidance", () => {
  const data = { success: false, applied: false, failedSections: ["context"], results: { context: { success: false, total: 0, shown: 0, snippets: [], errors: [{ file: path, error: "Source changed " + "large failure detail ".repeat(10000) }] } } };
  const result = budgetData(data, 512); fits(result, 512);
  const error = (object(object(result.results).context).errors as ObjectValue[])[0];
  assert.equal(error.file, path); assert.match(String(error.error), /^Source changed/); assert.equal(error.errorTruncated, true); assert.match(String(object(result.budget).hint), /increase/);
  assert.throws(() => budgetData({ ...data, failedSections: Array(100).fill("context") }, 512), /cannot retain required output state.*increase --budget/);
});

test("budget: several failures retain each cause, verification and existing omission flags", () => {
  const data = { success: false, applied: false, failedSections: ["context", "diagnostics"], results: {
    context: { success: false, detailsOmitted: true, errors: Array.from({ length: 3 }, (_, index) => ({ file: path, error: `Failure ${index}: ` + "😀".repeat(3000) })) },
    diagnostics: { success: false, verified: false, hasErrors: true, counts: { errors: 4 }, checked: [{ file: path, verified: false, diagnosticCount: 4, diagnostics: [], errors: ["Analysis not complete " + "long reason ".repeat(3000)] }] },
  } };
  const result = budgetData(data, 1500); fits(result, 1500);
  const sections = object(result.results), context = object(sections.context), diagnostic = object(sections.diagnostics);
  const errors = context.errors as ObjectValue[]; assert.equal(errors.length, 3); assert.equal(context.detailsOmitted, true);
  for (const [index, error] of errors.entries()) { assert.match(String(error.error), new RegExp(`^Failure ${index}:`)); assert.equal(error.errorTruncated, true); assert.equal(error.file, path); }
  assert.equal(diagnostic.verified, false); assert.equal(diagnostic.hasErrors, true); assert.deepEqual(diagnostic.counts, { errors: 4 });
  assert.equal(((diagnostic.checked as ObjectValue[])[0].errors as unknown[]).length, 1);
});

test("budget: clipped rename previews omit the complete workspace edit, retaining write state and totals", () => {
  const data = { success: true, applied: false, results: { rename: { success: true, applied: false, verification: "pending", total: 1, shown: 1, workspaceEdit: { changes: { [path]: [{ range, newText: "x".repeat(5000) }] } }, edits: [path + ":1:1 → rename"] } } };
  const result = budgetData(data, 512); fits(result, 512);
  const rename = object(object(result.results).rename);
  assert.equal(rename.workspaceEdit, undefined); assert.equal(rename.workspaceEditOmitted, true); assert.equal(rename.applied, false); assert.equal(rename.verification, "pending"); assert.equal(rename.total, 1);
  assert.equal(data.results.rename.workspaceEdit.changes[path][0].newText.length, 5000);
});

test("budget: already-small output remains complete and invalid limits fail explicitly", () => {
  const data = { success: true, applied: false, results: { definition: { success: true, found: true, total: 1, shown: 1, truncated: false, locations: [{ file: path, line: 1, column: 2 }] } } };
  const result = budgetData(data, 512); fits(result, 512); assert.deepEqual(result.results, data.results); assert.equal(object(result.budget).clipped, false);
  for (const maximum of [0, 511, 512.5, Infinity, NaN]) assert.throws(() => budgetData(data, maximum), /at least 512/);
});

test("budget: generic clipping hints yield to source while empty-result recovery remains available", () => {
  const result = budgetData({ success: true, applied: false, results: {
    hover: { success: true, found: true, hover: "source ".repeat(300), hint: "Showing a clipped preview; use --limit 0. ".repeat(100) },
    symbols: { success: true, total: 0, symbols: [], hint: "Use symbols --workspace to search the project." },
  } }, 700);
  fits(result, 700);
  assert.equal(object(object(result.results).hover).hint, undefined);
  assert.match(String(object(object(result.results).symbols).hint), /symbols --workspace/);
  assert.ok(String(object(object(result.results).hover).hover).length > 100);
});

test("budget: every successful envelope fits its requested size without changing atomic paths or input", () => {
  const data = inspect(), original = JSON.stringify(data);
  for (const maximum of [512, 768, 1024, 1500, 2048, 3000, 6000, 14000]) {
    try {
      const result = budgetData(data, maximum); fits(result, maximum);
      const json = JSON.stringify(result); assert.equal(Buffer.from(json).toString("utf8"), json);
      for (const location of object(object(result.results).definition).locations as ObjectValue[]) assert.ok(data.results.definition.locations.some(row => row.file === location.file && row.line === location.line && row.column === location.column));
    } catch (error) { assert.match(String(error), /cannot retain required output state.*increase --budget/); }
    assert.equal(JSON.stringify(data), original);
  }
});

test("budget: graph sampling retains valid endpoints, roots and exact shown counts", () => {
  const data = { success: true, total: 100, shown: 100, totalEdges: 99, shownEdges: 99, roots: ["0"], nodes: Array.from({ length: 100 }, (_, id) => ({ id: String(id), file: path, line: id + 1, column: 1, name: `function${id}` })), edges: Array.from({ length: 99 }, (_, id) => ({ from: "0", to: String(id + 1), totalLocations: 1, locations: [{ line: 2, column: 3 }] })) };
  const result = budgetData(data, 3000); fits(result, 3000);
  const nodes = result.nodes as ObjectValue[], edges = result.edges as ObjectValue[], ids = new Set(nodes.map(node => node.id));
  assert.equal(result.total, 100); assert.equal(result.totalEdges, 99); assert.equal(result.shown, nodes.length); assert.equal(result.shownEdges, edges.length);
  for (const edge of edges) { assert.ok(ids.has(edge.from)); assert.ok(ids.has(edge.to)); }
  for (const root of result.roots as string[]) assert.ok(ids.has(root));
  assert.ok(nodes.length > 0); assert.ok(edges.length > 0); assert.equal(result.truncated, true);
  assert.equal(data.nodes.length, 100); assert.equal(data.edges.length, 99);
});

test("budget: completions trim labels and markup while preserving item counts and read-only payload omissions", () => {
  const data = { success: true, total: 100, shown: 100, incomplete: false, items: Array.from({ length: 100 }, (_, index) => ({ label: `item${index} ` + "😀".repeat(1000), documentation: { kind: "markdown", value: "docs ".repeat(2000) }, additionalTextEdits: [{ range, newText: "x".repeat(3000) }], data: { opaque: "opaque ".repeat(1000) } })) };
  const result = budgetData(data, 2000); fits(result, 2000);
  const items = result.items as ObjectValue[]; assert.equal(result.total, 100); assert.equal(result.shown, items.length); assert.ok(items.length);
  for (const item of items) { assert.equal(item.additionalTextEdits, undefined); assert.equal(item.data, undefined); assert.equal(item.detailsOmitted, true); assert.ok(String(item.label).isWellFormed()); }
});

test("budget: watch sampling preserves diagnostic counts and exposes file-list omissions", () => {
  const data = { success: true, verified: true, event: "diagnostics", sequence: 4, total: 100, counts: { errors: 100 }, checkedFiles: 100, files: Array.from({ length: 100 }, (_, index) => ({ file: `${path}${index}`, sha256: "a".repeat(64), versions: [2], verified: true, errors: [] })), changes: { counts: { new: 100, resolved: 0, existing: 0, updated: 0 }, new: { total: 100, shown: 100, diagnostics: Array.from({ length: 100 }, (_, index) => ({ id: String(index), file: path, line: index + 1, column: 1, message: "large message ".repeat(100) })) } } };
  const result = budgetData(data, 1800); fits(result, 1800);
  assert.equal(result.event, "diagnostics"); assert.equal(result.sequence, 4); assert.equal(result.checkedFiles, 100); assert.deepEqual(result.counts, { errors: 100 });
  assert.equal(result.filesTotal, 100); assert.equal(result.filesShown, (result.files as unknown[]).length);
  const fresh = object(object(result.changes).new); assert.equal(fresh.total, 100); assert.equal(fresh.shown, (fresh.diagnostics as unknown[]).length);
});

test("budget: plan handles and application verification survive field selection and diff clipping", () => {
  const selected = selectFields({ success: true, applied: true, applicationState: "applied", verification: "pending", diagnosticVerification: "verified", plan: "/private/reviewed plan.json", saved: true, compatibility: "unverified", evidence: "syntax", surfaceComplete: true, callsComplete: false, diff: "large diff\n".repeat(10000) }, ["diff"]);
  const result = budgetData(selected, 700); fits(result, 700);
  assert.equal(result.plan, "/private/reviewed plan.json"); assert.equal(result.saved, true); assert.equal(result.applicationState, "applied");
  assert.equal(result.diagnosticVerification, "verified"); assert.equal(result.verification, "pending"); assert.equal(result.compatibility, "unverified"); assert.equal(result.evidence, "syntax"); assert.equal(result.surfaceComplete, true); assert.equal(result.callsComplete, false);
});

test("budget: dependency graphs spend space on connected evidence and update shownNodes", () => {
  const data = { success: true, file: path, totalNodes: 154, shownNodes: 154, totalEdges: 153, shownEdges: 153,
    nodes: Array.from({ length: 154 }, (_, index) => ({ id: String(index), file: index ? `${path}/module${index}.py` : path, status: "internal" })),
    edges: Array.from({ length: 153 }, (_, index) => ({ from: "0", to: String(index + 1), kind: "import", specifier: `package.module${index}`, line: index + 1, column: 1, status: "internal" })) };
  const result = budgetData(data, 5000); fits(result, 5000);
  const nodes = result.nodes as ObjectValue[], edges = result.edges as ObjectValue[];
  assert.equal(result.shownNodes, nodes.length); assert.equal(result.shownEdges, edges.length); assert.ok(edges.length >= 5, `Only ${edges.length} connected edges retained`);
  assert.ok(nodes.length <= edges.length * 2 + 1); assert.equal(result.totalEdges, 153);
});
