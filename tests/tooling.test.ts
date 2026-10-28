import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { runTooling, validateToolPlan, verifyToolPlan } from "../src/tooling.ts";
import { applyPlan } from "../src/fixes.ts";
import { LspClient } from "../src/client.ts";
import { object, type ObjectValue } from "../src/config.ts";
import type { Options } from "../src/commands.ts";
import { cleanWorkspaces, isolateGlobalConfig, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); }); after(() => restore());
afterEach(async () => { const leaked = LspClient.active.size; await Promise.all([...LspClient.active].map(client => client.close())); cleanWorkspaces(); assert.equal(leaked, 0); });
type Workspace = ReturnType<typeof workspace>;
const edit = (newText = "formatted", start = 0, end = 5) => ({ range: { start: { line: 0, character: start }, end: { line: 0, character: end } }, newText });
const diagnostic = (message = "lint issue") => ({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message, severity: 1, code: "rule", source: "fixture" });
const options = (w: Workspace, command = "format", values: Partial<Options> = {}): Options => ({ ...w.args("hover"), command, timeout: 5000, server: "fixture", ...values });
function format(w: Workspace, response: unknown = [edit()]) { w.setScenario({ capabilities: { documentFormattingProvider: true, documentRangeFormattingProvider: true }, responses: { "textDocument/formatting": response, "textDocument/rangeFormatting": response } }); }
function lint(w: Workspace, extra: ObjectValue = {}) { w.setScenario({ capabilities: { codeActionProvider: { resolveProvider: true } }, diagnostics: [diagnostic()], responses: { "textDocument/codeAction": [{ title: "Fix all", kind: "source.fixAll", edit: { changes: { [w.uri]: [edit("clean")] } } }] }, ...extra }); }
function prettier(w: Workspace, ignored = false) {
  const bin = join(w.root, "node_modules/.bin"); mkdirSync(bin, { recursive: true });
  const script = join(w.root, ".git/prettier.cjs"); writeFileSync(script, `let text=''; process.stdin.on('data',chunk=>text+=chunk); process.stdin.on('end',()=>process.stdout.write(process.argv.includes('--file-info')?JSON.stringify({ignored:${ignored},inferredParser:'typescript'}):text.replace(/\\s*=\\s*/g,' = ')));\n`);
  if (process.platform === "win32") writeFileSync(join(bin, "prettier.cmd"), '@"' + process.execPath + '" "' + script + '" %*\r\n');
  else { const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"; writeFileSync(join(bin, "prettier"), "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(script) + ' "$@"\n', { mode: 0o755 }); }
  const file = join(w.root, "source.ts"); writeFileSync(file, "const value=1\n"); return file;
}

function biome(w: Workspace) {
  const bin = join(w.root, "node_modules/.bin"), script = join(w.root, ".git/biome.mjs"), state = join(w.root, ".git/biome-state.json"), trace = join(w.root, ".git/biome-trace.jsonl"); mkdirSync(bin, { recursive: true }); writeFileSync(state, "{}");
  writeFileSync(script, `import{readFileSync,appendFileSync}from'node:fs';import{MessageFramer,encodeMessageFrame}from${JSON.stringify(new URL("../src/omp/message-framing.js", import.meta.url).href)};
const args=process.argv.slice(2),state=JSON.parse(readFileSync(${JSON.stringify(state)},'utf8')),record=value=>appendFileSync(${JSON.stringify(trace)},JSON.stringify(value)+'\\n');
if(args[0]!=='lsp-proxy'){let input='';for await(const chunk of process.stdin)input+=chunk;record({kind:'cli',args});if(args.includes('--reporter=json')){const ignored=args[0]==='format'?state.ignoreFormat:state.ignoreLint;process.stdout.write(JSON.stringify({summary:{changed:0,unchanged:ignored?0:1,diagnosticsNotPrinted:0},diagnostics:[]}));}else process.stdout.write(input);process.exit(0);}
const framer=new MessageFramer(Buffer.alloc(0)),send=message=>process.stdout.write(encodeMessageFrame(message));for await(const chunk of process.stdin){framer.push(chunk);for(const text of framer.drain(()=>{})){const m=JSON.parse(text);record({kind:'lsp',method:m.method});if(m.method==='initialize')send({id:m.id,result:{capabilities:{documentFormattingProvider:true},serverInfo:{name:'biome_lsp'}}});else if(m.method==='initialized')send({method:'window/logMessage',params:{type:3,message:'Server initialized with PID: '+process.pid}});else if(m.method==='textDocument/didOpen'&&!state.noDiagnostics)send({method:'textDocument/publishDiagnostics',params:{uri:m.params.textDocument.uri,diagnostics:[]}});else if(m.method==='textDocument/formatting')send({id:m.id,result:state.edits??[]});else if(m.method==='shutdown')send({id:m.id,result:null});else if(m.method==='exit')process.exit(0);}}
`);
  const command = join(bin, "biome" + (process.platform === "win32" ? ".cmd" : ""));
  if (process.platform === "win32") writeFileSync(command, '@"' + process.execPath + '" "' + script + '" %*\r\n');
  else { const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"; writeFileSync(command, "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(script) + ' "$@"\n', { mode: 0o755 }); }
  w.configs.fixture.disabled = true; w.configs.biome = { command, args: ["lsp-proxy"], fileTypes: [".fixture"], rootMarkers: ["fixture.project"], isLinter: true }; w.saveConfig();
  return { script, set: (value: ObjectValue) => writeFileSync(state, JSON.stringify(value)), events: () => existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line) as ObjectValue) : [] };
}

test("tooling: ignored formatter files are visible in human and compact JSON summaries", async () => {
  const w = workspace(), file = prettier(w, true);
  const result = await runTooling(options(w, "format", { file, server: undefined, tool: "prettier", check: true }));
  assert.equal(result.code, 0); assert.equal(result.data.ignoredFiles, 1); assert.equal(result.data.needsFormatting, false);
  assert.match(result.human, /1 ignored/); assert.equal(readFileSync(file, "utf8"), "const value=1\n");
});

test("tooling: native formatting previews/checks preserve source and Git index", async () => {
  const w = workspace(); format(w);
  execFileSync("git", ["init", "--quiet", w.root]); execFileSync("git", ["-C", w.root, "add", "."]);
  const before = readFileSync(w.file), index = readFileSync(join(w.root, ".git/index"));
  const preview = await runTooling(options(w)); assert.equal(preview.code, 0); assert.equal(preview.data.applied, false); assert.equal(preview.data.needsFormatting, true);
  assert.match(String((preview.data.files as ObjectValue[])[0].diff), /--- a\/source.fixture/);
  const check = await runTooling(options(w, "format", { check: true })); assert.equal(check.code, 1); assert.equal(check.data.changedFiles, 1);
  assert.equal(check.data.total, 1); assert.equal(check.data.shown, 1); assert.equal(check.data.truncated, false);
  assert.equal((check.data.files as ObjectValue[])[0].diff, undefined); assert.equal(check.data.saved, undefined);
  assert.deepEqual(readFileSync(w.file), before); assert.deepEqual(readFileSync(join(w.root, ".git/index")), index);
  format(w, null); const clean = await runTooling(options(w, "format", { check: true })); assert.equal(clean.code, 0); assert.equal(clean.data.needsFormatting, false);
  assert.equal(w.events().some(event => event.method === "workspace/executeCommand" || event.method === "workspace/applyEdit"), false);
});

test("tooling: auto formatter prefers a linter provider and checks its advertised capability", async () => {
  const w = workspace(); format(w);
  w.configs.semantic = { ...w.configs.fixture }; w.configs.fixture.isLinter = true; w.saveConfig();
  const result = await runTooling(options(w, "format", { server: undefined }));
  assert.equal(result.code, 0); assert.equal((object((result.data.checked as ObjectValue[])[0]).providers as ObjectValue[])[0].name, "fixture");
  w.setScenario({ capabilities: { hoverProvider: true } });
  const unsupported = await runTooling(options(w)); assert.equal(unsupported.code, 1); assert.equal(unsupported.data.verified, false); assert.match(unsupported.human, /documentFormattingProvider/);
});

test("tooling: range formatting dispatches exact UTF-16 range and refuses a whole-file fallback", async () => {
  const w = workspace(), range = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }; format(w);
  const result = await runTooling(options(w, "format", { range })); assert.equal(result.code, 0);
  assert.deepEqual(object(w.events().find(event => event.method === "textDocument/rangeFormatting")?.params).range, range);
  assert.equal(w.events().some(event => event.method === "textDocument/formatting"), false);
  w.setScenario({ capabilities: { documentFormattingProvider: true } });
  const unsupported = await runTooling(options(w, "format", { range })); assert.equal(unsupported.code, 1); assert.match(unsupported.human, /documentRangeFormattingProvider/);
});

test("tooling: malformed, overlapping, outside-source and surrogate-splitting formatter edits fail before planning", async () => {
  for (const response of [{ edits: [] }, [null], [edit("one"), edit("two", 2, 7)], [edit("bad", 0, 99)], [{ ...edit(), newText: "\ud800" }]]) {
    const w = workspace(); format(w, response);
    const path = join(w.root, "format.json"), result = await runTooling(options(w, "format", { plan: path }));
    assert.equal(result.code, 1); assert.equal(result.data.verified, false); assert.equal(existsSync(path), false); assert.equal(readFileSync(w.file, "utf8"), "value = 1\n");
  }
  const w = workspace(); writeFileSync(w.file, "😀value\n"); format(w, [edit("bad", 1, 2)]);
  const result = await runTooling(options(w)); assert.equal(result.code, 1); assert.match(result.human, /UTF-16/);
});

test("tooling: formatting plans apply once and verify idempotence without a diagnostic server", async () => {
  const w = workspace(); format(w);
  const plan = join(w.root, "format.json"), planned = await runTooling(options(w, "format", { plan })); assert.equal(planned.data.saved, true);
  const bytes = JSON.parse(readFileSync(plan, "utf8")); assert.equal(bytes.baseline, undefined); assert.equal(bytes.verification.command, "format");
  format(w, []);
  const applied = await applyPlan(options(w, "apply", { file: undefined, plan }), (files, _baseline, verification) => verifyToolPlan(files, verification!, options(w)));
  assert.equal(applied.code, 0); assert.equal(applied.data.applied, true); assert.equal(applied.data.toolVerification, "verified");
  assert.equal(readFileSync(w.file, "utf8"), "formatted = 1\n"); assert.equal(w.events().some(event => event.method === "textDocument/diagnostic"), false);
  await assert.rejects(applyPlan(options(w, "apply", { file: undefined, plan }), async () => { throw new Error("must not run"); }), /already|applied/);
});

test("tooling: post-apply formatter drift retains actual applied state and fails verification", async () => {
  const w = workspace(); format(w); const plan = join(w.root, "format.json"); await runTooling(options(w, "format", { plan }));
  format(w, [edit("again", 0, 9)]);
  const applied = await applyPlan(options(w, "apply", { file: undefined, plan }), (files, _baseline, verification) => verifyToolPlan(files, verification!, options(w)));
  assert.equal(applied.code, 1); assert.equal(applied.data.applied, true); assert.equal(applied.data.applicationState, "applied"); assert.equal(applied.data.toolVerification, "verified"); assert.equal(object(applied.data.toolResults).needsFormatting, true);
  assert.equal(readFileSync(w.file, "utf8"), "formatted = 1\n");
});

test("tooling: linter providers supply verified diagnostics and pure source.fixAll plans", async () => {
  const w = workspace(); lint(w);
  const checked = await runTooling(options(w, "lint")); assert.equal(checked.code, 1); assert.equal(checked.data.verified, true); assert.equal(checked.data.total, 1); assert.equal(checked.data.hasErrors, true);
  const path = join(w.root, "lint.json"), preview = await runTooling(options(w, "lint", { plan: path })); assert.equal(preview.data.saved, true); assert.equal(readFileSync(w.file, "utf8"), "value = 1\n");
  const request = object(w.events().find(event => event.method === "textDocument/codeAction")?.params); assert.deepEqual(object(request.context).only, ["source.fixAll"]); assert.equal(object(request.context).triggerKind, 1);
  w.setScenario({ capabilities: {}, diagnostics: [] });
  const applied = await applyPlan(options(w, "apply", { file: undefined, plan: path }), (files, _baseline, verification) => verifyToolPlan(files, verification!, options(w)));
  assert.equal(applied.code, 0); assert.equal(applied.data.toolVerification, "verified"); assert.deepEqual(object(applied.data.comparison).counts, { new: 0, resolved: 1, existing: 0 });
});

test("tooling: command-based fixes stay visible and never execute during lint planning", async () => {
  const w = workspace(); lint(w, { responses: { "textDocument/codeAction": [{ title: "Command fix", kind: "source.fixAll", command: { title: "fix", command: "danger" } }] } });
  const result = await runTooling(options(w, "lint", { plan: join(w.root, "lint.json") })); assert.equal(result.data.saved, false); assert.equal(result.code, 1);
  assert.match(String((result.data.skipped as ObjectValue[])[0].reason), /server command/); assert.equal(w.events().some(event => event.method === "workspace/executeCommand"), false);
});

test("tooling: unverified diagnostics and concurrent source changes never produce a plan", async () => {
  const w = workspace(); lint(w, { diagnostics: false });
  const path = join(w.root, "lint.json"), result = await runTooling(options(w, "lint", { plan: path, timeout: 100 })); assert.equal(result.data.verified, false); assert.equal(existsSync(path), false);
  lint(w, { diagnostics: [{ ...diagnostic(), range: { start: { line: 99, character: 0 }, end: { line: 99, character: 1 } } }] });
  const invalid = await runTooling(options(w, "lint", { plan: path })); assert.equal(invalid.data.verified, false); assert.equal(existsSync(path), false); assert.match(invalid.human, /outside source/);
  format(w); w.setScenario({ capabilities: { documentFormattingProvider: true }, responses: { "textDocument/formatting": [edit()] }, beforeResponse: { "textDocument/formatting": { file: w.file, text: "user = 2\n" } } });
  const changed = await runTooling(options(w, "format", { plan: path })); assert.equal(changed.code, 1); assert.match(changed.human, /Source changed/); assert.equal(readFileSync(w.file, "utf8"), "user = 2\n"); assert.equal(existsSync(path), false);
});

test("tooling: selector and scope conflicts fail with one actionable usage error", async () => {
  const w = workspace(); format(w);
  for (const flags of [{ changed: true }, { file: undefined }, { tool: "ruff" }, { check: true, plan: join(w.root, "plan.json") }]) await assert.rejects(runTooling(options(w, "format", flags)), /Use format/);
  await assert.rejects(runTooling(options(w, "lint", { check: true })), /Use lint/);
  await assert.rejects(runTooling(options(w, "lint", { kind: "quickfix" })), /source.fixAll/);
  for (const extra of [{ query: "0" }, { line: 2 }, { column: 1 }, { symbol: "value" }, { workspace: true }, { newName: "next" }]) await assert.rejects(runTooling(options(w, "lint", extra)), /operate on files/);
  const unavailable = await runTooling(options(w, "format", { server: "unknown" })); assert.equal(unavailable.code, 1); assert.match(unavailable.human, /unavailable/);
});

test("tooling: bounded errors mark clipping and keep Unicode intact; limit zero preserves the full error", async () => {
  const w = workspace(), prefix = "LSP error -32000: ", message = "x".repeat(1999 - prefix.length) + "😀" + "y".repeat(2100);
  w.setScenario({ capabilities: { documentFormattingProvider: true }, errors: { "textDocument/formatting": { code: -32000, message } } });
  const limited = await runTooling(options(w)), short = (limited.data.errors as ObjectValue[])[0];
  assert.equal(short.errorTruncated, true); assert.equal(String(short.error).isWellFormed(), true); assert.equal(String(short.error).length, 1999);
  const complete = await runTooling(options(w, "format", { limit: 0 })), full = (complete.data.errors as ObjectValue[])[0];
  assert.equal(full.error, prefix + message); assert.equal(full.errorTruncated, undefined);
});

test("tooling: changed scope skips unrelated binary/config files before reading source", async () => {
  const w = workspace(); format(w);
  execFileSync("git", ["init", "--quiet", w.root]);
  writeFileSync(join(w.root, "picture.png"), Buffer.from([0xff, 0x00, 0xfe]));
  const result = await runTooling(options(w, "format", { file: undefined, changed: true }));
  assert.equal(result.code, 0); assert.equal((result.data.checked as ObjectValue[]).length, 1);
  assert.equal((result.data.skipped as ObjectValue[]).some(row => String(row.file).endsWith("picture.png")), true);
  assert.equal(readFileSync(w.file, "utf8"), "value = 1\n");
});

test("tooling: provider preflight rejects changed executables/configuration before applying", async () => {
  const w = workspace(); format(w); const plan = join(w.root, "format.json"); await runTooling(options(w, "format", { plan }));
  const value = JSON.parse(readFileSync(plan, "utf8"));
  await validateToolPlan([w.file], value.verification, options(w));
  w.configs.fixture.settings = { changed: true }; w.saveConfig();
  await assert.rejects(validateToolPlan([w.file], value.verification, options(w)), /provider changed/);
  assert.equal(readFileSync(w.file, "utf8"), "value = 1\n");
  await assert.rejects(validateToolPlan([w.file], { ...value.verification, providers: [] }, options(w)), /file scope/);
});

test("tooling: project-declared formatter conflicts request one selector, explicit CLI bypasses unrelated LSP config", async () => {
  const w = workspace(), file = prettier(w); writeFileSync(join(w.root, "package.json"), JSON.stringify({ devDependencies: { prettier: "*", "@biomejs/biome": "*" } }));
  const conflict = await runTooling(options(w, "format", { file, server: undefined })); assert.equal(conflict.code, 1); assert.match(conflict.human, /Multiple project formatters/);
  writeFileSync(w.configPath, "{");
  const explicit = await runTooling(options(w, "format", { file, server: undefined, tool: "prettier", check: true })); assert.equal(explicit.code, 1); assert.equal(explicit.data.verified, true, JSON.stringify(explicit.data)); assert.equal(explicit.data.needsFormatting, true);
  assert.equal((object((explicit.data.checked as ObjectValue[])[0]).providers as ObjectValue[])[0].name, "prettier"); assert.equal(readFileSync(file, "utf8"), "const value=1\n");
});

test("tooling: declared unsupported project tools block implicit semantic-server replacements", async () => {
  for (const command of ["lint", "format"]) {
    const w = workspace(), file = join(w.root, "source.ts"); writeFileSync(file, "const value = 1\n");
    writeFileSync(join(w.root, "package.json"), JSON.stringify({ devDependencies: { oxlint: "1.89.0", oxfmt: "0.74.0" } }));
    format(w);
    const result = await runTooling(options(w, command, { file, server: undefined }));
    assert.equal(result.code, 1); assert.equal(result.data.verified, false); assert.equal(result.data.checkedFiles, 1);
    assert.match(result.human, new RegExp(`Project tool ${command === "lint" ? "oxlint" : "oxfmt"} is not supported`));
    assert.match(result.human, /project's configured/); assert.equal(existsSync(join(w.root, "wire.ndjson")), false);
    assert.equal(readFileSync(file, "utf8"), "const value = 1\n");
  }
});

test("tooling: a newly added formatter configuration invalidates the reviewed plan before source writes", async () => {
  const w = workspace(), file = prettier(w), plan = join(w.root, "format.json");
  const args = options(w, "format", { file, server: undefined, tool: "prettier", plan });
  const result = await runTooling(args); assert.equal(result.data.saved, true);
  const saved = JSON.parse(readFileSync(plan, "utf8")); assert.ok(saved.guards.some((guard: ObjectValue) => guard.file === join(w.root, ".prettierrc") && guard.sha256 === null));
  writeFileSync(join(w.root, ".prettierrc"), "{}");
  await assert.rejects(applyPlan({ ...args, command: "apply", file: undefined }, (files, _baseline, verification) => verifyToolPlan(files, verification!, args), (files, verification) => validateToolPlan(files, verification!, args)), /Configuration changed/);
  assert.equal(readFileSync(file, "utf8"), "const value=1\n");
});

test("tooling: duplicate fix insertions across code actions are deduped and stale document versions are skipped", async () => {
  const w = workspace(), insertion = edit("clean_", 0, 0), action = { title: "Fix all", kind: "source.fixAll", edit: { documentChanges: [{ textDocument: { uri: w.uri, version: 1 }, edits: [insertion] }] } };
  lint(w, { responses: { "textDocument/codeAction": [action, { ...action, title: "duplicate" }] } });
  const plan = join(w.root, "lint.json"), result = await runTooling(options(w, "lint", { plan })); assert.equal(result.data.saved, true); assert.equal(JSON.parse(readFileSync(plan, "utf8")).files[0].updated, "clean_value = 1\n");
  lint(w, { responses: { "textDocument/codeAction": [{ ...action, edit: { documentChanges: [{ textDocument: { uri: w.uri, version: 99 }, edits: [insertion] }] } }] } });
  const stale = await runTooling(options(w, "lint", { plan: join(w.root, "stale.json") })); assert.equal(stale.data.saved, false); assert.match(String((stale.data.skipped as ObjectValue[])[0].reason), /version is stale/);
});

test("tooling: advertised source.fixAll children and Biome virtual EOF produce a source-bound lint plan", async () => {
  const w = workspace(), action = { title: "Apply all safe fixes", kind: "source.fixAll.biome", edit: { changes: { [w.uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }, newText: "clean = 1\n" }] } } };
  lint(w, { capabilities: { codeActionProvider: { codeActionKinds: ["quickfix.biome", "source.fixAll.biome"] } }, responses: { "textDocument/codeAction": [action] } });
  const plan = join(w.root, "lint.json"), result = await runTooling(options(w, "lint", { plan })); assert.equal(result.data.saved, true); assert.equal(JSON.parse(readFileSync(plan, "utf8")).files[0].updated, "clean = 1\n");
  assert.deepEqual(object(object(w.events().find(event => event.method === "textDocument/codeAction")?.params).context).only, ["source.fixAll.biome"]);
  assert.equal(readFileSync(w.file, "utf8"), "value = 1\n");
});

test("tooling: matching Biome CLI preflight skips ignored LSP files and respects lint versus formatter exclusions", async () => {
  const w = workspace(), mock = biome(w); mock.set({ ignoreLint: true, ignoreFormat: false });
  const lint = await runTooling(options(w, "lint", { server: "biome" })); assert.equal(lint.code, 0); assert.equal(lint.data.ignoredFiles, 1); assert.equal(lint.data.verified, true);
  const ignored = (object((lint.data.checked as ObjectValue[])[0]).providers as ObjectValue[])[0]; assert.equal(ignored.ignored, true); assert.equal(object(ignored.ignoredBy).kind, "cli"); assert.equal(mock.events().some(event => event.kind === "lsp"), false);
  const format = await runTooling(options(w, "format", { server: "biome", check: true })); assert.equal(format.code, 0); assert.equal(format.data.ignoredFiles, 0); assert.equal(format.data.verified, true);
  assert.equal((object((format.data.checked as ObjectValue[])[0]).providers as ObjectValue[])[0].ignoreStatus, "included"); assert.equal(mock.events().some(event => event.method === "textDocument/formatting"), true);
  mock.set({ ignoreFormat: true }); const formatted = await runTooling(options(w, "format", { server: "biome", check: true })); assert.equal(formatted.data.ignoredFiles, 1); assert.equal(formatted.data.needsFormatting, false);
  const stale = await verifyToolPlan([w.file], { schema: 1, command: "format", providers: [{ file: w.file, kind: "lsp", name: "biome", fingerprint: "0".repeat(64) }] }, options(w, "format", { server: "biome" }));
  assert.equal(stale.data.verified, false); assert.match(String((stale.data.errors as ObjectValue[])[0].error), /provider changed/);
});

test("tooling: overridden Biome settings keep clean format verification and expose unknown ignore status", async () => {
  const w = workspace(), mock = biome(w); w.configs.biome.settings = { biome: { configurationPath: "alternate.json" } }; w.saveConfig(); mock.set({ edits: [edit()] });
  const args = options(w, "format", { server: "biome", plan: join(w.root, "format.json") }), preview = await runTooling(args); assert.equal(preview.data.saved, true);
  mock.set({});
  const applied = await applyPlan({ ...args, command: "apply", file: undefined }, (files, _baseline, verification) => verifyToolPlan(files, verification!, args), (files, verification) => validateToolPlan(files, verification!, args));
  assert.equal(applied.code, 0); assert.equal(applied.data.toolVerification, "verified"); assert.equal((object((object(applied.data.toolResults).checked as ObjectValue[])[0]).providers as ObjectValue[])[0].ignoreStatus, "unknown");
  assert.equal(mock.events().some(event => event.kind === "cli"), false);
  w.configs.biome.settings = {}; w.configs.biome.command = process.execPath; w.configs.biome.args = [mock.script, "lsp-proxy"]; w.saveConfig();
  const mismatch = await runTooling(options(w, "format", { server: "biome", check: true })); assert.equal(mismatch.data.verified, true); assert.equal((object((mismatch.data.checked as ObjectValue[])[0]).providers as ObjectValue[])[0].ignoreStatus, "unknown"); assert.equal(mock.events().some(event => event.kind === "cli"), false);
  mock.set({ noDiagnostics: true }); const missing = await runTooling(options(w, "lint", { server: "biome", timeout: 100 })); assert.equal(missing.data.verified, false); assert.match(missing.human, /excludes.*--tool biome/);
});
