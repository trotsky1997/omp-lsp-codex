import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileUri, object, type ObjectValue } from "../src/config.ts";
import { run, type Options } from "../src/commands.ts";
import { runTooling } from "../src/tooling.ts";
import { LspClient } from "../src/client.ts";
import { cleanWorkspaces, isolateGlobalConfig, workspace } from "./fixtures/workspace.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); }); after(() => restore());
afterEach(async () => { const active = LspClient.active.size; await Promise.all([...LspClient.active].map(client => client.close())); cleanWorkspaces(); assert.equal(active, 0); });
const source = "export var value=1\n", fixed = "export const value=1\n";

function oxc() {
  const w = workspace(), file = join(w.root, "source.ts"), uri = fileUri(file), bin = join(w.root, "node_modules/.bin");
  const state = join(w.root, ".git/oxc.json"), trace = join(w.root, ".git/oxc-trace.jsonl"), script = join(w.root, ".git/oxc.cjs");
  mkdirSync(bin, { recursive: true }); writeFileSync(file, source);
  writeFileSync(join(w.root, "package.json"), JSON.stringify({ devDependencies: { oxlint: "1.89.0", oxfmt: "0.74.0" } }));
  writeFileSync(join(w.root, ".oxfmtrc.json"), '{"semi":false}\n'); writeFileSync(join(w.root, "oxlint.config.ts"), "export default {rules:{'no-var':'error'}}\n");
  const serverArgs = w.configs.fixture.args!;
  writeFileSync(script, `const fs=require('node:fs'),path=require('node:path');const tool=process.argv[2],args=process.argv.slice(3),state=${JSON.stringify(state)},trace=${JSON.stringify(trace)};
fs.appendFileSync(trace,JSON.stringify({tool,args,pid:process.pid,cwd:process.cwd()})+'\\n');
if(args.includes('--lsp')){process.argv=[process.execPath,...${JSON.stringify(serverArgs)}];import(require('node:url').pathToFileURL(process.argv[1]).href);}
else{let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const s=JSON.parse(fs.readFileSync(state,'utf8')),file=args.at(-1),text=fs.readFileSync(file,'utf8'),ignored=!!s.ignored;
if(tool==='oxfmt'){if(args.includes('--check')){process.stdout.write('Finished in 1ms on '+(ignored?0:1)+' files using 1 threads.\\n');process.exitCode=ignored||text===text.replace('value=1','value = 1')?0:1;}else process.stdout.write(input.replace('value=1','value = 1'));}
else{const diagnostics=!ignored&&text.includes('var ')?[{filename:path.relative(process.cwd(),file),message:'Unexpected var',code:'eslint(no-var)',severity:'error',labels:[{span:{offset:7,length:3}}]}]:[];process.stdout.write(JSON.stringify({number_of_files:ignored?0:1,diagnostics}));process.exitCode=diagnostics.length?1:0;}});}
`);
  for (const name of ["oxlint", "oxfmt"]) {
    if (process.platform === "win32") writeFileSync(join(bin, name + ".cmd"), '@"' + process.execPath + '" "' + script + '" ' + name + ' %*\r\n');
    else { const q = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'"; writeFileSync(join(bin, name), "#!/bin/sh\nexec " + q(process.execPath) + " " + q(script) + " " + name + ' "$@"\n', { mode: 0o755 }); }
  }
  const issue = { range: { end: { character: 10, line: 0 }, start: { character: 7, line: 0 } }, severity: 1, code: "eslint(no-var)", source: "oxc", message: "Unexpected var\nhelp: Use const" };
  const action = { title: "Fix safe lint issues", kind: "source.fixAll.oxc", edit: { changes: { [uri]: [{ range: issue.range, newText: "const" }] } } };
  const set = (overrides: ObjectValue = {}, cli: ObjectValue = {}) => {
    writeFileSync(state, JSON.stringify(cli));
    w.setScenario({ capabilities: { codeActionProvider: { codeActionKinds: ["source.fixAll.oxc", "source.fixAllDangerous.oxc"] } }, diagnosticVersionFromDocument: true,
      diagnosticsByText: { [source]: [issue], [fixed]: [] }, responses: { "textDocument/codeAction": [action] }, ...overrides });
  };
  set(); execFileSync("git", ["init", "--quiet", w.root]); execFileSync("git", ["-C", w.root, "add", "."], { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  const index = readFileSync(join(w.root, ".git/index"));
  const stable = (text = source) => { assert.equal(readFileSync(file, "utf8"), text); assert.deepEqual(readFileSync(join(w.root, ".git/index")), index); };
  const args = (command: string, extra: Partial<Options> = {}): Options => ({ ...w.args("hover"), command, file, timeout: 5000, ...extra });
  const launches = () => existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line) as ObjectValue) : [];
  return { ...w, file, uri, set, issue, action, stable, args, launches };
}

test("Oxc tooling: automatic project discovery uses native CLI providers and keeps previews read-only", async () => {
  const w = oxc();
  const lint = await runTooling(w.args("lint")); assert.equal(lint.code, 1); assert.equal(lint.data.verified, true); assert.equal(lint.data.diagnosticCount, 1);
  assert.equal((object((lint.data.checked as ObjectValue[])[0]).providers as ObjectValue[])[0].name, "oxlint");
  const format = await runTooling(w.args("format", { check: true })); assert.equal(format.code, 1); assert.equal(format.data.needsFormatting, true);
  assert.equal((object((format.data.checked as ObjectValue[])[0]).providers as ObjectValue[])[0].name, "oxfmt");
  w.stable(); assert.ok(w.launches().every(row => !(row.args as string[]).some(arg => ["--fix", "--write", "--lsp"].includes(arg))));
  assert.equal(existsSync(join(w.root, "wire.ndjson")), false);
});

test("Oxc tooling: fix discovers project linters, uses matching safe actions and verifies with CLI diagnostics", async () => {
  const w = oxc(), plan = join(w.root, "lint.json");
  await assert.rejects(run(w.args("fix")), /require --plan/);
  const preview = await run(w.args("fix", { plan })); assert.equal(preview.data.saved, true); assert.equal(preview.data.hasErrors, true); w.stable();
  const initialize = object(w.events().find(row => row.method === "initialize")?.params);
  assert.deepEqual(initialize.initializationOptions, [{ workspaceUri: fileUri(w.root), options: { fixKind: "safe_fix" } }]);
  assert.equal(object(object(initialize.capabilities).workspace).applyEdit, false);
  assert.deepEqual(object(object(w.events().find(row => row.method === "textDocument/codeAction")?.params).context).only, ["source.fixAll.oxc"]);
  const applied = await run(w.args("apply", { file: undefined, plan, budget: 1000 }));
  assert.equal(applied.code, 0); assert.equal(applied.data.applied, true); assert.equal(applied.data.toolVerification, "verified");
  assert.deepEqual(object(applied.data.comparison).counts, { new: 0, resolved: 1, existing: 0 }); w.stable(fixed);
  assert.ok(w.launches().every(row => !(row.args as string[]).includes("--fix")));
});

test("Oxc tooling: ignored source never starts a fix server or saves a plan", async () => {
  const w = oxc(); w.set({}, { ignored: true });
  for (const command of ["lint", "format"]) {
    const result = await runTooling(w.args(command, { plan: join(w.root, command + ".json") }));
    assert.equal(result.code, 0); assert.equal(result.data.ignoredFiles, 1); assert.equal(result.data.checkedFiles, 1); assert.equal(result.data.saved, false);
  }
  w.stable(); assert.ok(w.launches().every(row => !(row.args as string[]).includes("--lsp")));
});

test("Oxc tooling: changed-file fix discovers native project linters", async () => {
  const w = oxc(), plan = join(w.root, ".git/changed.json");
  writeFileSync(w.file, fixed); execFileSync("git", ["-C", w.root, "add", "source.ts"]);
  execFileSync("git", ["-C", w.root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  writeFileSync(w.file, source); const index = readFileSync(join(w.root, ".git/index"));
  const result = await run(w.args("fix", { file: undefined, changed: true, plan }));
  assert.equal(result.data.saved, true); assert.equal(result.data.checkedFiles, 1); assert.equal(result.data.changedFiles, 1);
  assert.equal(readFileSync(w.file, "utf8"), source); assert.deepEqual(readFileSync(join(w.root, ".git/index")), index);
});

test("Oxc tooling: explicit LSP and reviewed quickfix selection keep their selected providers", async () => {
  for (const extra of [{ server: "fixture" }, { kind: "quickfix", query: "0" }]) {
    const w = oxc(), plan = join(w.root, "selected.json"); w.configs.fixture.fileTypes!.push(".ts"); w.saveConfig();
    if (extra.kind) w.set({ responses: { "textDocument/codeAction": [{ ...w.action, kind: "quickfix" }] } });
    const result = await run(w.args("fix", { plan, ...extra }));
    assert.equal(result.data.saved, true); assert.equal(w.launches().length, 0); w.stable();
  }
});

test("Oxc tooling: mismatched CLI and code-action diagnostics never produce a repair plan", async () => {
  const w = oxc(), plan = join(w.root, "lint.json"); w.set({ diagnosticsByText: undefined, diagnostics: [] });
  const result = await runTooling(w.args("lint", { plan })); assert.equal(result.code, 1); assert.equal(result.data.verified, false); assert.match(result.human, /diagnostics differ/);
  assert.equal(existsSync(plan), false); w.stable();
});

test("Oxc tooling: dangerous or command actions stay outside safe fix plans", async () => {
  const w = oxc(), plan = join(w.root, "lint.json");
  w.set({ responses: { "textDocument/codeAction": [{ ...w.action, kind: "source.fixAllDangerous.oxc" }, { title: "Command", kind: "source.fixAll.oxc", command: { command: "oxc.fixAll", title: "Fix" } }] } });
  const result = await runTooling(w.args("lint", { plan })); assert.equal(result.data.saved, false); assert.equal(existsSync(plan), false);
  const reasons = (result.data.skipped as ObjectValue[]).map(row => row.reason).join("\n"); assert.match(reasons, /outside the requested/); assert.match(reasons, /server command/); w.stable();
  assert.ok(w.events().every(row => row.method !== "workspace/executeCommand"));
});

test("Oxc tooling: formatting plans are idempotent and bind native config and dependency locks", async () => {
  const w = oxc(), plan = join(w.root, "format.json"), lock = join(w.root, "pnpm-lock.yaml"); writeFileSync(lock, "lockfileVersion: '9.0'\n");
  assert.equal((await runTooling(w.args("format", { plan }))).data.saved, true); w.stable();
  const data = JSON.parse(readFileSync(plan, "utf8")); assert.ok(data.guards.some((row: ObjectValue) => row.file === lock));
  writeFileSync(lock, "lockfileVersion: '10.0'\n"); await assert.rejects(run(w.args("apply", { file: undefined, plan })), /Configuration changed/); w.stable();
  writeFileSync(lock, "lockfileVersion: '9.0'\n");
  const applied = await run(w.args("apply", { file: undefined, plan })); assert.equal(applied.code, 0); assert.equal(applied.data.toolVerification, "verified"); w.stable("export var value = 1\n");
});

test("Oxc tooling: config-only projects discover TypeScript configs without package declarations", async () => {
  const w = oxc(); rmSync(join(w.root, "package.json"));
  for (const command of ["lint", "format"]) { const result = await runTooling(w.args(command, command === "format" ? { check: true } : {})); assert.equal(result.data.verified, true); assert.equal(result.code, 1); }
  w.stable();
});
