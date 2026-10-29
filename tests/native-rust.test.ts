import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseOptions } from "../src/cli.ts";
import { outputData, run, type Session } from "../src/commands.ts";
import { LspClient } from "../src/client.ts";
import { rustBackend } from "../src/rust-api.ts";
import { object, type ObjectValue } from "../src/config.ts";

let available = true;
try { rustBackend(parseOptions(["setup", "rust-types"])); } catch { available = false; }
const native = {skip: available ? false : "Install codex-lsp-rust-types to run the real native Rust API tests"};
const roots:string[]=[];
afterEach(async()=>{const active=LspClient.active.size;await Promise.all([...LspClient.active].map(client=>client.close()));for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});assert.equal(active,0);});
function fixture(text:string) {
  const root=mkdtempSync(join(tmpdir(),"codex-lsp native Rust "));roots.push(root);mkdirSync(join(root,"src"));mkdirSync(join(root,".codex"));
  const file=join(root,"src/lib.rs");writeFileSync(file,text);
  writeFileSync(join(root,"Cargo.toml"),'[package]\nname="codex-lsp-native-test"\nversion="0.1.0"\nedition="2021"\n[features]\nselected=[]\n');
  writeFileSync(join(root,".codex/lsp.json"),JSON.stringify({servers:{"rust-analyzer":{settings:{"rust-analyzer":{cargo:{features:[],noDefaultFeatures:false}}}}}}));
  execFileSync("cargo",["generate-lockfile","--offline"],{cwd:root,stdio:"pipe"});
  execFileSync("git",["init","--quiet"],{cwd:root,stdio:"pipe"});execFileSync("git",["add","Cargo.toml","Cargo.lock","src/lib.rs",".codex/lsp.json"],{cwd:root,stdio:"pipe"});
  const index=()=>createHash("sha256").update(readFileSync(join(root,".git/index"))).digest("hex"),before=index();
  const pool:Session={clients:new Map(),diagnostics:false};
  const query=(needle:string,view="computed",range=false)=>{
    const source=readFileSync(file,"utf8"),at=source.lastIndexOf(needle);assert(at>=0,needle);
    const point=(offset:number)=>{const prefix=source.slice(0,offset),lines=prefix.split("\n");return`${lines.length}:${lines.at(-1)!.length+1}`;};
    return {...parseOptions(["types","--file",file,"--view",view,...(range?["--range",`${point(at)}-${point(at+needle.length)}`]:["--line",point(at).split(":")[0],"--column",point(at).split(":")[1]])],root),timeout:30000};
  };
  const close=async()=>{await Promise.all([...pool.clients.values()].map(client=>client.close()));assert.equal(index(),before);};
  return{root,file,pool,query,close,index,before};
}

test("native Rust: original/declared/expected types and adjusted references come from one real Cargo database",native,async()=>{
  const text='fn consume(value: &str) -> usize { value.len() }\nfn identity<T>(value: T) -> T { value }\npub fn example() -> usize {\n let text: String = String::from("ok");\n consume(&text)\n}\npub fn generic() -> u32 { identity(42u32) }\nmacro_rules! item { ($($item:item)*) => {$($item)*} }\nitem! { pub fn wrapped(value:u8) -> u8 { value } }\n';
  const w=fixture(text);
  try{
    const computed=await run(w.query("text"),w.pool),declared=await run(w.query("text","declared"),w.pool),expected=await run(w.query("&text","expected",true),w.pool),reference=await run(w.query("&text","computed",true),w.pool);
    assert.equal(computed.data.summary,"String");assert.equal(declared.data.summary,"String");assert.equal(declared.data.declarationSource,"annotation");
    assert.equal(expected.data.summary,"&str");assert.equal(expected.data.expectedSource,"argument");assert.equal(reference.data.summary,"&String");assert.equal(object(reference.data.type).adjusted,"&str");
    const generic=await run(w.query("42u32","expected",true),w.pool);assert.equal(generic.data.summary,"u32");
    const macro=await run({...parseOptions(["types","--file",w.file,"--symbol","wrapped","--view","declared"],w.root),timeout:30000},w.pool);
    assert.equal(macro.data.found,true);assert.equal(object((object(macro.data.type).signatures as ObjectValue[])[0]).returns,"u8");
    assert.equal(w.pool.clients.size,1);assert.equal(expected.data.reloaded,false);assert.equal(expected.data.incomplete,false);assert.equal(object(expected.data.analysis).procMacros,false);
    const summary=outputData(expected.data,{fields:["summary"],budget:700});assert.equal(summary.provider,"rust-analyzer-api");assert.equal(summary.summary,"&str");assert.equal(readFileSync(w.file,"utf8"),text);
  }finally{await w.close();}
});

test("native Rust: warm dependency changes with preserved mtime and new module creation invalidate the semantic snapshot",native,async()=>{
  const w=fixture('mod dependency;\nmod newly_added;\npub fn example(){ let output = dependency::value(); let extra = newly_added::value(); }\n'),dependency=join(w.root,"src/dependency.rs");writeFileSync(dependency,'pub fn value() -> u32 { 1 }\n');
  mkdirSync(join(w.root,"src/newly_added"));
  try{
    const args=w.query("output"),first=await run(args,w.pool);assert.equal(first.data.summary,"u32");assert.equal((await run(args,w.pool)).data.reloaded,false);
    const time=statSync(dependency);writeFileSync(dependency,'pub fn value() -> u64 { 1 }\n');utimesSync(dependency,time.atime,time.mtime);
    const changed=await run(args,w.pool);assert.equal(changed.data.summary,"u64");assert.equal(changed.data.reloaded,true);assert(Number(changed.data.snapshot)>Number(first.data.snapshot));
    assert.equal((await run(w.query("extra"),w.pool)).data.found,false);
    writeFileSync(join(w.root,"src/newly_added/mod.rs"),'pub fn value() -> u16 { 1 }\n');assert.equal((await run(w.query("extra"),w.pool)).data.summary,"u16");
  }finally{await w.close();}
});

test("native Rust: Cargo feature selection and empty contexts stay explicit without mutating configuration or the Git index",native,async()=>{
  const w=fixture('#[cfg(feature="selected")]\npub fn selected() -> u64 { 1 }\npub fn example() { let output = 1u32 as u64; }\n');
  try{
    const empty=await run(w.query("1u32","expected",true),w.pool);assert.equal(empty.data.found,false);assert.match(String(empty.data.hint),/No expected type/);
    const path=join(w.root,".codex/lsp.json"),config={servers:{"rust-analyzer":{settings:{"rust-analyzer":{cargo:{features:["selected"],noDefaultFeatures:true}}}}}};writeFileSync(path,JSON.stringify(config));
    const enabled=await run(w.query("selected"),w.pool);assert.equal(enabled.data.found,true);assert.deepEqual(object(enabled.data.analysis).features,["selected"]);assert.equal(readFileSync(path,"utf8"),JSON.stringify(config));
    writeFileSync(path,JSON.stringify({servers:{"rust-analyzer":{settings:{"rust-analyzer":{cargo:{features:[]}}}}}}));
    writeFileSync(join(w.root,"Cargo.toml"),readFileSync(join(w.root,"Cargo.toml"),"utf8")+'\n[workspace]\nexclude=["excluded"]\n');
    const nested=join(w.root,"excluded");mkdirSync(join(nested,"src"),{recursive:true});writeFileSync(join(nested,"Cargo.toml"),'[package]\nname="excluded"\nversion="0.1.0"\nedition="2021"\n');
    const file=join(nested,"src/lib.rs");writeFileSync(file,"pub const VALUE: u16 = 1;\n");execFileSync("cargo",["generate-lockfile","--offline"],{cwd:nested,stdio:"pipe"});
    const excluded=await run({...parseOptions(["types","--file",file,"--line","1","--symbol","VALUE"],w.root),timeout:30000},w.pool);assert.equal(excluded.data.summary,"u16");
  }finally{await w.close();}
});

test("native Rust: BOM, CRLF and astral Unicode retain exact UTF-16 anchors and source-bound handles",native,async()=>{
  const w=fixture('\uFEFFpub const VALUE: u32 = 1;\r\npub fn read() -> u32 { /* 😀 */ VALUE }\r\n');
  try{
    const result=await run({...w.query("VALUE"),targets:true},w.pool);assert.equal(result.data.summary,"u32");assert.equal((result.data.targets as ObjectValue[]).length,1);
    const target=String((result.data.targets as ObjectValue[])[0].id),next=await run({...parseOptions(["types","--target",target,"--view","declared"],w.root),timeout:30000},w.pool);assert.equal(next.data.summary,"u32");
    const first=await run({...parseOptions(["types","--file",w.file,"--line","1","--symbol","VALUE"],w.root),timeout:30000},w.pool);assert.equal(first.data.summary,"u32");
  }finally{await w.close();}
});
