// Presentation-only Git sampling. No index refresh writes, inherited repo override, or shell interpolation.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { GitInfo } from '../contracts/workspace.js';
import { roomGitEnvironment } from '../core/registry/root.js';
const exec = promisify(execFile);
export interface GitOptions { timeoutMs:number; maxBytes:number; cacheMs:number; now?:()=>number }
export function emptyGit(status:GitInfo['status'], checkedAt:string, reason:string):GitInfo {
  return {status,reason,root:null,worktree:null,branch:null,detached:false,head:null,staged:null,modified:null,untracked:null,ahead:null,behind:null,checkedAt};
}
/** -z records keep arbitrary filenames out of the parser, including rename source names. */
export function parseGitStatus(text:string, base:GitInfo):GitInfo {
  const info={...base,staged:0,modified:0,untracked:0};
  const records=text.split('\0');
  for(let i=0;i<records.length;i++) {
    const r=records[i]!;
    if(r.startsWith('# branch.oid '))info.head=r.slice(13)==='(initial)'?null:r.slice(13,25);
    else if(r.startsWith('# branch.head ')) {const name=r.slice(14);info.detached=name==='(detached)';info.branch=info.detached?null:name;}
    else if(r.startsWith('# branch.ab ')) {const m=/^# branch.ab \+(\d+) -(\d+)$/.exec(r);if(!m)throw Error('invalid branch counts');info.ahead=Number(m[1]);info.behind=Number(m[2]);}
    else if(r.startsWith('? '))info.untracked++;
    else if(/^[12u] /.test(r)) {
      const xy=r.split(' ')[1];if(!xy||xy.length!==2)throw Error('invalid status');
      if(xy[0]!=='.')info.staged++;if(xy[1]!=='.')info.modified++;
      if(r[0]==='2') {if(!records[++i])throw Error('missing rename source');}
    } else if(r && !r.startsWith('# ') && !r.startsWith('! '))throw Error('unsupported status');
  }
  return info;
}
export class WorkspaceGit {
  private cache=new Map<string,{at:number;value:Promise<GitInfo>}>();
  constructor(private options:GitOptions){}
  async sample(cwd:string):Promise<GitInfo> {
    const key=process.platform==='win32'?path.resolve(cwd).toLowerCase():path.resolve(cwd);
    const now=(this.options.now??Date.now)();const cached=this.cache.get(key);
    if(cached && now-cached.at<this.options.cacheMs)return cached.value;
    const value=this.read(cwd,new Date(now).toISOString());
    this.cache.set(key,{at:now,value});
    // Bound retained entries, including obsolete working directories.
    if(this.cache.size>256)this.cache.delete(this.cache.keys().next().value!);
    return value;
  }
  private async read(cwd:string,at:string):Promise<GitInfo> {
    const env={...roomGitEnvironment(process.env),GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'};
    const run=async(args:string[]) => (await exec('git',['--no-optional-locks','-C',cwd,...args],{env,windowsHide:true,timeout:this.options.timeoutMs,maxBuffer:this.options.maxBytes,encoding:'utf8'})).stdout;
    try {
      const paths=(await run(['rev-parse','--path-format=absolute','--show-toplevel','--git-dir','--git-common-dir'])).trimEnd().split(/\r?\n/);
      if(paths.length!==3 || paths.some(p=>!path.isAbsolute(p)||/[\x00-\x1f\x7f]/.test(p)))throw Error('unsupported path');
      const [root,dir,common]=paths as [string,string,string];
      const equal=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
      const base={...emptyGit('ok',at,''),root,worktree:equal(path.resolve(dir),path.resolve(common))?null:root};delete base.reason;
      return parseGitStatus(await run(['status','--porcelain=v2','--branch','-z','--untracked-files=normal']),base);
    } catch(error) {
      const e=error as {stderr?:string;code?:unknown};
      return emptyGit(e.code===128 && /not a git repository/i.test(e.stderr??'')?'not_a_repo':'unavailable',at,'Git workspace metadata could not be read.');
    }
  }
}
