import assert from "node:assert/strict";
import { after, afterEach, before, mock, test } from "node:test";
import { readFileSync, writeFileSync, mkdirSync, realpathSync, symlinkSync, statSync, utimesSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { parseOptions } from "../src/cli.ts";
import { outputData, run, type Options, type Session } from "../src/commands.ts";
import { object, type ObjectValue } from "../src/config.ts";
import { LspClient } from "../src/client.ts";
import { cleanWorkspaces, isolateGlobalConfig, workspace } from "./fixtures/workspace.ts";
import { typescriptCompiler } from "../src/typescript-api.ts";
import { stdioSession } from "../src/session.ts";

let restore: () => void;
before(() => { restore = isolateGlobalConfig(); }); after(() => restore());
afterEach(async () => { mock.restoreAll(); const active=LspClient.active.size; await Promise.all([...LspClient.active].map(client=>client.close())); cleanWorkspaces(); assert.equal(active,0); });
const compiler=realpathSync(createRequire(import.meta.url).resolve("typescript"));
const compiler7=realpathSync(createRequire(import.meta.url).resolve("typescript7"));
const source='function consume(value: string | number): void {}\nfunction example(value: string | number) {\n  if (typeof value === "string") {\n    consume(value)\n  }\n}\n';
function fixture(text=source, options: ObjectValue={strict:true,target:"ES2022"}, selectedCompiler=compiler) {
  const w=workspace(), file=join(w.root,"app.ts");
  mkdirSync(join(w.root,"node_modules"));symlinkSync(dirname(dirname(selectedCompiler)),join(w.root,"node_modules/typescript"),process.platform==="win32"?"junction":"dir");
  writeFileSync(file,text);writeFileSync(join(w.root,"tsconfig.json"),JSON.stringify({compilerOptions:options,include:["*.ts","*.tsx","*.mts","*.cts","*.js"]}));
  const args=(flags: string[]=[],extra: Partial<Options>={}): Options=>({...parseOptions(["types","--file",file,"--line","4","--symbol","value",...flags],w.root),timeout:10000,...extra});
  const pool: Session={clients:new Map(),diagnostics:false};
  const close=()=>Promise.all([...pool.clients.values()].map(client=>client.close()));
  return {...w,file,args,pool,close};
}

test("TypeScript types: computed flow type, original annotation and contextual expected type share one worker",async()=>{
  const w=fixture(); let starts=0; const start=LspClient.start;mock.method(LspClient,"start",async(...args:Parameters<typeof LspClient.start>)=>{starts++;return start(...args);});
  try {
    const computed=await run(w.args(),w.pool),declared=await run(w.args(["--view","declared"]),w.pool),expected=await run(w.args(["--view","expected"]),w.pool);
    assert.equal(computed.data.summary,"string");assert.equal(declared.data.summary,"string | number");assert.equal(expected.data.summary,"string | number");
    assert.equal(declared.data.declarationSource,"annotation");assert.equal(computed.data.provider,"typescript-api");assert.equal(computed.data.compilerPath,compiler);assert.equal(computed.data.tsconfig,join(w.root,"tsconfig.json"));assert.equal(starts,1);
    assert.deepEqual(object(computed.data.cursor),{line:4,column:13});assert.deepEqual(object(expected.data.type).union,["string","number"]);assert.equal(readFileSync(w.file,"utf8"),source);
  }finally{await w.close();}
});

test("TypeScript types: full expression ranges, aliases, generic functions and structured members preserve semantic identity",async()=>{
  const text='type Box = { name: string; count?: number };\nconst box: Box = { name: "ok" };\nfunction identity<T>(value: T): T { return value; }\nconst result = identity(box);\n';
  const w=fixture(text);
  try {
    const range=await run(w.args([], {line:4,column:undefined,symbol:undefined,range:{start:{line:3,character:15},end:{line:3,character:28}}}),w.pool);assert.equal(range.data.summary,"Box");
    const variable=await run(w.args([], {line:2,symbol:"box"}),w.pool);const detail=object(variable.data.type);assert.deepEqual((detail.properties as ObjectValue[]).map(row=>[row.name,row.optional]),[["name",false],["count",true]]);
    const fn=await run(w.args([], {line:3,symbol:"identity"}),w.pool);assert.match(String(fn.data.summary),/<T>/);assert.equal((object(fn.data.type).signatures as unknown[]).length,1);
    const alias=await run(w.args(["--view","declared"],{line:1,symbol:"Box"}),w.pool);assert.equal(alias.data.declarationSource,"type-definition");assert.equal(alias.data.found,true);
  }finally{await w.close();}
});

test("TypeScript types: batches share compiler state and JSON field selection keeps compiler/view metadata",async()=>{
  const w=fixture(),input=join(w.root,"queries.jsonl");writeFileSync(input,["computed","declared","expected"].map(view=>JSON.stringify({command:"types",file:w.file,line:4,symbol:"value",view,fields:"summary"})).join("\n"));
  const result=await run({...parseOptions(["batch","--input",input],w.root),timeout:10000});assert.equal(result.data.failed,0);const rows=result.data.results as ObjectValue[];assert.equal(rows.length,3);assert(rows.every(row=>row.provider==="typescript-api"&&typeof row.compilerVersion==="string"));
});

test("TypeScript types: dependency contents invalidate cached types even with unchanged mtime, after repeated warm queries",async()=>{
  const w=fixture('import { value } from "./dependency";\nconst result = value;\n');const dependency=join(w.root,"dependency.ts");writeFileSync(dependency,'export const value: string = "ok";\n');
  const args=w.args([],{line:2,symbol:"result"});
  try {assert.equal((await run(args,w.pool)).data.summary,"string");assert.equal((await run(args,w.pool)).data.summary,"string");const time=statSync(dependency);writeFileSync(dependency,'export const value: number = 1;\n');utimesSync(dependency,time.atime,time.mtime);assert.equal((await run(args,w.pool)).data.summary,"number");}finally{await w.close();}
});

test("TypeScript types: a newly created missing module and changed compiler options reconfigure a warm worker",async()=>{
  const w=fixture('import { value } from "./new-module";\nconst result = value;\n');const args=w.args([],{line:2,symbol:"result"});
  try {assert.equal((await run(args,w.pool)).data.summary,"any");writeFileSync(join(w.root,"new-module.ts"),'export const value = 42;\n');assert.equal((await run(args,w.pool)).data.summary,"42");writeFileSync(join(w.root,"tsconfig.json"),JSON.stringify({compilerOptions:{strict:true,noResolve:true},files:["app.ts"]}));assert.equal((await run(args,w.pool)).data.summary,"any");}finally{await w.close();}
});

test("TypeScript types: comments, blank source and absent contextual types return honest empty results",async()=>{
  const w=fixture('// comment\n\nconst value = 1;\n');
  try {const comment=await run(w.args([],{line:1,column:4,symbol:undefined}),w.pool);assert.equal(comment.data.found,false);const expected=await run(w.args(["--view","expected"],{line:3,symbol:"value"}),w.pool);assert.equal(expected.data.found,false);assert.equal(expected.data.success,true);assert.equal(expected.data.type,null);}finally{await w.close();}
});

test("TypeScript types: invalid/excluded configs fail explicitly instead of silently choosing different compiler options",async()=>{
  const w=fixture();writeFileSync(join(w.root,"tsconfig.json"),'{"compilerOptions":{"strict":"wrong"}}');await assert.rejects(run(w.args()),/Invalid tsconfig/);
  writeFileSync(join(w.root,"tsconfig.json"),JSON.stringify({compilerOptions:{strict:true},files:[]}));await assert.rejects(run(w.args()),/outside the selected TypeScript project|files.*empty/i);
});

test("TypeScript types: bounds, readonly enforcement and source changes fail without editing source or Git index",async()=>{
  const w=fixture();execFileSync("git",["init","--quiet",w.root]);execFileSync("git",["-C",w.root,"add","app.ts","tsconfig.json"]);const index=readFileSync(join(w.root,".git/index"));
  await assert.rejects(run(w.args(["--apply"])),/read-only/);await assert.rejects(run(w.args([],{column:999,symbol:undefined})),/Column/);
  const request=LspClient.prototype.request;mock.method(LspClient.prototype,"request",async function(this:LspClient,...args:Parameters<typeof request>){const result=await request.apply(this,args);if(args[0]==="codex/types")writeFileSync(w.file,source+"// external edit\n");return result;});
  await assert.rejects(run(w.args()),/Source changed/);assert.equal(readFileSync(w.file,"utf8"),source+"// external edit\n");assert.deepEqual(readFileSync(join(w.root,".git/index")),index);
});

test("TypeScript types: missing compiler gives toolchain guidance and no language server is required",async()=>{
  const w=fixture();assert.equal(typescriptCompiler(w.file,w.args()),compiler);
  const old=process.env.PATH;process.env.PATH="";try{assert.throws(()=>typescriptCompiler(w.file,w.args([],{globalBinsOnly:true})),/npm install --global typescript/);}finally{if(old===undefined)delete process.env.PATH;else process.env.PATH=old;}
  assert.equal((await run(w.args())).data.success,true);
});

test("TypeScript types: JSON budgets omit complete structured types and leave honest summary/preview state",async()=>{
  const w=fixture('const object = { '+Array.from({length:100},(_,i)=>'field'+i+': '+i).join(', ')+' };\n');const result=await run(w.args([],{line:1,symbol:"object"}));
  const bounded=outputData(result.data,{fields:["summary"],budget:512});assert(JSON.stringify(bounded).length<=512);assert.equal(bounded.compilerVersion,result.data.compilerVersion);
  const graph=outputData(result.data,{budget:1200});assert.equal(graph.typeOmitted,true);assert.equal(graph.type,undefined);assert.equal(graph.truncated,true);assert.equal((object(result.data.type).properties as unknown[]).length,50);
});

test("TypeScript types: .mts/.cts/.tsx and checked JavaScript select their actual language/config",async()=>{
  const w=fixture();writeFileSync(join(w.root,"tsconfig.json"),JSON.stringify({compilerOptions:{strict:true,allowJs:true,checkJs:true,jsx:"preserve"},include:["*.ts","*.tsx","*.mts","*.cts","*.js"]}));
  try {for(const [suffix,text,line,symbol,expected]of [["mts","export const value: number = 1;",1,"value","number"],["cts","export const value: number = 1;",1,"value","number"],["tsx","const value: number = 1;",1,"value","number"],["js","/** @type {number} */\nconst value = 1;",2,"value","number"]]as const){const file=join(w.root,"file-"+suffix+"."+suffix);writeFileSync(file,text);assert.equal((await run(w.args([],{file,line,symbol}),w.pool)).data.summary,expected);}}finally{await w.close();}
});

test("TypeScript worker: instrumented compiler hang times out, reaps its process and preserves source",async()=>{
  const w=fixture(),packageRoot=join(w.root,"node_modules/typescript");rmSync(packageRoot,{recursive:true,force:true});mkdirSync(packageRoot);writeFileSync(join(packageRoot,"package.json"),'{"main":"index.js"}');
  writeFileSync(join(packageRoot,"index.js"),'const api=require('+JSON.stringify(compiler)+'); module.exports={...api,createLanguageService(host){const service=api.createLanguageService(host),getProgram=service.getProgram;service.getProgram=()=>{const program=getProgram();program.getTypeChecker().getTypeAtLocation=()=>{throw Object.assign(new Error("denied by compiler"),{code:"EACCES"})};return program;};return service;}};');
  await assert.rejects(run(w.args()),error=>object(error).code===-32603&&/denied by compiler/.test(String(error)));
  writeFileSync(join(packageRoot,"index.js"),'const api=require('+JSON.stringify(compiler)+'); module.exports={...api,createLanguageService(host){const service=api.createLanguageService(host),getProgram=service.getProgram;service.getProgram=()=>{const program=getProgram();program.getTypeChecker().getTypeAtLocation=()=>{while(true){}};return program;};return service;}};');
  let pid:number|undefined;const start=LspClient.start;mock.method(LspClient,"start",async(...args:Parameters<typeof LspClient.start>)=>{const client=await start(...args);pid=client.proc.pid;return client;});
  await assert.rejects(run(w.args([],{timeout:1500})),/timed out/);assert(pid);assert.throws(()=>process.kill(pid!,0));assert.equal(readFileSync(w.file,"utf8"),source);
});

test("TypeScript session: an instrumented worker crash preserves later answers and reaps both compiler processes",async()=>{
  for(const selected of [compiler,compiler7]){
    const w=fixture(source,{strict:true},selected), rows:ObjectValue[]=[], pids:number[]=[];
    const start=LspClient.start, request=LspClient.prototype.request;let queries=0;
    const starts=mock.method(LspClient,"start",async(...args:Parameters<typeof LspClient.start>)=>{const client=await start(...args);pids.push(client.proc.pid!);return client;});
    const requests=mock.method(LspClient.prototype,"request",function(this:LspClient,...args:Parameters<typeof request>){
      if(args[0]==="codex/types"&&++queries===2)this.proc.kill("SIGKILL");
      return request.apply(this,args);
    });
    try{
      const input=Readable.from([1,2,3].map(id=>JSON.stringify({id,command:"types",file:w.file,line:4,symbol:"value",fields:"summary"})+"\n").concat('{"command":"close"}\n'));
      const output=new Writable({write(chunk,_encoding,callback){rows.push(JSON.parse(String(chunk)));callback();}});
      assert.equal(await stdioSession({...parseOptions(["session","--stdio"],w.root),timeout:10000},input,output),1);
      assert.deepEqual(rows.map(row=>row.code),[0,2,0,0]);assert.deepEqual(rows.map(row=>row.id),[1,2,3,4]);
      assert.equal(rows[0].summary,"string");assert.equal(rows[2].summary,"string");assert.equal(rows[3].closed,true);
      assert.equal(pids.length,2);for(const pid of pids)assert.throws(()=>process.kill(pid,0));
      assert.equal(LspClient.active.size,0);assert.equal(readFileSync(w.file,"utf8"),source);
    }finally{requests.mock.restore();starts.mock.restore();await w.close();}
  }
});

test("TypeScript worker: a dependency edit injected during analysis retries instead of returning its stale type",async()=>{
  const text='import { value } from "./dependency";\nconst result = value;\n',w=fixture(text),dependency=join(w.root,"dependency.ts");
  writeFileSync(dependency,'export const value: string = "ok";\n');
  const packageRoot=join(w.root,"node_modules/typescript");rmSync(packageRoot,{recursive:true,force:true});mkdirSync(packageRoot);
  writeFileSync(join(packageRoot,"package.json"),'{"main":"index.js"}');
  writeFileSync(join(packageRoot,"index.js"),'const fs=require("node:fs"),api=require('+JSON.stringify(compiler)+');let changed=false;module.exports={...api,createLanguageService(host){const service=api.createLanguageService(host),getProgram=service.getProgram;service.getProgram=()=>{const program=getProgram(),checker=program.getTypeChecker(),getType=checker.getTypeAtLocation;checker.getTypeAtLocation=function(node){const type=getType.call(this,node);if(!changed){changed=true;fs.writeFileSync('+JSON.stringify(dependency)+',"export const value: number = 1;\\n")}return type;};return program;};return service;}};');
  const result=await run(w.args([],{line:2,symbol:"result"}));
  assert.equal(result.data.summary,"number");assert.equal(result.data.found,true);assert.equal(readFileSync(w.file,"utf8"),text);
});

test("TypeScript 7 native API: three views, declaration handles, unions and generic signatures use the project's native checker",async()=>{
  const w=fixture(source,{strict:true,target:"ES2022"},compiler7);
  try {
    const computed=await run(w.args(),w.pool),declared=await run(w.args(["--view","declared"]),w.pool),expected=await run(w.args(["--view","expected"]),w.pool);
    assert.equal(computed.data.summary,"string");assert.equal(declared.data.summary,"string | number");assert.equal(expected.data.summary,"string | number");assert.equal(computed.data.compilerVersion,"7.0.2");assert.equal(computed.data.compilerPath,compiler7);assert.equal(declared.data.declarationSource,"annotation");assert.deepEqual(object(expected.data.type).union,["string","number"]);
    const fn=await run(w.args([],{line:1,symbol:"consume"}),w.pool);assert.equal((object(fn.data.type).signatures as ObjectValue[])[0].returns,"void");
    const declaration=await run(w.args(["--view","declared"],{line:1,symbol:"consume"}),w.pool);assert.match(String(declaration.data.summary),/\(value: string \| number\) => void/);
    const model=join(w.root,"model.ts");writeFileSync(model,'interface Model { value: string | number }\n');const property=await run(w.args(["--view","declared"],{file:model,line:1,symbol:"value"}),w.pool);assert.equal(property.data.summary,"string | number");
    assert.equal(w.pool.clients.size,1);assert.equal(readFileSync(w.file,"utf8"),source);
  }finally{await w.close();}
});

test("TypeScript 7 native snapshots: dependency edits and missing-module creation refresh warm state",async()=>{
  const w=fixture('import { value } from "./dependency";\nconst result = value;\n',{strict:true},compiler7),dependency=join(w.root,"dependency.ts");
  const args=w.args([],{line:2,symbol:"result"});
  try {
    assert.equal((await run(args,w.pool)).data.summary,"any");writeFileSync(dependency,'export const value: string = "ok";\n');assert.equal((await run(args,w.pool)).data.summary,"string");
    const time=statSync(dependency);writeFileSync(dependency,'export const value: number = 1;\n');utimesSync(dependency,time.atime,time.mtime);assert.equal((await run(args,w.pool)).data.summary,"number");
  }finally{await w.close();}
});

test("TypeScript types: BOM, CRLF and surrogate pairs keep the same source/cursor in both compiler APIs",async()=>{
  const text='\uFEFF'+source.replace('consume(value)','/* 😀 */ consume(value)').replaceAll('\n','\r\n');
  for(const selected of [compiler,compiler7]) {
    const w=fixture(text,{strict:true},selected);
    try{const result=await run(w.args());assert.equal(result.data.summary,'string');assert.equal(object(result.data.cursor).column,text.split('\n')[3].indexOf('value')+1);assert.equal(readFileSync(w.file,'utf8'),text);}finally{await w.close();}
  }
});

test("TypeScript expected: a call without outer context suggests its exact argument range in both compiler APIs",async()=>{
  const text='declare function consume(fn: () => number): number;\nconst value = consume(() => 1);\n';
  for(const selected of [compiler,compiler7]){
    const w=fixture(text,{strict:true},selected);
    try{
      const empty=await run(w.args(["--view","expected"],{line:2,symbol:"consume"}),w.pool);assert.equal(empty.data.found,false);
      const range=/--range (\S+)/.exec(String(empty.data.hint));assert(range);
      const result=await run({...parseOptions(["types","--file",w.file,"--view","expected","--range",range[1]],w.root),timeout:10000},w.pool);assert.equal(result.data.summary,"() => number");
    }finally{await w.close();}
  }
});

test("TypeScript types: installing a previously absent package refreshes module resolution in both compiler APIs",async()=>{
  for(const selected of [compiler,compiler7]){
    const w=fixture('import { value } from "new-package";\nconst result = value;\n',{strict:true,module:"NodeNext",moduleResolution:"NodeNext"},selected);
    try{
      const args=w.args([],{line:2,symbol:"result"});assert.equal((await run(args,w.pool)).data.summary,"any");
      const directory=join(w.root,"node_modules/new-package");mkdirSync(directory);writeFileSync(join(directory,"package.json"),'{"name":"new-package","types":"index.d.ts"}');writeFileSync(join(directory,"index.d.ts"),'export declare const value: boolean;\n');
      assert.equal((await run(args,w.pool)).data.summary,"boolean");
    }finally{await w.close();}
  }
});

test("TypeScript type detail bounds: large explicit limits retain the hard member bound and accurate totals",async()=>{
  const w=fixture('const object = { '+Array.from({length:210},(_,i)=>'field'+i+': '+i).join(', ')+' };\n');
  const result=await run(w.args(["--limit","500"],{line:1,symbol:"object"}));const detail=object(result.data.type);
  assert.equal(detail.totalProperties,210);assert.equal((detail.properties as unknown[]).length,200);assert.equal(result.data.truncated,true);
});
