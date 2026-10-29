import assert from "node:assert/strict";
import { after, afterEach, before, mock, test } from "node:test";
import childProcess from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseOptions } from "../src/cli.ts";
import { run, outputData, type Session } from "../src/commands.ts";
import { LspClient } from "../src/client.ts";
import { object, type ObjectValue } from "../src/config.ts";
import { rustBackend } from "../src/rust-api.ts";
import { cleanWorkspaces, isolateGlobalConfig, workspace } from "./fixtures/workspace.ts";

let restore: () => void; const previousPath = process.env.PATH;
before(() => {restore = isolateGlobalConfig();}); after(() => restore());
afterEach(async () => {mock.restoreAll(); process.env.PATH = previousPath; const active = LspClient.active.size; await Promise.all([...LspClient.active].map(client => client.close())); cleanWorkspaces(); assert.equal(active, 0);});
const answer = {success:true,supported:true,found:true,provider:"rust-analyzer-api",apiVersion:1,engineVersion:"0.0.358",backendVersion:"0.4.24",snapshot:2,view:"computed",summary:"u32",type:{text:"u32",kind:"primitive",properties:[],signatures:[]},cursor:{line:1,column:5}};
function fixture(result: ObjectValue=answer) {
  const w = workspace({capabilities:{codexTypesVersion:1},responses:{"codex/types":result}});
  const file=join(w.root,"source.rs"); writeFileSync(file,"let value: u32 = 1;\n"); writeFileSync(join(w.root,"Cargo.toml"),'[package]\nname="fixture"\nversion="0.1.0"\n');
  const bin=join(w.root,"bin");mkdirSync(bin);const executable=join(bin,"codex-lsp-rust-types"+(process.platform==="win32"?".exe":""));writeFileSync(executable,"");chmodSync(executable,0o755);
  process.env.PATH = bin + delimiter + previousPath;
  const spawn=childProcess.spawn;
  mock.method(childProcess,"spawn",((command: string,args: string[],options: childProcess.SpawnOptions)=>command===executable
    ? spawn(process.execPath,[fileURLToPath(new URL("./fixtures/lsp-server.js",import.meta.url)),"scenario",join(w.root,"wire.ndjson"),join(w.root,"scenario.json")],options)
    : spawn(command,args,options)) as typeof childProcess.spawn);
  const args=(...flags:string[])=>({...parseOptions(["types","--file",file,"--line","1","--symbol","value",...flags],w.root),timeout:2000});
  return {...w,file,executable,args};
}

test("Rust semantic routing uses its native protocol, actual range and one shared worker for all views",async()=>{
  const w=fixture(),pool:Session={clients:new Map(),diagnostics:false};
  w.setScenario({capabilities:{codexTypesVersion:1},responsesByCall:{"codex/types":["computed","declared","expected"].map(view=>({...answer,view}))}});
  try {
    for(const view of ["computed","declared","expected"]){const result=await run(w.args("--view",view),pool);assert.equal(result.data.provider,"rust-analyzer-api");assert.equal(result.data.view,view);}
    assert.equal(w.events().filter(row=>row.method==="initialize").length,1);
    assert.equal(w.events().filter(row=>String(row.method).startsWith("typeServer/")).length,0);
    const query=object(w.events().find(row=>row.method==="codex/types")?.params);assert.deepEqual(query.range,{start:{line:0,character:4},end:{line:0,character:4}});
    assert.equal(readFileSync(w.file,"utf8"),"let value: u32 = 1;\n");
  } finally {await Promise.all([...pool.clients.values()].map(client=>client.close()));}
});

test("Rust field selection and budgets retain API/view state and omit structured types atomically",async()=>{
  const w=fixture({...answer,type:{...answer.type,properties:Array.from({length:100},(_,i)=>({name:"field"+i,type:"u32"}))}});
  const result=await run(w.args());const small=outputData(result.data,{fields:["summary"],budget:700});
  assert.equal(small.engineVersion,"0.0.358");assert.equal(small.apiVersion,1);assert.equal(small.view,"computed");assert.equal(small.summary,"u32");
  const clipped=outputData(result.data,{budget:1000});assert.equal(clipped.typeOmitted,true);assert.equal(clipped.type,undefined);assert(JSON.stringify(clipped).length<=1000);
});

test("Rust native API rejects incompatible workers and malformed responses, then reaps the process",async()=>{
  for(const malformed of [{...answer,apiVersion:2},{...answer,snapshot:-1},{...answer,type:null},{...answer,summary:"\ud800"}]){
    const w=fixture(malformed);await assert.rejects(run(w.args()),/Invalid Rust semantic API response/);assert.equal(LspClient.active.size,0);mock.restoreAll();
  }
  const w=fixture();w.setScenario({capabilities:{codexTypesVersion:2}});await assert.rejects(run(w.args()),/API version mismatch/);
});

test("Rust setup gives executable discovery and missing-helper install guidance without changing configuration",async()=>{
  const w=fixture();const before=readFileSync(w.configPath,"utf8");const result=await run(parseOptions(["setup","rust-types"],w.root));assert.equal(result.data.executable,w.executable);assert.equal(readFileSync(w.configPath,"utf8"),before);
  process.env.PATH="";assert.throws(()=>rustBackend({...w.args(),globalBinsOnly:true}),/cargo install --locked --path.*setup rust-types.*https:/);
});

test("Rust cargo settings validate before starting a process and never echo extra environment secrets",async()=>{
  const w=fixture();w.configs["rust-analyzer"].settings={"rust-analyzer":{cargo:{features:["full"],noDefaultFeatures:true,target:"example-target",extraEnv:{APIKEY:"private-fixture-marker"}}}};w.saveConfig();
  await run(w.args());const options=object(w.events().find(row=>row.method==="initialize")?.params).initializationOptions;
  assert.deepEqual(options,{cargo:{features:["full"],noDefaultFeatures:true,target:"example-target"}});assert(!JSON.stringify(w.events()).includes("private-fixture-marker"));
  const nested=join(w.root,"excluded-package");mkdirSync(nested);const file=join(nested,"source.rs");writeFileSync(file,"let value: u32 = 1;\n");writeFileSync(join(nested,"Cargo.toml"),'[package]\nname="excluded"\nversion="0.1.0"\n');
  await run({...w.args(),file});const initialized=object(w.events().filter(row=>row.method==="initialize").at(-1)?.params);
  assert.equal(fileURLToPath(String(initialized.rootUri)),nested);
  for(const cargo of [{features:true},{features:[1]},{noDefaultFeatures:1},{target:[]}]){w.configs["rust-analyzer"].settings={"rust-analyzer":{cargo}};w.saveConfig();await assert.rejects(run(w.args()),/rust-analyzer cargo\./);}
});

test("Rust worker timeout reaps an instrumented Cargo-like descendant and preserves source",async()=>{
  const w=fixture(),pidFile=join(w.root,"descendant.pid");
  w.setScenario({capabilities:{codexTypesVersion:1},spawnChildOn:"codex/types",childPidFile:pidFile,stallMethods:["codex/types"]});
  let pid:number|undefined;
  try{
    await assert.rejects(run({...w.args(),timeout:400}),/timed out/);
    assert(existsSync(pidFile));pid=Number(readFileSync(pidFile,"utf8"));
    for(let attempt=0;attempt<80;attempt++){try{process.kill(pid,0);}catch{break;}await delay(25);}
    assert.throws(()=>process.kill(pid!,0));assert.equal(LspClient.active.size,0);assert.equal(readFileSync(w.file,"utf8"),"let value: u32 = 1;\n");
  }finally{if(pid)try{process.kill(pid,"SIGKILL");}catch{/* Already reaped. */}}
});
