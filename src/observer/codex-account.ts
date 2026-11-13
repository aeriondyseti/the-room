// Current account limits from an existing Codex daemon, never inferred from a participant's token totals.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AccountUsage, AccountUsageProvider, UsageBucket, UsageWindow } from '../contracts/account.js';
import type { RoomConfig } from '../core/config.js';
import { codexOptionsFrom, resolveCodexExecutable } from '../adapters/codex/adapter.js';
import { readCodexDaemon, type DaemonReadOptions, type DaemonReadResult } from '../adapters/codex/daemon-read.js';
import { summaryLine } from './activity-text.js';

export interface CodexAccountOptions extends Omit<DaemonReadOptions,'executable'> {
  executable: string | null;
  now?: () => number;
  read?: (options:DaemonReadOptions) => Promise<DaemonReadResult>;
}
export function codexAccountOptionsFrom(config:RoomConfig,root:string):CodexAccountOptions {
  const env=codexOptionsFrom(config,root).env??process.env;
  return {executable:resolveCodexExecutable(config.codexExecutable,root,env),cwd:root,env,
    home:path.resolve(root,env.CODEX_HOME||path.join(homedir(),'.codex')),
    timeoutMs:config.codexStatusTimeoutMs,maxBytes:config.codexStatusMaxBytes};
}
const obj=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const str=(v:unknown):string|null=>typeof v==='string'&&v.trim()?v:null;
const hash=(purpose:string,value:string)=>createHash('sha256').update(`codex\0${purpose}\0${value}`).digest('hex');
function resetTime(value:unknown):string|null {
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)return null;
  const time=new Date(value*1000);return Number.isFinite(time.getTime())?time.toISOString():null;
}
function window(value:unknown,kind:string,observedAt:string):UsageWindow|null {
  if(value==null)return null;
  const raw=obj(value);if(!raw)return null;
  const duration=typeof raw.windowDurationMins==='number'&&Number.isSafeInteger(raw.windowDurationMins)&&raw.windowDurationMins>0?raw.windowDurationMins:null;
  const percent=typeof raw.usedPercent==='number'&&Number.isFinite(raw.usedPercent)&&raw.usedPercent>=0&&raw.usedPercent<=100?raw.usedPercent:null;
  return {kind,durationMinutes:duration,usedPercent:percent,resetsAt:resetTime(raw.resetsAt),observedAt,
    ...(percent===null?{reason:'Provider did not report a valid percentage.'}:{})};
}
function pinWindows(windows:UsageWindow[]):UsageWindow[] {
  for(const [duration,label] of [[300,'5h'],[10080,'weekly']] as const) {
    if(!windows.some(w=>w.durationMinutes===duration))windows.push({kind:`missing-${label}`,durationMinutes:duration,usedPercent:null,resetsAt:null,observedAt:null,reason:`Provider reports no ${label} window.`});
  }
  return windows;
}

/** No cache here: the shared AccountMonitor owns cadence and stale-last-good behavior. */
export class CodexAccountProvider implements AccountUsageProvider {
  readonly harness='codex' as const;
  readonly id:string;
  private readonly sourceKey:string;
  private readonly now:()=>number;
  constructor(private readonly options:CodexAccountOptions) {
    const home=path.resolve(options.cwd,options.home);
    this.sourceKey=hash('profile',process.platform==='win32'?home.toLowerCase():home);
    this.id=`codex:${this.sourceKey}`;this.now=options.now??Date.now;
  }
  async sample():Promise<AccountUsage> {
    let checkedAt:string|null=null;
    const base=():AccountUsage=>({account:{harness:'codex',scope:'profile',key:this.sourceKey,sourceKey:this.sourceKey},
      buckets:[],status:'unavailable',source:'codex app-server account/rateLimits/read',checkedAt,observedAt:null,ordinaryUsageAllowed:null});
    try {
      checkedAt=new Date(this.now()).toISOString();
      if(!this.options.executable)return {...base(),reason:'Native Codex executable unavailable; run roundtable doctor.'};
      const options={...this.options,executable:this.options.executable};
      const response=await (this.options.read??(o=>readCodexDaemon(o,{method:'account/rateLimits/read'})))(options);
      if(!response.ok)return {...base(),reason:response.reason};
      const observedAt=new Date(this.now()).toISOString();
      const value=obj(response.value);
      if(!value)return {...base(),reason:'Codex account usage response has an unsupported shape.'};
      const accountId=str(value.accountId), key=accountId?hash('account',accountId):this.sourceKey;
      const mapped=obj(value.rateLimitsByLimitId);
      const snapshots=new Map<string,Record<string,unknown>>();
      for(const [id,raw] of Object.entries(mapped??{})) {const snapshot=obj(raw);if(snapshot)snapshots.set(str(snapshot.limitId)??id,snapshot);}
      // Legacy singleton mirrors a keyed bucket; use only when no keyed buckets were supplied.
      const legacy=obj(value.rateLimits);
      if(snapshots.size===0&&legacy)snapshots.set(str(legacy.limitId)??'codex',legacy);
      const buckets:UsageBucket[]=[];
      for(const [id,snapshot] of snapshots) {
        const windows=[window(snapshot.primary,'primary',observedAt),window(snapshot.secondary,'secondary',observedAt)].filter((w):w is UsageWindow=>w!==null);
        const label=str(snapshot.limitName);
        buckets.push({id:summaryLine(id),...(label?{label:summaryLine(label)}:{}),windows:pinWindows(windows)});
      }
      const account:AccountUsage['account']={harness:'codex',scope:accountId?'account':'profile',key,sourceKey:this.sourceKey};
      const allowed=typeof value.ordinaryUsageAllowed==='boolean'?value.ordinaryUsageAllowed:null;
      const hasValue=buckets.some(b=>b.windows.some(w=>w.usedPercent!==null));
      if(!hasValue)return {...base(),account,ordinaryUsageAllowed:allowed,reason:'Codex reported no usable subscription windows.'};
      const plan=str(legacy?.planType)??str([...snapshots.values()][0]?.planType);
      return {account,
        buckets,status:'ok',source:base().source,checkedAt,observedAt,plan:plan?summaryLine(plan):null,
        ordinaryUsageAllowed:allowed};
    } catch {
      // Raw native exceptions can contain account/auth details; return a fixed diagnostic only.
      return {...base(),reason:'Codex account usage could not be read.'};
    }
  }
}
