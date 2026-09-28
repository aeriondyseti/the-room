import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import type { DeliveryAdapter, LivenessProbe, SubmitRequest, SubmitResult } from '../../contracts/adapter.js';
import type {RuntimeContext,TargetSnapshot} from '../../contracts/domain.js';
import type { RoomConfig } from '../../core/config.js';

const UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uuidPattern=new RegExp(`^${UUID}$`,'i');
const acceptedPattern=new RegExp(`^Queued message (${UUID}) for thread (${UUID})\\.$`,'i');
export interface CodexOptions {
 executable:string|null;cwd:string;env?:NodeJS.ProcessEnv;timeoutMs:number;maxEnvelopeChars:number;
 commandLineBudget:number;maxOutputBytes:number;
 /** Test fixture prefix; production queue invokes the executable directly with no shell. */
 prefixArgs?:string[];
}
export function codexOptionsFrom(config:RoomConfig,cwd:string):CodexOptions{return{
 executable:config.codexExecutable,cwd,timeoutMs:config.adapterTimeoutMs,maxEnvelopeChars:config.codexMaxEnvelopeChars,
 commandLineBudget:config.codexCommandLineBudget,maxOutputBytes:config.codexMaxOutputBytes,
 env:{...process.env,...(config.codexHome?{CODEX_HOME:config.codexHome}:{})},
};}
export function resolveCodexExecutable(configured:string|null,cwd:string,env:NodeJS.ProcessEnv=process.env):string|null{
 const name=configured??(process.platform==='win32'?'codex.exe':'codex');
 if(process.platform==='win32'&&/\.(?:cmd|bat|ps1)$/i.test(name))return null;
 const candidates=path.isAbsolute(name)||/[\\/]/.test(name)?[path.resolve(cwd,name)]:(env.PATH??env.Path??'').split(path.delimiter).filter(Boolean).map(dir=>path.join(dir.replace(/^"|"$/g,''),name));
 for(const candidate of candidates){try{if(statSync(candidate).isFile()){accessSync(candidate,process.platform==='win32'?constants.F_OK:constants.X_OK);return candidate;}}catch{/* another PATH entry may contain the native executable */}}
 return null;
}
/** Microsoft argv quoting (no shell interpretation); used to qualify CreateProcess UTF-16 budgets. */
export function quoteWindowsArgument(value:string):string{
 if(value!==''&&!/[\s"]/.test(value))return value;
 return '"'+value.replace(/(\\*)"/g,(_match,slashes:string)=>slashes+slashes+'\\"').replace(/(\\+)$/g,slashes=>slashes+slashes)+'"';
}
export function windowsCommandLineLength(executable:string,args:readonly string[]):number{return [executable,...args].map(quoteWindowsArgument).join(' ').length+1;}
export class CodexAdapter implements DeliveryAdapter {
 readonly runtimeContext:RuntimeContext;
 readonly harness='codex' as const;readonly maxEnvelopeChars:number;readonly executable:string|null;
 constructor(private options:CodexOptions){
  this.options={...options,env:{...(options.env??process.env)}};
  this.executable=resolveCodexExecutable(options.executable,options.cwd,options.env);
  this.runtimeContext=Object.freeze({harness:'codex',executable:this.executable,home:path.resolve(options.cwd,this.options.env?.CODEX_HOME||path.join(homedir(),'.codex'))});
  const prefix=options.prefixArgs??[];
  const overhead=windowsCommandLineLength(this.executable??'codex.exe',[...prefix,'queue','--thread','0'.repeat(36),'--message']);
  // Every UTF-16 unit may need doubling in the worst quote/backslash case. This deliberately
  // conservative effective cap makes the core reference fallback safe for arbitrary message text.
  this.maxEnvelopeChars=process.platform==='win32'?Math.max(0,Math.min(options.maxEnvelopeChars,Math.floor((Math.min(options.commandLineBudget,32767)-overhead-3)/2))):options.maxEnvelopeChars;
 }
 async probe(_target:TargetSnapshot):Promise<LivenessProbe>{return{liveness:'unknown',activity:'unknown',detail:this.executable?'Queue acceptance does not establish whether the thread is loaded or processing.':'Native Codex executable unavailable; set ROOM_CODEX_EXECUTABLE to codex.exe.'};}
 async submit(request:SubmitRequest):Promise<SubmitResult>{
  if(request.target.harness!=='codex'||!uuidPattern.test(request.target.sessionId))return{status:'failed',error:{code:'bad_request',message:'Codex delivery requires an exact native thread UUID.'}};
  if(!this.executable)return{status:'failed',error:{code:'service_unavailable',message:'Native Codex executable was not found.',hint:'Install Codex on PATH or set ROOM_CODEX_EXECUTABLE to the native executable, not a shell wrapper.'}};
  if(request.envelope.includes('\0'))return{status:'failed',error:{code:'bad_request',message:'Native command arguments cannot contain NUL characters.'}};
  const args=[...(this.options.prefixArgs??[]),'queue','--thread',request.target.sessionId,'--message',request.envelope];
  if(request.envelope.length>this.maxEnvelopeChars||(process.platform==='win32'&&windowsCommandLineLength(this.executable,args)>Math.min(this.options.commandLineBudget,32767)))return{status:'failed',error:{code:'message_too_large',message:'Envelope exceeds the qualified Codex command-line budget.',hint:'Use the room reference fallback; keep the complete content in room storage.'}};
  return new Promise(resolve=>{
   try{execFile(this.executable!,args,{cwd:this.options.cwd,env:this.options.env,windowsHide:true,timeout:this.options.timeoutMs,maxBuffer:this.options.maxOutputBytes},(error,stdout,stderr)=>{
    const receipt=stdout.split(/\r?\n/).map(line=>acceptedPattern.exec(line.trim())).find(match=>match&&match[2]!.toLowerCase()===request.target.sessionId.toLowerCase());
    if(!error&&receipt)return resolve({status:'submitted',evidence:{kind:'codex-queue',nativeId:receipt[1]!}});
    const nativeCode=error?.code;
    if(typeof nativeCode==='string'&&['ENOENT','EACCES','EPERM','ENOEXEC','EINVAL','E2BIG'].includes(nativeCode))return resolve({status:'failed',error:{code:'service_unavailable',message:`Codex could not be launched (${nativeCode}).`,hint:'Run room doctor and check the executable path and permissions.'}});
    if(error&&!error.killed&&/thread[^\r\n]*(?:not found|deleted|archived)|(?:no|unknown)[^\r\n]*thread/i.test(stderr))return resolve({status:'unavailable',reason:'rebind_needed',detail:'Codex rejected the original thread identity as missing, deleted or archived. Verify its configured home and rebind explicitly.'});
    if(error&&!error.killed&&/(?:unexpected|unrecognized) argument|^Usage:/m.test(stderr))return resolve({status:'failed',error:{code:'unsupported_version',message:'Codex rejected the queue command arguments.',hint:'Run the harness compatibility probes and check codex queue --help.'}});
    resolve({status:'uncertain',error:{code:'service_unavailable',message:error?'Codex queue did not return a confirmed acceptance before failure.':'Codex exited without a matching queue receipt.',hint:'Reconcile the target queue or recipient before retrying; the message may already be queued.'}});
   });}catch{return resolve({status:'failed',error:{code:'bad_request',message:'Codex process arguments could not be started.'}});}
  });
 }
}
