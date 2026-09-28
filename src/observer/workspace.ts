// Read-only, bounded metadata observation. Session cwd is not an individual tool command's cwd.
import { open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import type { WorkspaceInfo, WorkspaceProvider } from '../contracts/workspace.js';
import type { RoomConfig } from '../core/config.js';
import { WorkspaceGit } from './workspace-git.js';
type Target=Parameters<WorkspaceProvider['observe']>[0];
const object=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const safeString=(v:unknown):string|null=>typeof v==='string'&&v.trim()&& !/[\x00-\x1f\x7f-\x9f]/.test(v)?v:null;
const directory=(v:unknown):string|null=>{const s=safeString(v);return s&&path.isAbsolute(s)?s:null;};
export interface WorkspaceOptions {
  codexSessionsDir:string;claudeProjectsDir:string;readBytes:number;scanEntries:number;
  timeoutMs:number;gitMaxBytes:number;gitCacheMs:number;
}
export function workspaceOptionsFrom(config:RoomConfig):WorkspaceOptions {
  return {codexSessionsDir:path.join(config.codexHome??process.env.CODEX_HOME??path.join(homedir(),'.codex'),'sessions'),
    claudeProjectsDir:path.join(config.claudeConfigDir??process.env.CLAUDE_CONFIG_DIR??path.join(homedir(),'.claude'),'projects'),
    readBytes:config.workspaceReadBytes,scanEntries:config.workspaceScanEntries,timeoutMs:config.workspaceTimeoutMs,
    gitMaxBytes:config.workspaceGitMaxBytes,gitCacheMs:config.workspaceGitCacheMs};
}
export function parseWorkspaceRecords(records:unknown[],target:Target):Pick<WorkspaceInfo,'model'|'cwd'|'cwdSource'> {
  let model:string|null=null,cwd:string|null=null;
  for(const value of records) {
    const r=object(value);if(!r)continue;
    if(target.harness==='codex') {
      const p=object(r.payload);if(!p)continue;
      if(r.type==='session_meta') {if(p.id!==target.sessionId)return {model:null,cwd:null,cwdSource:null};cwd=directory(p.cwd)??cwd;}
      if(r.type==='turn_context') {model=safeString(p.model);cwd=directory(p.cwd)??cwd;}
    } else {
      if(r.sessionId!==target.sessionId || r.isSidechain===true || r.isApiErrorMessage===true)continue;
      // cwd is a top-level harness field, never extracted from tool arguments/results.
      cwd=directory(r.cwd)??cwd;
      if(r.type==='assistant') {const m=safeString(object(r.message)?.model);if(m&&m!=='<synthetic>')model=m;}
    }
  }
  return {model,cwd,cwdSource:cwd?`${target.harness}-transcript`:null};
}
/** Read the initial metadata and recent complete records only; never allocate the whole rollout. */
async function recentRecords(file:string,bytes:number):Promise<unknown[]> {
  if(bytes<2)return []; // Too small even for the preceding-byte tail boundary check.
  const handle=await open(file,'r');
  try {
    const size=(await handle.stat()).size, chunk=Math.max(1,Math.floor(bytes/2));
    // Include the preceding tail byte: LF means the first tail record is complete. Keep total bytes bounded.
    const windows=size<=bytes?[[0,size]]:[[0,Math.max(0,chunk-1)],[size-chunk-1,chunk+1]];
    const values:unknown[]=[];
    for(const [offset,length] of windows as [number,number][]) {
      const buffer=Buffer.alloc(length);const {bytesRead}=await handle.read(buffer,0,length,offset);
      let data=buffer.subarray(0,bytesRead);
      if(offset>0){const nl=data.indexOf(10);if(nl<0)continue;data=data.subarray(nl+1);}
      const end=data.lastIndexOf(10);if(end<0)continue;
      for(const line of data.subarray(0,end).toString('utf8').split('\n')) {try{values.push(JSON.parse(line));}catch{/* incomplete/malformed records are not evidence */}}
    }
    return values;
  } finally {await handle.close();}
}
export class NativeWorkspaceProvider implements WorkspaceProvider {
  private readonly git:WorkspaceGit;
  private paths=new Map<string,string>();
  private pending=new Map<string,Promise<WorkspaceInfo>>();
  constructor(private readonly options:WorkspaceOptions) {
    this.git=new WorkspaceGit({timeoutMs:options.timeoutMs,maxBytes:options.gitMaxBytes,cacheMs:options.gitCacheMs});
  }
  async observe(target:Target):Promise<WorkspaceInfo> {
    const empty:WorkspaceInfo={model:null,cwd:null,cwdSource:null,git:null,observedAt:null};
    const key=`${target.harness}:${target.sessionId}`;
    // OS filesystem calls cannot all be cancelled. Keep the underlying operation single-flight even
    // after a caller deadline, so an unavailable network share cannot accumulate one read per tick.
    let task=this.pending.get(key);
    if(!task) {
      task=this.read(target).catch(()=>empty);
      this.pending.set(key,task);
      void task.finally(()=>this.pending.delete(key));
    }
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([task,new Promise<WorkspaceInfo>(resolve=>{timer=setTimeout(()=>resolve(empty),this.options.timeoutMs);})]);}
    finally{clearTimeout(timer);}
  }
  private async read(target:Target):Promise<WorkspaceInfo> {
    const empty:WorkspaceInfo={model:null,cwd:null,cwdSource:null,git:null,observedAt:null};
    try {
      if(!/^[a-zA-Z0-9-]+$/.test(target.sessionId))return empty;
      const key=`${target.harness}:${target.sessionId}`;
      let file=this.paths.get(key);
      let records:unknown[]|null=null;
      if(file) {try{records=await recentRecords(file,this.options.readBytes);}catch{this.paths.delete(key);file=undefined;}}
      if(!file){file=await this.locate(target)??undefined;if(file){records=await recentRecords(file,this.options.readBytes);this.paths.set(key,file);if(this.paths.size>this.options.scanEntries)this.paths.delete(this.paths.keys().next().value!);}}
      if(!records)return empty;
      const fields=parseWorkspaceRecords(records,target);
      return {...fields,git:fields.cwd?await this.git.sample(fields.cwd):null,observedAt:new Date().toISOString()};
    } catch {return empty;}
  }
  private async locate(target:Target):Promise<string|null> {
    const base=target.harness==='codex'?this.options.codexSessionsDir:this.options.claudeProjectsDir;
    const queue=[{dir:base,depth:0}];let remaining=this.options.scanEntries;const deadline=Date.now()+this.options.timeoutMs;
    while(queue.length&&remaining>0&&Date.now()<deadline) {
      const current=queue.shift()!;
      try {
        const dir=await opendir(current.dir);
        for await(const entry of dir) {
          if(--remaining<0 || Date.now()>=deadline)break;
          const file=path.join(current.dir,entry.name);
          if(entry.isFile() && (target.harness==='claude'?entry.name===`${target.sessionId}.jsonl`:entry.name.startsWith('rollout-')&&entry.name.endsWith(`-${target.sessionId}.jsonl`)))return file;
          if(entry.isDirectory()&&current.depth<(target.harness==='codex'?3:1))queue.push({dir:file,depth:current.depth+1});
        }
      }catch{/* absent or unreadable source */}
    }
    return null;
  }
}
