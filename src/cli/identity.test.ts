import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import{tmpdir}from'node:os';
import{cliCaller}from'./identity.js';import type{IdentityDeps}from'../mcp/identity.js';
const id='00000000-0000-4000-8000-000000000001';
test('CLI native environment is cross-checked; missing identity cannot act as human',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'room-cli-id-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const deps:IdentityDeps={env:{},ownParentPid:10,processInfo:async()=>null,claudeRegistry:{sessionsDir:root,isPidAlive:()=>true,processStartTime:async()=> '123',pidDomain:'test'}};
 await assert.rejects(cliCaller(null,deps),/ancestry is incomplete/);
 assert.deepEqual(await cliCaller(null,{...deps,processInfo:async()=>({ppid:null,name:'terminal.exe'})}),{kind:'human'});
 assert.equal((await cliCaller('declared',deps)).kind,'agent');
 const native=await cliCaller('astra',{...deps,env:{CODEX_THREAD_ID:id,CODEX_SESSION_ID:id.toUpperCase()}});assert.equal(native.kind,'agent');
 await assert.rejects(cliCaller(null,{...deps,env:{CODEX_THREAD_ID:id,CODEX_SESSION_ID:'other'}}),/Malformed|disagree/);
 await assert.rejects(cliCaller(null,{...deps,env:{CLAUDE_CODE_SESSION_ID:id}}),/identity|ancestry|Agent context/);
 await assert.rejects(cliCaller(null,{...deps,processInfo:async()=>({ppid:1,name:'codex.exe'})}),/Agent context/);
 await assert.rejects(cliCaller(null,{...deps,processInfo:async()=>{throw Error('process lookup failed');}}),/process lookup failed/);
});


test('CLI walks Claude ancestors, checks process identity and flags environment drift',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'room-cli-claude-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'20.json'),JSON.stringify({pid:20,sessionId:id,messagingSocketPath:'\\\\.\\pipe\\LOCAL\\cc-msg-cli-test',procStart:'123',pidDomain:'test'}));
 const deps:IdentityDeps={env:{CLAUDE_CODE_SESSION_ID:'old'},ownParentPid:10,processInfo:async pid=>({ppid:pid===10?20:null,name:pid===10?'pwsh.exe':'claude.exe'}),claudeRegistry:{sessionsDir:root,isPidAlive:()=>true,processStartTime:async()=> '123',pidDomain:'test'}};
 const notes:string[]=[];const caller=await cliCaller('claude',deps,n=>notes.push(n));
 assert.equal(caller.kind==='agent'&&caller.native?.source,'claude-ancestry');assert.match(notes[0]!,/differs/);
 await assert.rejects(cliCaller(null,{...deps,claudeRegistry:{...deps.claudeRegistry,processStartTime:async()=> 'other'}}),/different process/);
});

test('Windows desktop root accepts human shells without following an exited Explorer launcher',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'room-cli-desktop-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const names=new Map([[10,{name:'pwsh.exe',ppid:20}],[20,{name:'WindowsTerminal.exe',ppid:30}],[30,{name:'explorer.exe',ppid:40}]]);
 const deps:IdentityDeps={env:{},ownParentPid:10,processInfo:async pid=>names.get(pid)??null,claudeRegistry:{sessionsDir:root,isPidAlive:()=>true,processStartTime:async()=> '123',pidDomain:'test'}};
 assert.deepEqual(await cliCaller(null,deps),{kind:'human'});
 assert.equal((await cliCaller('declared',deps)).kind,'agent');
 await assert.rejects(cliCaller(null,{...deps,env:{CLAUDE_CODE_SESSION_ID:id}}),/identity|ancestry|Agent context/);
 names.set(20,{name:'codex.exe',ppid:30});
 await assert.rejects(cliCaller(null,deps),/Agent context/);
 names.delete(20);
 await assert.rejects(cliCaller(null,deps),/ancestry is incomplete/);
});
