import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {roomGitEnvironment} from '../core/registry/root.js';
import {WorkspaceGit,parseGitStatus,emptyGit} from './workspace-git.js';
import {NativeWorkspaceProvider,parseWorkspaceRecords} from './workspace.js';
const target={participant:'a',harness:'codex' as const,sessionId:'session-1'};
test('metadata excludes tool cwd, mismatched sessions, sidechains and synthetic models',()=>{
  assert.deepEqual(parseWorkspaceRecords([
    {type:'session_meta',payload:{id:'session-1',cwd:process.cwd()}},
    {type:'turn_context',payload:{model:'gpt-test',cwd:process.cwd()}},
    {type:'response_item',payload:{type:'function_call',cwd:tmpdir(),model:'fake'}},
  ],target),{model:'gpt-test',cwd:process.cwd(),cwdSource:'codex-transcript'});
  assert.equal(parseWorkspaceRecords([{type:'session_meta',payload:{id:'wrong',cwd:process.cwd()}}],target).cwd,null);
  const claude={...target,harness:'claude' as const};
  assert.equal(parseWorkspaceRecords([
    {sessionId:'session-1',type:'assistant',cwd:process.cwd(),message:{model:'claude-test'}},
    {sessionId:'session-1',type:'assistant',isSidechain:true,message:{model:'other'}},
    {sessionId:'session-1',type:'assistant',message:{model:'<synthetic>'}},
    {sessionId:'wrong',type:'assistant',message:{model:'wrong'}},
  ],claude).model,'claude-test');
});
test('porcelain parses overlapping staged/modified and consumes rename sources safely',()=>{
  const data=['# branch.oid abcdef1234567890','# branch.head topic','# branch.ab +2 -1',
    '1 MM N... 100644 100644 100644 aa bb filename','2 R. N... 100644 100644 100644 aa bb R100 new','? not-an-untracked-record', '? real-untracked',''].join('\0');
  const info=parseGitStatus(data,emptyGit('ok','now',''));
  assert.deepEqual([info.branch,info.head,info.staged,info.modified,info.untracked,info.ahead,info.behind],['topic','abcdef123456',2,1,1,2,1]);
});
test('git integration: clean/unborn, changes, cache, linked worktree and detached HEAD',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'vpfix-workspace-'));
  const env=roomGitEnvironment(process.env);
  const git=(...args:string[])=>execFileSync('git',['-C',dir,...args],{env,windowsHide:true,encoding:'utf8'});
  git('init','-q');let clock=Date.now();const reader=new WorkspaceGit({timeoutMs:3000,maxBytes:100000,cacheMs:10,now:()=>clock});
  let info=await reader.sample(dir);assert.equal(info.status,'ok');assert.equal(info.head,null);assert.equal(info.staged,0);assert.equal(info.ahead,null);
  await writeFile(path.join(dir,'a.txt'),'first');git('add','a.txt');
  assert.equal((await reader.sample(dir)).staged,0,'cached snapshot');clock+=11;
  assert.equal((await reader.sample(dir)).staged,1);
  git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
  await writeFile(path.join(dir,'a.txt'),'second');git('add','a.txt');await writeFile(path.join(dir,'a.txt'),'third');await writeFile(path.join(dir,'untracked'),'u');clock+=11;
  info=await reader.sample(dir);assert.equal(info.staged,1);assert.equal(info.modified,1);assert.equal(info.untracked,1);
  const wt=path.join(dir,'linked worktree');git('worktree','add','--detach',wt,'HEAD');clock+=11;
  info=await reader.sample(wt);assert.equal(info.status,'ok');assert.equal(info.detached,true);assert.equal(info.branch,null);assert.equal(path.resolve(info.worktree!),path.resolve(wt));
  assert.equal((await reader.sample(await mkdtemp(path.join(tmpdir(),'vpfix-nongit-')))).status,'not_a_repo');
  assert.equal((await reader.sample(path.join(dir,'missing'))).status,'unavailable');
});
test('provider reads bounded recent records, replaces files and never throws for absent sources',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'vpfix-meta-'));const nested=path.join(dir,'2026','09','28');await mkdir(nested,{recursive:true});
  const file=path.join(nested,'rollout-time-session-1.jsonl');
  const line=(value:unknown)=>JSON.stringify(value)+'\n';
  await writeFile(file,line({type:'session_meta',payload:{id:'session-1'}})+'x'.repeat(10000)+'\n'+line({type:'turn_context',payload:{model:'new-model'}}));
  const provider=new NativeWorkspaceProvider({codexSessionsDir:dir,claudeProjectsDir:dir,readBytes:1024,scanEntries:100,timeoutMs:1000,gitMaxBytes:10000,gitCacheMs:1000});
  assert.equal((await provider.observe(target)).model,'new-model');
  await writeFile(file,line({type:'session_meta',payload:{id:'session-1'}})+line({type:'turn_context',payload:{model:'replacement'}}));
  assert.equal((await provider.observe(target)).model,'replacement');
  assert.equal((await provider.observe({...target,sessionId:'../../bad'})).model,null);
  assert.equal((await provider.observe({...target,sessionId:'missing'})).cwd,null);
});
