import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/commands.ts";
import { parseOptions } from "../src/cli.ts";
import { LspClient } from "../src/client.ts";
import { fileUri, object, type ObjectValue } from "../src/config.ts";
import { cleanWorkspaces, isolateGlobalConfig, range, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); }); after(() => restore());
afterEach(async () => { const leaked = LspClient.active.size; await Promise.all([...LspClient.active].map(c => c.close())); cleanWorkspaces(); assert.equal(leaked, 0); });
const source = "function changed() {\n  return 1;\n}\n";
const symbol = { name: "changed", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } }, selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 16 } } };
const caps = { documentSymbolProvider: true, referencesProvider: true };
const list = (v: unknown) => v as ObjectValue[];
function git(root: string, ...args: string[]) { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }); }
function project(scenario?: (w: ReturnType<typeof workspace>) => ObjectValue, initial = source, configure?: (w: ReturnType<typeof workspace>) => void) {
  const w = workspace(); writeFileSync(w.file, initial); writeFileSync(join(w.root, ".gitignore"), "wire.ndjson\n");
  w.setScenario(scenario?.(w) ?? { capabilities: caps, responses: { "textDocument/documentSymbol": [symbol], "textDocument/references": [] } });
  configure?.(w);
  git(w.root, "init", "--quiet"); git(w.root, "add", ".");
  git(w.root, "-c", "user.name=codex-lsp-fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + join(w.root, ".git/disabled-hooks"), "commit", "--quiet", "-m", "fixture");
  return { ...w, impact: () => ({ ...parseOptions(["impact", "--changed", "--json"], w.root), timeout: 1200 }) };
}
test("impact: changed body finds its declaration, referencing test and filename candidate with evidence", async () => {
  const w = project(w => {
    const test = join(w.root, "test_source.fixture"), convention = join(w.root, "source.test.fixture"); writeFileSync(test, "changed();\n"); writeFileSync(convention, "related test\n");
    return { capabilities: caps, responses: { "textDocument/documentSymbol": [symbol], "textDocument/references": [{ uri: fileUri(test), range }] } };
  });
  const changed = source.replace("return 1", "return 2"); writeFileSync(w.file, changed);
  git(w.root, "config", "color.ui", "always");
  const result = await run(w.impact());
  assert.equal(result.code, 0); assert.equal(result.data.verified, true);
  assert.deepEqual(list(result.data.changedSymbols).map(s => s.name), ["changed"]);
  assert.equal(object(result.data.counts).candidateTests, 2);
  const tests = list(result.data.candidateTests);
  assert.equal(object((tests[0].evidence as unknown[])[0]).kind, "reference");
  assert.ok(tests.some(t => list(t.evidence).some(e => e.kind === "filename-convention")));
  assert.equal(readFileSync(w.file, "utf8"), changed);
  assert.equal(w.events().filter(e => e.method === "initialize").length, 1);
  assert.equal(object(w.events().find(e => e.method === "textDocument/references")?.params).context && object(object(w.events().find(e => e.method === "textDocument/references")?.params).context).includeDeclaration, false);
});
test("impact: staged edits and untracked source are included without modifying the Git index", async () => {
  const w = project(), fresh = join(w.root, "fresh.fixture");
  writeFileSync(w.file, source.replace("1", "2")); git(w.root, "add", "source.fixture"); writeFileSync(fresh, source);
  const before = git(w.root, "status", "--porcelain"); const result = await run(w.impact());
  assert.equal(result.data.success, true); assert.equal(object(result.data.counts).changedFiles, 2); assert.equal(list(result.data.changedSymbols).length, 2);
  assert.equal(git(w.root, "status", "--porcelain"), before);
});
test("impact: semantic references wait for Rust indexing instead of claiming an empty result", async () => {
  const w = project(w => {
    const target = join(w.root, "test_source.fixture"); writeFileSync(target, "changed();\n");
    return { capabilities: caps, serverStatus: { quiescent: true, health: "ok" }, serverStatusDelay: 80, requiresIndex: true, responses: { "textDocument/documentSymbol": [symbol], "textDocument/references": [{ uri: fileUri(target), range }] } };
  }, source, w => { w.configs["rust-analyzer"] = { ...w.configs.fixture }; delete w.configs.fixture; w.saveConfig(); });
  writeFileSync(w.file, source.replace("1", "2"));
  const result = await run(w.impact()); assert.equal(result.data.verified, true); assert.equal(object(result.data.counts).references, 1); assert.equal(object(result.data.counts).candidateTests, 1);
  const events = w.events(), status = events.findIndex(event => event.method === "experimental/serverStatus"), request = events.findIndex(event => event.method === "textDocument/references");
  assert.ok(status >= 0 && request > status);
});
test("impact: a method-body edit selects the method instead of its unchanged parent class", async () => {
  const text = "class Outer {\n changed() {\n  return 1;\n }\n}\n";
  const method = { name: "changed", kind: 6, range: { start: { line: 1, character: 1 }, end: { line: 3, character: 2 } }, selectionRange: { start: { line: 1, character: 1 }, end: { line: 1, character: 8 } } };
  const w = project(() => ({ capabilities: caps, responses: { "textDocument/documentSymbol": [{ name: "Outer", kind: 5, range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } }, selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, children: [method] }] } }), text);
  writeFileSync(w.file, text.replace("return 1", "return 2"));
  assert.deepEqual(list((await run(w.impact())).data.changedSymbols).map(s => s.name), ["changed"]);
});
test("impact: deleted declaration evidence comes from HEAD and never targets the following unchanged function", async () => {
  const tail = source.replaceAll("changed", "untouched");
  const w = project(() => ({ capabilities: caps, responses: { "textDocument/documentSymbol": [{ ...symbol, name: "untouched", selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 18 } } }] } }), source + "\n" + tail);
  writeFileSync(w.file, tail);
  const result = await run(w.impact());
  assert.equal(result.data.verified, false); assert.deepEqual(result.data.changedSymbols, []);
  assert.ok(list(result.data.removedContexts).some(c => String(c.snippet).includes("function changed")));
  assert.equal(w.events().some(e => e.method === "textDocument/references"), false);
});
test("impact: deleted files remain explicit even when no current source file can be opened", async () => {
  const w = project(), file = join(w.root, "removed.ts"); writeFileSync(file, "export function gone() {}\n");
  git(w.root, "add", "removed.ts"); git(w.root, "-c", "user.name=codex-lsp-fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + join(w.root, ".git/disabled-hooks"), "commit", "--quiet", "-m", "added"); rmSync(file);
  const result = await run(w.impact());
  assert.equal(result.data.verified, false); assert.equal(object(result.data.counts).deletedFiles, 1);
  assert.equal(list(result.data.deletedFiles)[0].file, file);
});
test("impact: concurrent changes remove stale symbol/test evidence and preserve external edits", async () => {
  const w = project(w => ({ capabilities: caps, responses: { "textDocument/documentSymbol": [symbol], "textDocument/references": [{ uri: fileUri(join(w.root, "test_source.fixture")), range }] }, beforeResponse: { "textDocument/references": { file: w.file, text: "external edit\n" } } }));
  writeFileSync(w.file, source.replace("1", "2"));
  const result = await run(w.impact());
  assert.equal(result.code, 1); assert.deepEqual(result.data.changedSymbols, []); assert.deepEqual(result.data.candidateTests, []);
  assert.match(String(list(result.data.errors)[0].error), /modified during impact/); assert.equal(readFileSync(w.file, "utf8"), "external edit\n");
});
for (const response of [42, [{ name: "bad", kind: 12, range: null }]]) test(`impact: malformed declarations ${JSON.stringify(response)} fail with file evidence`, async () => {
  const w = project(() => ({ capabilities: caps, responses: { "textDocument/documentSymbol": response } })); writeFileSync(w.file, source.replace("1", "2"));
  const result = await run(w.impact()); assert.equal(result.code, 1); assert.equal(result.data.verified, false); assert.equal(list(result.data.errors)[0].file, w.file);
});
test("impact: malformed references cannot become affected-file or test claims", async () => {
  const w = project(() => ({ capabilities: caps, responses: { "textDocument/documentSymbol": [symbol], "textDocument/references": [{ uri: 42, range }] } })); writeFileSync(w.file, source.replace("1", "2"));
  const result = await run(w.impact()); assert.equal(result.code, 1); assert.deepEqual(result.data.affectedFiles, []); assert.match(String(list(result.data.errors)[0].error), /Invalid impact reference/);
});
test("impact: virtual document references remain data and cannot masquerade as filesystem tests", async () => {
  const w = project(() => ({ capabilities: caps, responses: { "textDocument/documentSymbol": [symbol], "textDocument/references": [{ uri: "untitled:/tests/test_source.py", range }] } })); writeFileSync(w.file, source.replace("1", "2"));
  const result = await run(w.impact()); assert.equal(object(result.data.counts).references, 1); assert.deepEqual(result.data.candidateTests, []);
});
test("impact: native AST test discovery preserves indented attributes and rejects changes during extraction", async () => {
  const w = project(w => {
    const inline = join(w.root, "embedded.rs"), bin = join(w.root, "node_modules/.bin"), code = "#[cfg(test)]\n    #[test]\n    fn embedded_test() { changed(); }\n";
    writeFileSync(inline, code); mkdirSync(bin, { recursive: true });
    const script = 'const fs=require("node:fs");let source="";process.stdin.on("data",c=>source+=c);process.stdin.on("end",()=>{if(fs.existsSync(' + JSON.stringify(join(w.root, ".git/mutate-on-ast")) + '))fs.writeFileSync(' + JSON.stringify(w.file) + ',"external edit\\n");process.stdout.write(JSON.stringify([{text:source,ruleId:"snippet",range:{byteOffset:{start:0,end:Buffer.byteLength(source)}}}]));});\n';
    writeFileSync(join(bin, "ast-fixture.cjs"), script);
    if (process.platform === "win32") writeFileSync(join(bin, "ast-grep.cmd"), '@"' + process.execPath + '" "%~dp0ast-fixture.cjs" %*\r\n');
    else {
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      writeFileSync(join(bin, "ast-grep"), '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(join(bin, "ast-fixture.cjs")) + ' "$@"\n', { mode: 0o755 });
    }
    const character = code.split("\n")[2].indexOf("changed"), point = { start: { line: 2, character }, end: { line: 2, character: character + 7 } };
    return { capabilities: caps, responses: { "textDocument/documentSymbol": [symbol], "textDocument/references": [{ uri: fileUri(inline), range: point }] } };
  });
  writeFileSync(w.file, source.replace("1", "2"));
  const result = await run({ ...w.impact(), timeout: 4000 });
  assert.equal(result.data.success, true); assert.equal(list(result.data.candidateTests).length, 1);
  assert.equal(object((list(result.data.candidateTests)[0].evidence as unknown[])[0]).kind, "enclosing-test");
  writeFileSync(join(w.root, ".git/mutate-on-ast"), "");
  const raced = await run({ ...w.impact(), timeout: 4000 });
  assert.equal(raced.data.success, false); assert.deepEqual(raced.data.changedSymbols, []); assert.deepEqual(raced.data.candidateTests, []);
  assert.ok(list(raced.data.errors).some(error => String(error.error).includes("Source changed"))); assert.equal(readFileSync(w.file, "utf8"), "external edit\n");
});
test("impact: clean worktrees start no server; non-Git and write requests fail explicitly", async () => {
  const w = project(), result = await run(w.impact()); assert.equal(result.data.success, true); assert.equal(object(result.data.counts).changedFiles, 0);
  const invalid = workspace(); await assert.rejects(run({ ...parseOptions(["impact", "--changed"], invalid.root), timeout: 400 }), /Git .*failed/);
  await assert.rejects(run({ ...w.impact(), apply: true }), /read-only/);
  assert.equal(existsSync(join(w.root, "wire.ndjson")), false);
});
