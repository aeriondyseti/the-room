import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import{tmpdir}from'node:os';
import{cliCaller}from'./identity.js';import type{IdentityDeps}from'../mcp/identity.js';
const id='00000000-0000-4000-8000-000000000001';
test('CLI native environment is cross-checked; missing identity cannot act as human',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'room-cli-id-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const deps:IdentityDeps={env:{},ownParentPid:10,processInfo:async()=>null,claudeRegistry:{sessionsDir:root,isPidAlive:()=>true,processStartTime:async()=> '123',pidDomain:'test'}};
 assert.deepEqual(await cliCaller(null,deps),{kind:'human'});
 assert.equal((await cliCaller('declared',deps)).kind,'agent');
 const native=await cliCaller('astra',{...deps,env:{CODEX_THREAD_ID:id,CODEX_SESSION_ID:id.toUpperCase()}});assert.equal(native.kind,'agent');
 await assert.rejects(cliCaller(null,{...deps,env:{CODEX_THREAD_ID:id,CODEX_SESSION_ID:'other'}}),/Malformed|disagree/);
 await assert.rejects(cliCaller(null,{...deps,env:{CLAUDE_CODE_SESSION_ID:id}}),/Agent context/);
 await assert.rejects(cliCaller(null,{...deps,processInfo:async()=>({ppid:1,name:'codex.exe'})}),/Agent context/);
 await assert.rejects(cliCaller(null,{...deps,processInfo:async()=>{throw Error('process lookup failed');}}),/process lookup failed/);
});
