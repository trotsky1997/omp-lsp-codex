import assert from "node:assert/strict";
import { after, afterEach, before, mock, test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { main, parseOptions } from "../src/cli.ts";
import { LspClient } from "../src/client.ts";
import { object } from "../src/config.ts";
import { selectFields } from "../src/output.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
const output: string[] = [], log = mock.method(console, "log", (value: unknown) => output.push(String(value))), error = mock.method(console, "error", (value: unknown) => output.push(String(value)));
before(() => { restore = isolateGlobalConfig(); });
after(() => { log.mock.restore(); error.mock.restore(); restore(); });
afterEach(async () => {
  const leaked = LspClient.active.size;
  await Promise.all([...LspClient.active].map(client => client.close()));
  cleanWorkspaces(); output.length = 0; assert.strictEqual(leaked, 0);
});
const decoded = () => JSON.parse(output.pop()!);

test("fields: parses object paths and rejects invalid selectors before execution", async () => {
  assert.partialDeepStrictEqual(parseOptions(["status", "--json", "--fields", " success, results.definition.locations,success "]), { fields: ["success", "results.definition.locations"] });
  const w = workspace(), start = mock.method(LspClient, "start");
  try {
    for (const flags of [["--fields", "success"], ["--json", "--fields", ""], ["--json", "--fields", "a,,b"], ["--json", "--fields", "a..b"], ["--json", "--fields", "locations.0.file"], ["--json", "--fields", "*"]]) {
      assert.strictEqual(await main(["rename", "--file", w.file, "--new-name", "renamed", "--apply", ...flags]), 2);
      assert.ok(output.pop()!.includes("--fields"));
    }
    assert.strictEqual(await main(["hook", "stop", "--json", "--fields", "continue"]), 2); assert.ok(decoded().error.includes("hook"));
    assert.strictEqual(start.mock.callCount(), 0); assert.strictEqual(readFileSync(w.file, "utf8"), "value = 1\n");
  } finally { start.mock.restore(); }
});
test("fields: references keep completion metadata while omitting unrequested locations", async () => {
  const w = workspace(); w.setScenario({ responses: { "textDocument/references": [{ uri: w.uri, range }, { uri: w.uri, range }] } });
  const flags = ["references", "--file", w.file, "--limit", "1", "--json"];
  assert.strictEqual(await main(flags), 0); const full = decoded();
  assert.strictEqual(await main([...flags, "--fields", "total,shown"]), 0); const selected = decoded();
  assert.deepStrictEqual(selected, { total: 2, shown: 1, success: true, found: true, truncated: true, hint: full.hint });
  assert.strictEqual(w.events().filter(event => event.method === "textDocument/references").length, 2);
});
test("fields: nested inspect selection retains diagnostic status and failure exit code", async () => {
  const w = workspace({ diagnostics: [{ range, severity: 1, message: "existing error" }] });
  assert.strictEqual(await main(["inspect", "--file", w.file, "--json", "--fields", "results.diagnostics.counts"]), 1);
  const data = decoded(), diagnostics = object(object(data.results).diagnostics);
  assert.strictEqual(data.success, false); assert.strictEqual(data.applied, false); assert.deepStrictEqual(data.failedSections, ["diagnostics"]);
  assert.partialDeepStrictEqual(diagnostics, { success: false, verified: true, hasErrors: true, truncated: false, counts: { errors: 1, warnings: 0, information: 0, hints: 0 } });
  assert.strictEqual(diagnostics.checked, undefined); assert.strictEqual(object(data.results).hover, undefined);
});
test("fields: absent paths after apply do not hide writes or reduce the edit set", async () => {
  const w = workspace(), text = "value = 1\n".repeat(3); writeFileSync(w.file, text);
  w.setScenario({ responses: { "textDocument/rename": { changes: { [w.uri]: [0, 1, 2].map(line => ({ range: { start: { line, character: 0 }, end: { line, character: 5 } }, newText: "renamed" })) } } } });
  assert.strictEqual(await main(["rename", "--file", w.file, "--new-name", "renamed", "--apply", "--limit", "1", "--json", "--fields", "total,absent"]), 0);
  const data = decoded(); assert.partialDeepStrictEqual(data, { success: true, applied: true, verification: "pending", total: 3, truncated: true, missingFields: ["absent"] });
  assert.strictEqual(readFileSync(w.file, "utf8"), text.replaceAll("value", "renamed")); assert.ok(data.hint.includes("verification pending"));
});
test("fields: command errors stay complete and keep exit two", async () => {
  assert.strictEqual(await main(["unknown", "--json", "--fields", "total"]), 2);
  const data = decoded(); assert.strictEqual(data.success, false); assert.match(data.error, /Unknown command/); assert.strictEqual(data.missingFields, undefined);
});
test("fields: overlapping paths retain whole arrays without mutating frozen source data", () => {
  const locations = Object.freeze([{ file: "/source.ts", line: 3 }]);
  const hover = Object.freeze({ success: true, found: true, provider: "devdocs", hover: "reference", truncated: false });
  const section = Object.freeze({ success: true, locations, nullable: null, hover, absent: undefined });
  const data = Object.freeze({ success: true, results: Object.freeze({ section }), extra: "omitted" });
  const result = JSON.parse(JSON.stringify(selectFields(data, ["results.section.locations", "results.section", "results.section.hover.hover", "results.section.absent", "results.section.nullable", "results.section.locations.length", "results.section.nullable.value"])));
  assert.deepStrictEqual(result, { success: true, results: { section: { success: true, locations, nullable: null, hover } }, missingFields: ["results.section.absent", "results.section.locations.length", "results.section.nullable.value"] });
  assert.strictEqual(section.absent, undefined); assert.strictEqual(data.extra, "omitted");
  const filtered = JSON.parse(JSON.stringify(selectFields(data, ["results.section.hover.hover"])));
  assert.strictEqual(filtered.results.section.hover.provider, "devdocs"); assert.strictEqual(filtered.results.section.locations, undefined);
  const unsupported = selectFields({ success: true, results: { definition: { success: true, supported: false, hint: "not advertised" } } }, ["results.definition.locations"]);
  assert.strictEqual(object(object(unsupported.results).definition).supported, false);
});
test("fields: only own properties are read and prototype-shaped keys cannot pollute objects", () => {
  const data = JSON.parse('{"success":true,"result":{"__proto__":{"polluted":"value"},"constructor":{"prototype":{"value":1}}}}');
  Object.setPrototypeOf(data, { inherited: "private" });
  const result = JSON.parse(JSON.stringify(selectFields(data, ["result.__proto__.polluted", "result.constructor.prototype.value", "inherited"])));
  assert.deepStrictEqual(result, { success: true, result: JSON.parse('{"__proto__":{"polluted":"value"},"constructor":{"prototype":{"value":1}}}'), missingFields: ["inherited"] });
  assert.strictEqual(object(Object.prototype).polluted, undefined); assert.strictEqual(object(Object.prototype).value, undefined);
});
