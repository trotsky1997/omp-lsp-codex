import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import childProcess, { execFileSync, type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { runToolProcess, resolveToolCommand, toolConfigFiles, type ToolName, type ToolProcessResult } from "../src/tool-process.ts";
import type { ObjectValue } from "../src/config.ts";
import type { Options } from "../src/commands.ts";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture(name = "source.py", source = '"😀"; import os\n', tracked = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tool 中文 "))); roots.push(root);
  if (tracked) execFileSync("git", ["init", "--quiet", root]); else mkdirSync(join(root, ".git"));
  const put = (name: string, text: string) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); return file; };
  const file = put(name, source), bin = join(root, "node_modules/.bin"), trace = join(root, ".git/trace.jsonl"), scenario = join(root, ".git/scenario.json");
  mkdirSync(bin, { recursive: true });
  const script = put(".git/tool.cjs", `const fs=require('node:fs'),path=require('node:path');const tool=process.argv[2],argv=process.argv.slice(3),root=${JSON.stringify(root)},file=${JSON.stringify(file)};let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const s=JSON.parse(fs.readFileSync(${JSON.stringify(scenario)},'utf8'));fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({pid:process.pid,tool,argv,cwd:process.cwd(),input,optionalLocks:process.env.GIT_OPTIONAL_LOCKS,rustupAutoInstall:process.env.RUSTUP_AUTO_INSTALL})+'\\n');if(s.timeout){setInterval(()=>{},10000);return;}if(s.overflow){process.stdout.write(Buffer.alloc(17*1024*1024,65));return;}if(s.invalidUtf8){process.stdout.write(Buffer.from([0xff]));return;}if(s.honorOutputFile&&process.env.RUFF_OUTPUT_FILE){fs.writeFileSync(process.env.RUFF_OUTPUT_FILE,'redirected output');process.exit(0);}if(s.mutate||s.configuredFix&&tool==='ruff'&&(!argv.includes('--no-fix')||!argv.includes('--no-fix-only')))fs.writeFileSync(file,'external edit\\n');if(s.mutateConfig&&(!s.mutateOn||argv.includes(s.mutateOn)))fs.writeFileSync(s.mutateConfig,'changed=true\\n');if(s.stderr)process.stderr.write(s.stderr);let out=s.output;if(tool==='ruff'&&argv.includes('--verbose')){if(!s.noCount)process.stderr.write('[DEBUG] Checked '+(s.ignored?0:1)+' files in: 1ms\\n');if(s.ignored)out=[];}else if(tool==='ruff'&&argv.includes('--check'))out=s.ignored?'':'1 file already formatted\\n';else if(tool==='oxfmt'&&argv.includes('--check'))out=s.inventory??(s.noCount?'':'Finished in 1ms on '+(s.ignored?0:1)+' files using 1 threads.\\n');else if(tool==='prettier'&&argv.includes('--file-info'))out=JSON.stringify({ignored:!!s.ignored,inferredParser:'babel'});else if(tool==='cargo'&&argv[0]==='metadata')out=JSON.stringify(s.metadata??{workspace_root:root,packages:[{id:'fixture-id',name:'fixture',manifest_path:argv[argv.indexOf('--manifest-path')+1],edition:'2024',targets:[{name:'fixture',kind:['lib'],src_path:file}]}]});else if(s.fixedOutput!==undefined&&(argv.includes('--fix-dry-run')||argv.includes('--write')||argv[0]==='format'||tool==='prettier'||tool==='rustfmt'||tool==='oxfmt'))out=s.fixedOutput;process.stdout.write(typeof out==='string'?out:JSON.stringify(out));process.exitCode=(tool==='ruff'||tool==='oxfmt')&&argv.includes('--check')?(s.checkCode??0):(tool==='cargo'&&argv[0]==='metadata'||tool==='prettier'&&argv.includes('--file-info'))?0:(s.code??0);});`);
  for (const tool of ["ruff", "eslint", "biome", "prettier", "rustfmt", "cargo", "oxlint", "oxfmt"]) {
    if (process.platform === "win32") writeFileSync(join(bin, tool + ".cmd"), '@"' + process.execPath + '" "' + script + '" ' + tool + ' %*\r\n');
    else { const q = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"; writeFileSync(join(bin, tool), "#!/bin/sh\nexec " + q(process.execPath) + " " + q(script) + " " + tool + ' "$@"\n', { mode: 0o755 }); }
  }
  const args = (extra: Partial<Options> = {}) => ({ command: "lint", cwd: root, file, languages: [], line: 1, timeout: 15000, limit: 0, json: true, changed: false, workspace: false, apply: false, project: false, globalConfigOnly: false, globalBinsOnly: false, ...extra });
  const set = (value: ObjectValue) => writeFileSync(scenario, JSON.stringify(value));
  const events = () => existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line) as ObjectValue) : [];
  const run = (tool: ToolName, operation: "lint" | "fix" | "format" = "lint", extra: Partial<Options> = {}, cache?: Map<string, Promise<ToolProcessResult>>) => runToolProcess(args(extra), file, tool, operation, cache);
  return { root, file, bin, put, args, set, events, run };
}
function ruff(file: string, fix: unknown = { applicability: "safe", edits: [{ content: "", location: { row: 1, column: 6 }, end_location: { row: 1, column: 15 } }] }) {
  return [{ filename: file, message: "Unused import", code: "F401", location: { row: 1, column: 13 }, end_location: { row: 1, column: 15 }, fix }];
}

test("tool processes: Ruff Unicode positions and safe fixes preserve source/index without a cache", async () => {
  const w = fixture(undefined, undefined, true); w.put("ruff.toml", "line-length=88\n");
  execFileSync("git", ["-C", w.root, "add", "source.py", "ruff.toml"], { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  w.set({ output: ruff(w.file), code: 1 });
  const index = readFileSync(join(w.root, ".git/index")), result = await w.run("ruff", "fix");
  assert.equal(result.updated, '"😀"; \n'); assert.equal(result.verified, true); assert.equal(result.diagnostics[0].range.start.character, 13);
  assert.equal(readFileSync(w.file, "utf8"), '"😀"; import os\n'); assert.deepEqual(readFileSync(join(w.root, ".git/index")), index);
  assert.ok(result.configFiles.includes(join(w.root, "ruff.toml"))); assert.deepEqual(w.events()[0].argv, ["check", "--no-fix", "--no-fix-only", "--no-cache", "--force-exclude", "--output-format=json", "--verbose", w.file]);
  assert.equal(w.events()[0].optionalLocks, "0"); assert.equal(w.events()[0].rustupAutoInstall, "0"); assert.equal(w.events()[0].input, "");
});

test("tool processes: Ruff configured autofix stays disabled for lint and fix previews", async () => {
  const w = fixture(undefined, undefined, true);
  w.put("pyproject.toml", "[tool.ruff]\nfix=true\nfix-only=true\nunsafe-fixes=true\n");
  execFileSync("git", ["-C", w.root, "add", "source.py", "pyproject.toml"], { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  const original = readFileSync(w.file, "utf8"), index = readFileSync(join(w.root, ".git/index"));
  w.set({ configuredFix: true, output: ruff(w.file), code: 1 });
  for (const operation of ["lint", "fix"] as const) {
    const result = await w.run("ruff", operation);
    assert.equal(result.verified, true); assert.equal(result.diagnostics.length, 1);
    assert.equal(result.updated, operation === "fix" ? '"😀"; \n' : undefined);
    assert.equal(readFileSync(w.file, "utf8"), original); assert.deepEqual(readFileSync(join(w.root, ".git/index")), index);
    assert.ok((w.events().at(-1)!.argv as string[]).includes("--no-fix"));
    assert.ok((w.events().at(-1)!.argv as string[]).includes("--no-fix-only"));
  }
});

test("tool processes: unsafe Ruff suggestions and conflicting fixes stay unchanged", async () => {
  const w = fixture(); w.set({ output: ruff(w.file, { applicability: "unsafe", edits: [] }), code: 1 });
  assert.equal((await w.run("ruff", "fix")).updated, readFileSync(w.file, "utf8"));
  w.set({ output: [...ruff(w.file), ...ruff(w.file)], code: 1 }); assert.equal((await w.run("ruff", "fix")).updated, '"😀"; \n');
});

test("tool processes: Ruff output-file environment cannot redirect reports into source", async () => {
  const w = fixture(), original = readFileSync(w.file, "utf8"), before = process.env.RUFF_OUTPUT_FILE;
  w.set({ honorOutputFile: true, output: ruff(w.file), code: 1 });
  try {
    process.env.RUFF_OUTPUT_FILE = w.file;
    const result = await w.run("ruff");
    assert.equal(result.verified, true); assert.equal(result.diagnostics.length, 1); assert.equal(readFileSync(w.file, "utf8"), original);
    assert.equal(process.env.RUFF_OUTPUT_FILE, w.file);
  } finally { if (before === undefined) delete process.env.RUFF_OUTPUT_FILE; else process.env.RUFF_OUTPUT_FILE = before; }
});

test("tool processes: Ruff and Prettier excluded files skip source processing with explicit ignored state", async () => {
  for (const [tool, operation] of [["ruff", "lint"], ["ruff", "format"], ["prettier", "format"]] as const) {
    const w = fixture(); w.set({ ignored: true, output: [] });
    const result = await w.run(tool, operation); assert.equal(result.ignored, true); assert.equal(result.updated, undefined); assert.equal(result.verified, true); assert.deepEqual(result.diagnostics, []); assert.equal(w.events().length, 1);
  }
  const w = fixture("src/a.js", "var x=1\n"); w.put(".prettierignore", "src/a.js\n"); w.set({ ignored: true }); await w.run("prettier", "format");
  assert.deepEqual(w.events()[0].argv, ["--ignore-path", join(w.root, ".prettierignore"), "--file-info", w.file]);
  const excluded = fixture(); excluded.set({ noCount: true, output: [], stderr: "warning: No Python files found under the given path(s)\n" });
  assert.equal((await excluded.run("ruff")).ignored, true);
});

test("tool processes: Ruff formatting preflight uses real file count before stdin-only preview", async () => {
  const w = fixture("source.py", "x= 1\n"); w.set({ checkCode: 1, fixedOutput: "x = 1\n" });
  const result = await w.run("ruff", "format"); assert.equal(result.updated, "x = 1\n"); assert.equal(result.ignored, undefined);
  assert.deepEqual(w.events()[0].argv, ["format", "--no-cache", "--check", "--force-exclude", w.file]); assert.equal(w.events()[0].input, "");
  assert.deepEqual(w.events()[1].argv, ["format", "--no-cache", "--force-exclude", "--stdin-filename", w.file, "-"]); assert.equal(w.events()[1].input, result.original);
});

test("tool processes: ESLint reports baseline before fix-dry-run and treats ignored files explicitly", async () => {
  const w = fixture("source.js", "const a=1\n"), report = [{ filePath: w.file, messages: [{ ruleId: "semi", severity: 2, message: "Missing semicolon", line: 1, column: 10 }] }];
  w.set({ output: report, fixedOutput: JSON.stringify([{ ...report[0], output: "const a=1;\n", messages: [] }]), code: 1 });
  const result = await w.run("eslint", "fix"); assert.equal(result.updated, "const a=1;\n"); assert.equal(result.diagnostics.length, 1);
  assert.equal(w.events().length, 2); assert.ok((w.events()[1].argv as string[]).includes("--fix-dry-run")); assert.equal(readFileSync(w.file, "utf8"), result.original);
  w.set({ output: [{ filePath: w.file, messages: [{ severity: 1, message: "File ignored because no matching configuration was supplied." }] }] });
  const ignored = await w.run("eslint", "fix"); assert.equal(ignored.ignored, true); assert.deepEqual(ignored.diagnostics, []); assert.equal(ignored.updated, undefined);
});

test("tool processes: Biome preflight and stdin-only safe fix, current and byte-span reporters", async () => {
  const w = fixture("source.js", '"😀"; var x=1\n');
  const report = { summary: { unchanged: 1, changed: 0, diagnosticsNotPrinted: 0 }, diagnostics: [{ severity: "warning", category: "lint/correctness/noUnusedVariables", message: "unused x", location: { path: w.file, start: { line: 1, column: 10 }, end: { line: 1, column: 11 } } }] };
  w.set({ output: report, fixedOutput: '"😀"; var _x=1\n' });
  const result = await w.run("biome", "fix"); assert.equal(result.updated, '"😀"; var _x=1\n'); assert.equal(result.diagnostics[0].range.start.character, 10);
  assert.ok(!(w.events()[0].argv as string[]).includes("--write")); assert.equal(w.events()[0].input, ""); assert.ok((w.events()[1].argv as string[]).includes("--write"));
  const spanReport = { ...report, diagnostics: [{ ...report.diagnostics[0], location: { path: w.file, span: [12, 13] } }] };
  w.set({ output: spanReport }); assert.equal((await w.run("biome")).diagnostics[0].range.start.character, 10);
  w.set({ output: { summary: { unchanged: 0, changed: 0, diagnosticsNotPrinted: 0 }, diagnostics: [] } }); assert.equal((await w.run("biome", "format")).ignored, true);
});

test("tool processes: Biome format parse failures remain unverified and never report a clean preview", async () => {
  const source = "const = ;\n", w = fixture("source.js", source);
  w.set({ code: 1, output: { summary: { unchanged: 0, changed: 0, errors: 1, diagnosticsNotPrinted: 0 }, diagnostics: [{ severity: "error", category: "parse", message: "Expected an identifier", location: { path: w.file, start: { line: 1, column: 7 }, end: { line: 1, column: 8 } } }] } });
  const result = await w.run("biome", "format");
  assert.equal(result.verified, false); assert.equal(result.updated, undefined); assert.equal(result.diagnostics[0].severity, 1); assert.match(result.errors![0], /formatting did not complete/);
  assert.equal(w.events().length, 1); assert.equal(readFileSync(w.file, "utf8"), source);
});

test("tool processes: Prettier/rustfmt previews use project-local binaries and Cargo edition", async () => {
  const w = fixture("src/source.rs", "pub async fn run(){ }\n"); w.put("Cargo.toml", '[package]\nname="fixture"\nversion="0.1.0"\nedition="2024"\n'); w.put("rustfmt.toml", "max_width=100\n");
  w.set({ output: "", fixedOutput: "pub async fn run() {}\n" });
  assert.equal((await w.run("rustfmt", "format")).updated, "pub async fn run() {}\n");
  const rustfmt = w.events().find(value => value.tool === "rustfmt")!; assert.deepEqual(rustfmt.argv, ["--emit", "stdout", "--edition", "2024", "--config-path", join(w.root, "rustfmt.toml")]);
  assert.equal(resolveToolCommand("prettier", w.file), join(w.bin, "prettier" + (process.platform === "win32" ? ".cmd" : "")));
  assert.equal((await w.run("prettier", "format")).updated, "pub async fn run() {}\n"); assert.equal(readFileSync(w.file, "utf8"), "pub async fn run(){ }\n");
});

test("tool processes: Oxlint JSON uses root-relative paths and UTF-8 spans without invoking fixes", async () => {
  const source = '"😀"; export var value=1\n', w = fixture("src/source.ts", source, true), offset = Buffer.byteLength(source.slice(0, source.indexOf("var")));
  const config = w.put("oxlint.config.ts", "export default { rules: { 'no-var': 'error' } }\n"), lock = w.put("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  execFileSync("git", ["-C", w.root, "add", "src/source.ts", "oxlint.config.ts", "pnpm-lock.yaml"], { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  const index = readFileSync(join(w.root, ".git/index"));
  w.set({ code: 1, output: { number_of_files: 1, diagnostics: [{ filename: relative(w.root, w.file), code: "eslint(no-var)", severity: "error", message: "Unexpected var", labels: [{ span: { offset, length: 3 } }] }] } });
  const result = await w.run("oxlint", "fix");
  assert.equal(result.verified, true); assert.equal(result.updated, undefined); assert.equal(result.diagnostics[0].range.start.character, source.indexOf("var"));
  assert.equal(result.diagnostics[0].range.end.character, source.indexOf("var") + 3); assert.ok(result.configFiles.includes(config)); assert.ok(result.configFiles.includes(lock));
  assert.deepEqual(w.events()[0].argv, ["--no-error-on-unmatched-pattern", "--format", "json", w.file]); assert.equal(w.events()[0].cwd, w.root); assert.equal(w.events()[0].input, "");
  assert.equal(readFileSync(w.file, "utf8"), source); assert.deepEqual(readFileSync(join(w.root, ".git/index")), index);
  w.set({ output: { number_of_files: 0, diagnostics: [] } }); const ignored = await w.run("oxlint"); assert.equal(ignored.verified, true); assert.equal(ignored.ignored, true);
});

test("tool processes: Oxlint rejects incomplete counts, malformed spans and outside-file diagnostics", async () => {
  const w = fixture("src/source.ts", '"😀"; var value=1\n'), row = { filename: w.file, severity: "error", message: "issue", labels: [{ span: { offset: 8, length: 3 } }] };
  for (const output of [
    { diagnostics: [] }, { number_of_files: 2, diagnostics: [] }, { number_of_files: 1, diagnostics: {} },
    { number_of_files: 0, diagnostics: [row] },
    { number_of_files: 1, diagnostics: [{ ...row, filename: join(w.root, "other.ts") }] },
    { number_of_files: 1, diagnostics: [{ ...row, labels: [] }] },
    { number_of_files: 1, diagnostics: [{ ...row, labels: [{ span: { offset: 2, length: 1 } }] }] },
    { number_of_files: 1, diagnostics: [{ ...row, severity: "unknown" }] },
  ]) { w.set({ output }); await assert.rejects(w.run("oxlint"), /incomplete|outside|coordinates|UTF-8|severity/); }
  w.set({ code: 1, output: { number_of_files: 1, diagnostics: [] } }); await assert.rejects(w.run("oxlint"), /failed without/);
  w.set({ code: 1, output: "", stderr: "Failed to load JS plugin missing-plugin from oxlint.config.ts" });
  await assert.rejects(w.run("oxlint"), /Oxlint.*Failed to load JS plugin missing-plugin from oxlint.config.ts/);
});

test("tool processes: Oxfmt previews preserve source/index, report ignores and keep project config", async () => {
  const w = fixture("src/source.ts", "export const value=1\n", true), config = w.put(".oxfmtrc.json", '{"semi":false}\n');
  execFileSync("git", ["-C", w.root, "add", "src/source.ts", ".oxfmtrc.json"], { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  const index = readFileSync(join(w.root, ".git/index")); w.set({ checkCode: 1, fixedOutput: "export const value = 1\n" });
  const result = await w.run("oxfmt", "format"); assert.equal(result.updated, "export const value = 1\n"); assert.equal(result.verified, true); assert.ok(result.configFiles.includes(config));
  assert.deepEqual(w.events()[0].argv, ["--no-error-on-unmatched-pattern", "--check", w.file]); assert.equal(w.events()[0].cwd, w.root);
  assert.deepEqual(w.events()[1].argv, ["--stdin-filepath", w.file]); assert.equal(w.events()[1].input, result.original);
  assert.equal(readFileSync(w.file, "utf8"), result.original); assert.deepEqual(readFileSync(join(w.root, ".git/index")), index);
  w.set({ ignored: true }); const ignored = await w.run("oxfmt", "format"); assert.equal(ignored.ignored, true); assert.equal(ignored.updated, undefined);
  w.set({ noCount: true }); await assert.rejects(w.run("oxfmt", "format"), /processed-file count/);
  w.set({ noCount: true, checkCode: 1, stderr: "Failed to parse .oxfmtrc.json: invalid configuration" });
  await assert.rejects(w.run("oxfmt", "format"), /Oxfmt.*Failed to parse .oxfmtrc.json/);
  w.set({ code: 2, output: "", stderr: "parse failed" }); await assert.rejects(w.run("oxfmt", "format"), /oxfmt exited 2/);
  await assert.rejects(w.run("oxlint", "format"), /does not support format/); await assert.rejects(w.run("oxfmt", "fix"), /does not support fix/);
});

test("tool processes: Clippy caches one crate invocation, maps workspace paths and safe multi-span fixes", async () => {
  const w = fixture("crates/a/src/lib.rs", "pub fn n() -> i32 { return 1; }\n"), other = w.put("crates/a/src/other.rs", "pub fn other() {}\n");
  w.put("crates/a/Cargo.toml", '[package]\nname="fixture"\nversion="0.1.0"\nedition="2024"\n');
  const span = { file_name: "crates/a/src/lib.rs", is_primary: true, byte_start: 20, byte_end: 29 };
  const message = { reason: "compiler-message", message: { message: "unneeded return", level: "warning", code: { code: "clippy::needless_return" }, spans: [span], children: [{ spans: [{ ...span, suggested_replacement: "1", suggestion_applicability: "MachineApplicable" }] }] } };
  w.set({ output: JSON.stringify(message) + "\n" + JSON.stringify(message) + '\n{"reason":"build-finished","success":true}\n' });
  const cache = new Map<string, Promise<ToolProcessResult>>(), result = await w.run("clippy", "fix", {}, cache);
  assert.equal(result.diagnostics.length, 1); assert.equal(result.updated, "pub fn n() -> i32 { 1 }\n");
  const otherResult = await runToolProcess(w.args(), other, "clippy", "lint", cache); assert.equal(otherResult.diagnostics.length, 0); assert.equal(otherResult.verified, false);
  assert.equal(w.events().filter(event => (event.argv as string[])[0] === "clippy").length, 1);
  assert.equal(w.events().filter(event => (event.argv as string[])[0] === "metadata").length, 1);
  assert.ok((w.events().find(event => (event.argv as string[])[0] === "clippy")!.argv as string[]).includes("--locked"));
  w.set({ output: '{"reason":"build-finished","success":false}\n', code: 101, stderr: "compile error" });
  const incomplete = await w.run("clippy"); assert.equal(incomplete.verified, false); assert.match(incomplete.errors![0], /did not complete/);
});

test("tool processes: Clippy selects the source target and never builds unrelated tests", async () => {
  const cases = [
    { file: "src/module.rs", path: "src/lib.rs", kind: "lib", flags: ["--lib"] },
    { file: "src/lib.rs", path: "src/lib.rs", kind: "proc-macro", flags: ["--lib"] },
    { file: "src/bin/tool/helper.rs", path: "src/bin/tool/main.rs", kind: "bin", flags: ["--bin", "selected"] },
    { file: "tests/selected.rs", path: "tests/selected.rs", kind: "test", flags: ["--test", "selected"] },
    { file: "examples/demo/helper.rs", path: "examples/demo/main.rs", kind: "example", flags: ["--example", "selected"] },
    { file: "benches/selected.rs", path: "benches/selected.rs", kind: "bench", flags: ["--bench", "selected"] },
    { file: "build.rs", path: "build.rs", kind: "custom-build", flags: [] },
  ];
  for (const row of cases) {
    const w = fixture(row.file, "pub fn n() {}\n"), manifest = w.put("Cargo.toml", '[package]\nname="fixture"\nversion="0.1.0"\n');
    const target = { name: "selected", kind: [row.kind], src_path: join(w.root, row.path) };
    const targetDirectory = join(w.root, ".git/target"), artifact = join(targetDirectory, "debug/deps/libselected-hash.rmeta");
    w.put(".git/target/debug/deps/selected-hash.d", `${w.file.replaceAll(" ", "\\ ")}:\n`);
    w.set({ metadata: { workspace_root: w.root, target_directory: targetDirectory, packages: [{ id: "fixture-id", name: "fixture", manifest_path: manifest,
      targets: [{ name: "unrelated", kind: ["test"], src_path: join(w.root, "tests/unrelated.rs") }, target],
    }] }, output: JSON.stringify({ reason: "compiler-artifact", package_id: "fixture-id", filenames: [artifact] }) + '\n{"reason":"build-finished","success":true}\n' });
    const result = await w.run("clippy"), launch = w.events().find(event => (event.argv as string[])[0] === "clippy")!;
    assert.equal(result.verified, true); assert.deepEqual(result.cargo?.targets, [{ name: "selected", kind: [row.kind] }]);
    assert.deepEqual(launch.argv, ["clippy", "--offline", "--locked", ...row.flags, "--message-format=json", "--manifest-path", manifest]);
  }
});

test("tool processes: unlinked Rust files require compiler input evidence before reporting clean", async () => {
  const w = fixture("src/unlinked #module.rs", "pub fn n() {}\n"), manifest = w.put("Cargo.toml", '[package]\nname="fixture"\nversion="0.1.0"\n');
  const targetDirectory = join(w.root, ".git/target"), artifact = join(targetDirectory, "debug/deps/libfixture-hash.rmeta");
  const metadata = { workspace_root: w.root, target_directory: targetDirectory, packages: [{ id: "fixture-id", name: "fixture", manifest_path: manifest, targets: [{ name: "fixture", kind: ["lib"], src_path: join(w.root, "src/lib.rs") }] }] };
  const report = (filename = artifact, packageId = "fixture-id") => JSON.stringify({ reason: "compiler-artifact", package_id: packageId, filenames: [filename] }) + '\n{"reason":"build-finished","success":true}\n';
  w.set({ metadata, output: report() });
  const missing = await w.run("clippy", "fix"); assert.equal(missing.verified, false); assert.equal(missing.updated, undefined); assert.equal(missing.cargo?.sourceInput, "unconfirmed"); assert.match(missing.errors![0], /absent from Cargo/);
  const relativePath = "src/unlinked\\ \\#module.rs", dep = w.put(".git/target/debug/deps/fixture-hash.d", `${artifact}: ${relativePath}\n\n${relativePath}:\n`);
  const included = await w.run("clippy"); assert.equal(included.verified, true); assert.equal(included.cargo?.sourceInput, "dep-info");
  writeFileSync(dep, `${artifact}: ${relativePath}\n\nsrc/unlinkedmodule.rs:\n`);
  assert.equal((await w.run("clippy")).verified, false);
  writeFileSync(dep, `${relativePath}:\n`);
  w.set({ metadata, output: report(artifact, "another-package") }); assert.equal((await w.run("clippy")).verified, false);
  w.set({ metadata, output: report(join(w.root, "outside/libfixture-hash.rmeta")) }); assert.equal((await w.run("clippy")).verified, false);
  assert.equal(readFileSync(w.file, "utf8"), "pub fn n() {}\n");
});

test("tool processes: Clippy reuses guarded Cargo feature settings and rejects invalid selections", async () => {
  const w = fixture("src/lib.rs", "pub fn n() {}\n"); w.put("Cargo.toml", '[package]\nname="fixture"\nversion="0.1.0"\n');
  const config = (settings: ObjectValue) => w.put(".codex/lsp.json", JSON.stringify({ "rust-analyzer": { settings } }));
  w.set({ output: '{"reason":"build-finished","success":true}\n' });
  const path = config({ "rust-analyzer": { cargo: { features: ["rt", "sync"], noDefaultFeatures: true } } });
  const selected = await w.run("clippy"); assert.deepEqual(selected.cargo?.features, ["rt", "sync"]); assert.equal(selected.cargo?.noDefaultFeatures, true); assert.ok(selected.configFiles.includes(path));
  const argv = w.events().at(-1)!.argv as string[]; assert.equal(argv[argv.indexOf("--features") + 1], "rt,sync"); assert.ok(argv.includes("--no-default-features"));
  config({ "rust-analyzer.cargo.features": "all", "rust-analyzer.cargo.noDefaultFeatures": false });
  assert.equal((await w.run("clippy")).cargo?.features, "all"); assert.ok((w.events().at(-1)!.argv as string[]).includes("--all-features")); assert.ok(!(w.events().at(-1)!.argv as string[]).includes("--no-default-features"));
  for (const cargo of [{ features: "full" }, { features: ["rt,sync"] }, { features: [2] }, { noDefaultFeatures: "true" }]) {
    config({ "rust-analyzer": { cargo } }); await assert.rejects(w.run("clippy"), /Invalid rust-analyzer Cargo/);
  }
  config({ "rust-analyzer": { cargo: { features: ["rt"] } } }); w.set({ output: '{"reason":"build-finished","success":true}\n', mutateConfig: path, mutateOn: "clippy" });
  await assert.rejects(w.run("clippy"), /configuration changed/);
});

test("tool processes: unknown Cargo source membership and malformed targets never verify clean", async () => {
  const w = fixture("outside/probe.rs", "pub fn n() {}\n"), manifest = w.put("Cargo.toml", '[package]\nname="fixture"\nversion="0.1.0"\n');
  const metadata = (targets: unknown) => ({ workspace_root: w.root, packages: [{ id: "fixture-id", name: "fixture", manifest_path: manifest, targets }] });
  w.set({ metadata: metadata([{ name: "fixture", kind: ["lib"], src_path: join(w.root, "src/lib.rs") }]) });
  await assert.rejects(w.run("clippy"), /outside Cargo target directories/);
  for (const targets of [undefined, [{ name: "bad", kind: "lib", src_path: w.file }], [{ name: "bad", kind: [2], src_path: w.file }]]) {
    w.set({ metadata: metadata(targets) }); await assert.rejects(w.run("clippy"), /malformed target metadata/);
  }
  assert.ok(w.events().every(event => (event.argv as string[])[0] === "metadata"));
});

test("tool processes: denied Clippy lints retain safe fixes while unknown compiler/build failures stay unverified", async () => {
  const text = "pub fn n() -> i32 { return 1; }\n", w = fixture("src/lib.rs", text);
  w.put("Cargo.toml", '[package]\nname="fixture"\nversion="0.1.0"\n');
  const span = { file_name: "src/lib.rs", is_primary: true, byte_start: text.indexOf("return"), byte_end: text.indexOf("return") + "return 1;".length };
  const denied = { reason: "compiler-message", package_id: "fixture-id", message: { message: "unneeded return", level: "error", code: { code: "clippy::needless_return" }, spans: [span], children: [{ spans: [{ ...span, suggested_replacement: "1", suggestion_applicability: "MachineApplicable" }] }] } };
  const finish = { reason: "build-finished", success: false }, summary = "error: could not compile `fixture` (lib) due to 1 previous error\n";
  w.set({ output: [denied, finish].map(record => JSON.stringify(record)).join("\n"), code: 101, stderr: summary });
  const result = await w.run("clippy", "fix"); assert.equal(result.verified, true); assert.equal(result.diagnostics[0].severity, 1); assert.equal(result.updated, text.replace("return 1;", "1")); assert.equal(result.errors, undefined);
  const compiler = { ...denied, message: { ...denied.message, code: { code: "E0308" } } };
  for (const [records, stderr] of [
    [[denied, compiler, finish], summary],
    [[{ ...denied, message: { ...denied.message, code: null } }, finish], summary],
    [[denied, finish], summary + "error: failed to run custom build command for `dependency`\n"],
    [[denied, finish], "error: could not compile `other-package` (lib) due to 1 previous error\n"],
    [[{ ...denied, package_id: "unknown-package" }, finish], ""],
  ] as const) {
    w.set({ output: records.map(record => JSON.stringify(record)).join("\n"), code: 101, stderr });
    const failed = await w.run("clippy", "fix"); assert.equal(failed.verified, false); assert.equal(failed.updated, undefined); assert.match(failed.errors![0], /did not complete/);
  }
  assert.equal(readFileSync(w.file, "utf8"), text);
});

test("tool processes: malformed output, source coordinates, truncation and failures never verify clean", async () => {
  const w = fixture();
  for (const scenario of [{ output: "{" }, { output: [], code: 1 }, { output: [], noCount: true }, { output: ruff(w.file, { applicability: "safe", edits: [{ content: "", location: { row: 1, column: 6 }, end_location: { row: 1, column: 999 } }] }), code: 1 }, { invalidUtf8: true }, { overflow: true }]) {
    w.set(scenario); await assert.rejects(() => w.run("ruff", "fix"), /malformed JSON|incomplete|outside source|invalid UTF-8|exceeds 16 MiB/);
  }
  w.set({ output: "[]", code: 2, stderr: "bad configuration" }); await assert.rejects(() => w.run("ruff"), /exited 2.*bad configuration/);
  w.set({ output: ruff(w.file), mutate: true }); await assert.rejects(() => w.run("ruff"), /Source changed/);
});

test("tool processes: deadline kills native child and rejects incomplete reports", async () => {
  const w = fixture(); w.set({ timeout: true });
  const spawn = childProcess.spawn; let child: ChildProcess | undefined;
  childProcess.spawn = ((...args: Parameters<typeof spawn>) => { child = spawn(...args); return child; }) as typeof spawn;
  syncBuiltinESMExports();
  try { await assert.rejects(() => w.run("ruff", "lint", { timeout: 250 }), /deadline exceeded/); }
  finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
  const pid = child?.pid; assert.ok(pid); assert.ok(child && (child.exitCode !== null || child.signalCode !== null));
  assert.throws(() => process.kill(pid, 0), /ESRCH|no such process/);
});

test("tool processes: all structured reporters reject incomplete data and configuration races", async () => {
  const w = fixture(); w.set({ output: [] }); await assert.rejects(() => w.run("eslint"), /incomplete diagnostic report/);
  w.set({ output: [{ filePath: w.file, messages: [{ message: "invalid", severity: 2, line: 99, column: 1 }] }] }); await assert.rejects(() => w.run("eslint"), /outside source/);
  w.set({ output: { summary: { unchanged: 1, changed: 0, diagnosticsNotPrinted: 1 }, diagnostics: [] } }); await assert.rejects(() => w.run("biome"), /incomplete diagnostic report/);
  w.set({ output: { summary: { unchanged: 1, changed: 0, diagnosticsNotPrinted: 0 }, diagnostics: [{ message: "split", severity: "error", location: { path: w.file, span: [2, 3] } }] } }); await assert.rejects(() => w.run("biome"), /splits UTF-8/);
  w.put("Cargo.toml", '[package]\nname="fixture"\nversion="0.1.0"\n');
  w.set({ output: '{"reason":"compiler-artifact"}\n' }); await assert.rejects(() => w.run("clippy"), /incomplete Cargo report/);
  w.set({ output: 'not JSON\n{"reason":"build-finished","success":true}\n' }); await assert.rejects(() => w.run("clippy"), /malformed JSON/);
  const config = w.put("ruff.toml", "line-length=88\n"); w.set({ output: [], mutateConfig: config }); await assert.rejects(() => w.run("ruff"), /configuration changed/);
});

test("tool processes: config inventory resolves parent declarations and operation validation is explicit", async () => {
  const w = fixture("src/a.py"); w.put("pyproject.toml", "[tool.ruff]\n"); w.put(".gitignore", "build/\n"); w.set({ output: [] });
  assert.deepEqual(toolConfigFiles("ruff", w.file).sort(), [join(w.root, ".gitignore"), join(w.root, "pyproject.toml")].sort());
  const editor = w.put(".editorconfig", "root = true\n[*]\nindent_size = 4\n"); assert.ok(toolConfigFiles("biome", w.file).includes(editor));
  await assert.rejects(() => w.run("eslint", "format"), /does not support format/); await assert.rejects(() => w.run("rustfmt"), /does not support lint/);
  const path = process.env.PATH; process.env.PATH = "";
  try { await assert.rejects(() => w.run("ruff", "lint", { globalBinsOnly: true }), /uv tool install ruff.*docs.astral.sh/); } finally { process.env.PATH = path; }
});
