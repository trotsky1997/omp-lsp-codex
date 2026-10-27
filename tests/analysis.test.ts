import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { apiDiff, dependencies } from "../src/analysis.ts";
import { parseOptions } from "../src/cli.ts";
import type { ObjectValue } from "../src/config.ts";
import { syntaxTool } from "../src/syntax.ts";
import { isolateGlobalConfig } from "./fixtures/workspace.ts";

const roots: string[] = [];
let restore: () => void;
before(() => { restore = isolateGlobalConfig(); }); after(() => restore());
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const list = (value: unknown) => value as ObjectValue[];
function git(root: string, ...args: string[]) { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }
function project(files: Record<string, string>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "analysis 中文 "))); roots.push(root);
  const put = (name: string, text: string) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); return file; };
  for (const [name, text] of Object.entries(files)) put(name, text);
  put(".gitignore", "node_modules/\n"); git(root, "init", "--quiet"); git(root, "add", ".");
  git(root, "-c", "user.name=codex-lsp-fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + join(root, ".git/disabled-hooks"), "commit", "--quiet", "-m", "fixture");
  const args = (command: string, extra: ObjectValue = {}) => ({ ...parseOptions(["status"], root), command, timeout: 15000, limit: 0, ...extra });
  return { root, put, args, status: () => git(root, "status", "--porcelain") };
}
function wrapper(root: string, mode: "trace" | "malformed" | "mutate" | "timeout", file?: string) {
  const real = syntaxTool(root).command; assert.ok(real, "Installed ast-grep required for native analysis tests");
  const bin = join(root, "node_modules/.bin"), script = join(bin, "analysis-fixture.cjs"), trace = join(root, ".git/ast-trace.jsonl"); mkdirSync(bin, { recursive: true });
  writeFileSync(script, `const fs=require('node:fs'),cp=require('node:child_process');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({pid:process.pid,cwd:process.cwd(),argv:process.argv.slice(2),bytes:Buffer.byteLength(input)})+'\\n');const mode=${JSON.stringify(mode)};if(mode==='timeout'){setTimeout(()=>{},10000);return;}if(mode==='malformed'){process.stdout.write(JSON.stringify([{text:'wrong',ruleId:'import',range:{byteOffset:{start:0,end:999999}}}]));return;}const result=cp.spawnSync(${JSON.stringify(real)},process.argv.slice(2),{input,encoding:'utf8'});if(mode==='mutate')fs.writeFileSync(${JSON.stringify(file)},'external edit\\n');process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status;});`);
  if (process.platform === "win32") writeFileSync(join(bin, "ast-grep.cmd"), '@"' + process.execPath + '" "%~dp0analysis-fixture.cjs" %*\r\n');
  else {
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(join(bin, "ast-grep"), "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(script) + ' "$@"\n', { mode: 0o755 });
  }
  return () => readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line) as ObjectValue);
}

test("analysis API: TypeScript generic/signature and visibility changes exclude private members and body-only edits", async () => {
  const w = project({ "src/api.ts": "export function greet<T>(x: T): T { return x; }\nexport class Client { private secret(): number { return 1; } open(x: string): string { return x; } }\nfunction hidden() {}\n", "src/use.ts": 'import { greet } from "./api.js";\ngreet("hi");\nconst s = "greet(1)"; // greet(1)\n' });
  w.put("src/api.ts", "export function greet<T extends string>(x: T): string { return x; }\nexport class Client { private secret(): string { return 'x'; } open(x: number): number { return x; } }\nfunction hidden(x: number) {}\n");
  const status = w.status(), result = await apiDiff(w.args("api-diff", { base: "HEAD" }));
  assert.equal(result.code, 0); assert.equal(result.data.provider, "ast-grep"); assert.equal(result.data.compatibility, "unverified");
  assert.equal(result.data.surfaceComplete, true); assert.equal(result.data.callsComplete, true);
  const changes = list(result.data.changes); assert.deepEqual(changes.map(item => item.name).sort(), ["Client.open", "greet"]);
  const greet = changes.find(item => item.name === "greet")!; assert.equal(list(greet.candidateCalls).length, 1); assert.equal(list(greet.candidateCalls)[0].line, 2);
  assert.equal(list(greet.candidateCalls)[0].verified, false); assert.equal(w.status(), status);
  w.put("src/api.ts", git(w.root, "show", "HEAD:src/api.ts").replace("return x;", "return x /* body only */;"));
  assert.equal((await apiDiff(w.args("api-diff", { base: "HEAD" }))).data.total, 0);
});

test("analysis API: exported arrows ignore body changes and detect typed parameters", async () => {
  const w = project({ "api.ts": "export const next = (x: number): number => { return x + 1; };\n" });
  w.put("api.ts", "export const next = (x: number): number => { return x + 2; };\n");
  assert.equal((await apiDiff(w.args("api-diff", { base: "HEAD" }))).data.total, 0);
  w.put("api.ts", "export const next = (x: string): string => { return x; };\n");
  assert.equal(list((await apiDiff(w.args("api-diff", { base: "HEAD" }))).data.changes)[0].name, "next");
});

test("analysis API: default exports, ambient signatures, mutable exports and enums retain their surface", async () => {
  const w = project({ "api.ts": "export declare function greet<T>(x: T): T;\nexport default class { open(x: number) {} }\nexport const value=1;\nexport enum Mode { A=1, B=2 }\n" });
  w.put("api.ts", "export declare function greet<T extends string>(x: T): T;\nexport default class { open(x: string) {} }\nexport let value=1;\nexport enum Mode { A=1, B=3 }\n");
  const result = await apiDiff(w.args("api-diff", { base: "HEAD" })); assert.equal(result.code, 0);
  assert.deepEqual(list(result.data.changes).map(item => item.name).sort(), ["Mode", "default.open", "greet", "value"]);
});

test("analysis API: header comments are ignored while literal default whitespace remains significant", async () => {
  const w = project({ "api.ts": 'export function greet(x: /* first */ string = "a b") { return x; }\n' });
  w.put("api.ts", 'export function greet(x: /* second */ string = "a b") { return x; }\n'); assert.equal((await apiDiff(w.args("api-diff", { base: "HEAD" }))).data.total, 0);
  w.put("api.ts", 'export function greet(x: /* second */ string = "a  b") { return x; }\n'); assert.equal((await apiDiff(w.args("api-diff", { base: "HEAD" }))).data.total, 1);
});

test("analysis API: Python __all__, decorators, class members, Unicode and CRLF remain syntax evidence", async () => {
  const w = project({ "api.py": '__all__ = ["greet", "Client"]\r\ndef greet(名字: str) -> str:\r\n    return 名字\r\ndef excluded(x):\r\n    return x\r\nclass Client:\r\n    @staticmethod\r\n    def open(x: int) -> int:\r\n        return x\r\n    def _private(self):\r\n        return 1\r\n' });
  w.put("api.py", readFileSync(join(w.root, "api.py"), "utf8").replace("名字: str", "名字: bytes").replace("@staticmethod", "@classmethod").replace("excluded(x)", "excluded(x, y)"));
  const changes = list((await apiDiff(w.args("api-diff", { base: "HEAD" }))).data.changes);
  assert.deepEqual(changes.map(item => item.name).sort(), ["Client.open", "greet"]);
  assert.equal(list(changes.find(item => item.name === "greet")!.after)[0].line, 2);
  assert.match(String(list(changes.find(item => item.name === "Client.open")!.after)[0].signature), /@classmethod/);
});

test("analysis API: Rust public generics, fields and methods detect shape changes without function bodies", async () => {
  const w = project({ "Cargo.toml": '[package]\nname="probe"\nversion="0.1.0"\n', "src/lib.rs": "pub fn greet<T>(x: T) -> T { x }\npub struct Client<T> { pub value: T, hidden: i32 }\nimpl<T> Client<T> { pub fn open(&self) -> &T { &self.value } }\nfn hidden() {}\n" });
  w.put("src/lib.rs", readFileSync(join(w.root, "src/lib.rs"), "utf8").replace("pub value: T", "pub value: Option<T>").replace("fn open(&self) -> &T", "fn open(&mut self) -> &T").replace("fn hidden()", "fn hidden(x: u32)"));
  const changes = list((await apiDiff(w.args("api-diff", { base: "HEAD" }))).data.changes);
  assert.ok(changes.some(item => item.name === "Client.value")); assert.ok(changes.some(item => String(item.name).endsWith(".open")));
  assert.equal(changes.some(item => String(item.name).includes("hidden")), false);
});

test("analysis API: additions, deletions, renamed files, staged changes and limits retain complete counts", async () => {
  const w = project({ "old.ts": "export function removed() {}\n", "kept.ts": "export function kept(x: number) { return x; }\n" });
  rmSync(join(w.root, "old.ts")); w.put("new.ts", "export function added() {}\n"); w.put("kept.ts", "export function kept(x: string) { return x; }\n"); git(w.root, "add", "kept.ts");
  const status = w.status(), result = await apiDiff(w.args("api-diff", { base: "HEAD", limit: 1 }));
  assert.deepEqual(result.data.counts, { added: 1, removed: 1, modified: 1 }); assert.equal(result.data.total, 3); assert.equal(result.data.shown, 1); assert.equal(result.data.truncated, true); assert.equal(w.status(), status);
  const selected = await apiDiff(w.args("api-diff", { base: "HEAD", file: "kept.ts" })); assert.equal(selected.data.total, 1);
  await assert.rejects(apiDiff(w.args("api-diff", { base: "--help" }))); await assert.rejects(apiDiff(w.args("api-diff", { base: "HEAD", file: "../escape.ts" })), /inside/);
});

test("analysis API: complete surface comparison stays distinct from bounded call-candidate coverage", async () => {
  const files: Record<string, string> = { "zapi.ts": "export function greet(x: number) { return x; }\n" };
  for (let index = 0; index < 205; index++) files[`aaa/${String(index).padStart(3, "0")}.ts`] = "";
  const w = project(files); w.put("zapi.ts", "export function greet(x: string) { return x; }\n");
  const result = await apiDiff(w.args("api-diff", { base: "HEAD", file: "zapi.ts", timeout: 30000 }));
  assert.equal(result.code, 0); assert.equal(result.data.surfaceComplete, true); assert.equal(result.data.callsComplete, false); assert.equal(result.data.complete, false); assert.equal(result.data.bounded, true); assert.equal(result.data.scannedFiles, 200); assert.equal(result.data.total, 1);
});

test("analysis dependencies: TS relative extension/index, re-exports, dynamic imports and cycles use AST nodes", async () => {
  const w = project({ "src/a.ts": 'import { b } from "./b.js";\nexport { c } from "./dir";\nimport type { Foo } from "pkg";\nconst fake="import x from \'./ghost\'"; // import x from "./ghost"\nimport("./b.js");\n', "src/b.ts": 'import "./a.js";\nexport const b=1;\n', "src/dir/index.ts": "export const c=1;\n" });
  const status = w.status(), result = await dependencies(w.args("dependencies", { file: "src/a.ts", depth: 3 }));
  assert.equal(result.code, 0); assert.equal(result.data.complete, true);
  const edges = list(result.data.edges), nodes = list(result.data.nodes); assert.equal(edges.length, 5); assert.equal(edges.some(edge => String(edge.specifier).includes("ghost")), false);
  assert.ok(edges.some(edge => edge.kind === "re-export" && edge.status === "internal")); assert.ok(edges.some(edge => edge.kind === "type-import" && edge.status === "external"));
  assert.ok(nodes.some(node => node.file === join(w.root, "src/dir/index.ts"))); assert.equal(w.status(), status);
  const reverse = await dependencies(w.args("dependencies", { file: "src/b.ts", reverse: true, depth: 2 }));
  assert.equal(reverse.data.direction, "in"); assert.ok(list(reverse.data.edges).some(edge => edge.specifier === "./b.js"));
});

test("analysis dependencies: JavaScript require/import literals exclude computed names and comments", async () => {
  const w = project({ "a.cjs": 'const b=require("./b.cjs");\nrequire(name);\nconst txt="require(\'./ghost\')";\n', "b.cjs": "module.exports=42;\n" });
  const result = await dependencies(w.args("dependencies", { file: "a.cjs" })); assert.equal(result.data.totalEdges, 1); assert.equal(list(result.data.edges)[0].kind, "dynamic-import");
});

test("analysis dependencies: Python absolute/relative packages and external imports resolve without import execution", async () => {
  const w = project({ "pkg/__init__.py": "", "pkg/a.py": "from .b import value\nfrom ..other import name\nimport json, pkg.b as other\ns='import missing'\n", "pkg/b.py": "value=1\n", "other.py": "name=2\n" });
  const result = await dependencies(w.args("dependencies", { file: "pkg/a.py", depth: 2 }));
  const edges = list(result.data.edges); assert.equal(edges.length, 4); assert.equal(edges.filter(edge => edge.status === "internal").length, 3);
  assert.ok(list(result.data.nodes).some(node => node.file === join(w.root, "pkg/b.py"))); assert.ok(edges.some(edge => edge.specifier === "json" && edge.status === "external"));
});

test("analysis dependencies: Python from-dot imports resolve named sibling modules", async () => {
  const w = project({ "pkg/__init__.py": "", "pkg/a.py": "from . import b\n", "pkg/b.py": "value=1\n" });
  const result = await dependencies(w.args("dependencies", { file: "pkg/a.py" })); assert.equal(result.code, 0); assert.equal(list(result.data.edges)[0].specifier, ".b");
  assert.ok(list(result.data.nodes).some(node => node.file === join(w.root, "pkg/b.py")));
});

test("analysis dependencies: Python from-package members prefer submodules and otherwise use package init", async () => {
  const w = project({ "pkg/__init__.py": "class Field: pass\n", "pkg/a.py": "from . import Field, sibling\n", "pkg/sibling.py": "value=1\n" });
  const result = await dependencies(w.args("dependencies", { file: "pkg/a.py" }));
  assert.equal(result.code, 0); const edges = list(result.data.edges), nodes = list(result.data.nodes);
  assert.equal(nodes.find(node => node.id === edges.find(edge => edge.specifier === ".Field")!.to)!.file, join(w.root, "pkg/__init__.py"));
  assert.equal(nodes.find(node => node.id === edges.find(edge => edge.specifier === ".sibling")!.to)!.file, join(w.root, "pkg/sibling.py"));
  assert.ok(edges.every(edge => edge.status === "internal"));
});

for (const language of ["python", "rust", "typescript"]) test(`analysis reverse: ${language} late importers survive large unrelated inventories and AST rejects doc examples`, async () => {
  const ext = language === "python" ? ".py" : language === "rust" ? ".rs" : ".ts", files: Record<string, string> = {};
  for (let index = 0; index < 215; index++) files[`aaa_noise/${String(index).padStart(3, "0")}${ext}`] = language === "python" ? '# from zpkg.target import Thing\ndoc = """\nfrom zpkg.target import Thing\n"""\n' : language === "rust" ? '// use crate::target::Thing;\nconst DOC: &str = r#"\nuse crate::target::Thing;\n"#;\n' : '// import { Thing } from "../zpkg/target";\nconst doc = `\nimport { Thing } from "../zpkg/target";\n`;\n';
  let target: string, consumer: string;
  if (language === "python") {
    Object.assign(files, { "zpkg/__init__.py": "", "zpkg/target.py": "from .one import Thing\n", "zpkg/one.py": "from .target import Thing\n", "zpkg/barrel.py": "from .target import Thing\n", "zzconsumer.py": "from zpkg.barrel import Thing\n" }); target = "zpkg/target.py"; consumer = "zzconsumer.py";
  } else if (language === "rust") {
    Object.assign(files, { "Cargo.toml": '[package]\nname="probe"\nversion="0.1.0"\n', "src/lib.rs": "pub mod target;\npub mod barrel;\npub mod consumer;\n", "src/target.rs": "use crate::consumer::Thing;\npub struct Thing;\n", "src/barrel.rs": "pub use crate::target::Thing;\n", "src/consumer.rs": "pub use crate::barrel::Thing;\n" }); target = "src/target.rs"; consumer = "src/consumer.rs";
  } else {
    Object.assign(files, { "zpkg/target.ts": 'import "./one.js";\nexport class Thing {}\n', "zpkg/one.ts": 'import {Thing} from "./target.js";\n', "zpkg/index.ts": 'export {Thing} from "./target.js";\n', "zzconsumer.ts": 'import {Thing} from "./zpkg/index.js";\n' }); target = "zpkg/target.ts"; consumer = "zzconsumer.ts";
  }
  const w = project(files), status = w.status(), result = await dependencies(w.args("dependencies", { file: target, reverse: true, depth: 3 }));
  assert.equal(result.code, 0, JSON.stringify(result.data.errors)); assert.equal(result.data.complete, true); assert.equal(result.data.bounded, false);
  assert.ok(Number(result.data.inventoryFiles) > 200); assert.ok(Number(result.data.prefilteredFiles) > 200); assert.ok(Number(result.data.candidateFiles) <= 5); assert.ok(Number(result.data.scannedFiles) <= 5);
  assert.ok(list(result.data.nodes).some(node => node.file === join(w.root, consumer))); assert.equal(list(result.data.nodes).some(node => String(node.file).includes("aaa_noise")), false);
  assert.ok(list(result.data.edges).length >= 3); assert.ok(Number(result.data.readBytes) <= Number(result.data.maximumReadBytes)); assert.equal(w.status(), status);
});

test("analysis reverse: actual AST candidates are capped after filtering with actionable partial metadata", async () => {
  const files: Record<string, string> = { "target.py": "class Thing: pass\n" };
  for (let index = 0; index < 203; index++) files[`uses_${String(index).padStart(3, "0")}.py`] = "from target import Thing\n";
  const w = project(files), result = await dependencies(w.args("dependencies", { file: "target.py", reverse: true, depth: 1, timeout: 30000 }));
  assert.equal(result.code, 0); assert.equal(result.data.candidateFiles, 203); assert.equal(result.data.scannedFiles, 200); assert.equal(result.data.complete, false); assert.equal(result.data.bounded, true);
  assert.match(String(result.data.hint), /--cwd PACKAGE_DIRECTORY/); assert.ok(Number(result.data.readBytes) <= Number(result.data.maximumReadBytes));
});

test("analysis reverse: package cwd narrows the inventory while keeping root-relative resolution", async () => {
  const w = project({ "pkg/__init__.py": "", "pkg/target.py": "class Thing: pass\n", "pkg/use.py": "from pkg.target import Thing\n", "outside.py": "from pkg.target import Thing\n" });
  const result = await dependencies({ ...w.args("dependencies", { reverse: true, depth: 1 }), cwd: join(w.root, "pkg"), file: "target.py" });
  assert.equal(result.code, 0); assert.equal(result.data.scope, join(w.root, "pkg")); assert.ok(list(result.data.nodes).some(node => node.file === join(w.root, "pkg/use.py"))); assert.equal(list(result.data.nodes).some(node => node.file === join(w.root, "outside.py")), false);
});

test("analysis dependencies: Rust grouped use, self/super/crate, modules and re-exports resolve file paths", async () => {
  const w = project({ "Cargo.toml": '[package]\nname="probe"\nversion="0.1.0"\n', "src/lib.rs": "pub mod foo;\nuse crate::{foo::{Bar, baz}, other as alias};\npub use self::foo::*;\nuse std::fmt;\n", "src/foo.rs": "use super::other::Thing;\npub mod child;\npub struct Bar;\npub fn baz(){}\n", "src/foo/child.rs": "pub fn child(){}\n", "src/other.rs": "pub struct Thing;\n" });
  const result = await dependencies(w.args("dependencies", { file: "src/lib.rs", depth: 3 }));
  assert.equal(result.code, 0); const edges = list(result.data.edges), nodes = list(result.data.nodes);
  assert.ok(edges.some(edge => edge.specifier === "crate::foo::Bar" && edge.status === "internal")); assert.ok(edges.some(edge => edge.specifier === "crate::other" && edge.status === "internal"));
  assert.ok(edges.some(edge => edge.kind === "re-export")); assert.ok(edges.some(edge => edge.specifier === "std::fmt" && edge.status === "external"));
  assert.ok(nodes.some(node => node.file === join(w.root, "src/foo/child.rs"))); assert.ok(nodes.some(node => node.file === join(w.root, "src/other.rs")));
});

test("analysis dependencies: unresolved paths, symlinks and nested repositories stay outside graph file nodes", async () => {
  const w = project({ "a.ts": 'import "./missing";\nimport "./linked";\nimport "./nested/other";\n' }), outside = project({ "outside.ts": "export const value=1;\n" });
  symlinkSync(join(outside.root, "outside.ts"), join(w.root, "linked.ts")); w.put("nested/other.ts", "export const value=1;\n"); mkdirSync(join(w.root, "nested/.git"));
  const result = await dependencies(w.args("dependencies", { file: "a.ts" }));
  assert.equal(result.data.totalEdges, 3); assert.ok(list(result.data.edges).every(edge => edge.status === "unresolved")); assert.equal(list(result.data.nodes).filter(node => node.status === "internal").length, 1);
});

test("analysis dependencies: result limits retain counts and depth stops expansion", async () => {
  const w = project({ "a.ts": 'import "./b";\nimport "./c";\n', "b.ts": 'import "./d";\n', "c.ts": "", "d.ts": "" });
  const result = await dependencies(w.args("dependencies", { file: "a.ts", depth: 1, limit: 1 }));
  assert.equal(result.data.totalEdges, 2); assert.equal(result.data.shownEdges, 1); assert.equal(result.data.truncated, true); assert.equal(result.data.scannedFiles, 1);
  await assert.rejects(dependencies(w.args("dependencies", { file: "a.ts", depth: 11 })), /1-10/); await assert.rejects(dependencies(w.args("dependencies", { file: "a.ts", apply: true })), /read-only/);
});

test("analysis dependencies: large external fan-out is bounded by node count with explicit partial state", async () => {
  const w = project({ "a.ts": Array.from({ length: 230 }, (_, index) => `import "package-${index}";`).join("\n") });
  const result = await dependencies(w.args("dependencies", { file: "a.ts" }));
  assert.equal(result.data.bounded, true); assert.equal(result.data.complete, false); assert.equal(list(result.data.nodes).length, 200); assert.equal(result.data.totalEdges, 199);
});

test("analysis instrumentation: native parser stdin and temporary cwd preserve source/index and reap processes", async () => {
  const w = project({ "a.ts": 'import "./b";\n', "b.ts": "export const 中文=1;\n" }), trace = wrapper(w.root, "trace"), status = w.status();
  const result = await dependencies(w.args("dependencies", { file: "a.ts", depth: 2 })); assert.equal(result.code, 0);
  for (const event of trace()) { assert.notEqual(event.cwd, w.root); assert.ok((event.argv as string[]).includes("--stdin")); assert.throws(() => process.kill(Number(event.pid), 0)); }
  assert.equal(w.status(), status); assert.equal(readFileSync(join(w.root, "a.ts"), "utf8"), 'import "./b";\n');
});

test("analysis instrumentation: malformed native ranges fail with file evidence", async () => {
  const w = project({ "a.ts": 'import "./b";\n' }); wrapper(w.root, "malformed");
  const result = await dependencies(w.args("dependencies", { file: "a.ts" })); assert.equal(result.code, 1); assert.equal(result.data.complete, false); assert.match(String(list(result.data.errors)[0].error), /source range/);
});

test("analysis instrumentation: concurrent edits discard dependency and API results while preserving external text", async () => {
  const w = project({ "a.ts": "export function greet() { return 1; }\n" }); w.put("a.ts", "export function greet(x: number) { return x; }\n"); wrapper(w.root, "mutate", join(w.root, "a.ts"));
  await assert.rejects(dependencies(w.args("dependencies", { file: "a.ts" })), /Source changed/); assert.equal(readFileSync(join(w.root, "a.ts"), "utf8"), "external edit\n");
  w.put("a.ts", "export function greet(x: number) { return x; }\n"); await assert.rejects(apiDiff(w.args("api-diff", { base: "HEAD" })), /Source changed/);
});

test("analysis instrumentation: parser deadline terminates child and returns bounded partial state", async () => {
  const w = project({ "a.ts": 'import "./b";\n' }), trace = wrapper(w.root, "timeout");
  const started = Date.now(), result = await dependencies(w.args("dependencies", { file: "a.ts", timeout: 120 }));
  assert.equal(result.code, 1); assert.equal(result.data.bounded, true); assert.ok(Date.now() - started < 3000);
  if (existsSync(join(w.root, ".git/ast-trace.jsonl"))) for (const event of trace()) assert.throws(() => process.kill(Number(event.pid), 0));
});

test("analysis: missing ast-grep has executable installation guidance and unsupported languages stay explicit", async () => {
  const w = project({ "a.ts": "export const value=1;\n", "source.go": "package source\n" }); const old = process.env.PATH;
  try { process.env.PATH = ""; const result = await dependencies(w.args("dependencies", { file: "a.ts" })); assert.equal(result.code, 1); assert.match(String(list(result.data.errors)[0].error), /npm install --global @ast-grep\/cli/); }
  finally { process.env.PATH = old; }
  const result = await dependencies(w.args("dependencies", { file: "source.go" })); assert.equal(result.code, 1); assert.match(String(list(result.data.errors)[0].error), /Unsupported analysis language/);
});
