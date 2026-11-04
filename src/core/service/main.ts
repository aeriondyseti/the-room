import { defaultAdapters } from './default-adapters.js';
import { realpath } from 'node:fs/promises';
import { startServer } from '../../ipc/server.js';
import { loadConfig } from '../config.js';
import { UsageObserver, usageObserverOptionsFrom } from '../../observer/index.js';
import { ActivityReader } from '../../observer/activity-reader.js';
import { NativeWorkspaceProvider, workspaceOptionsFrom } from '../../observer/workspace.js';
import { claudeActivityParser } from '../../observer/claude-activity.js';
import { codexActivityParser } from '../../observer/codex-activity.js';
import { claudeAccountUsageProvider } from '../../adapters/claude/rate-limits.js';
import { claudeUsageApiProvider, sharedUsageCachePath } from '../../adapters/claude/usage-api.js';
import { ccstatuslineCacheProvider, firstAvailable, isDefaultClaudeProfile } from '../../adapters/claude/ccstatusline-cache.js';
import { claudeProfileKey } from '../../adapters/claude/rate-limits.js';
import { resolveClaudeConfigDir } from '../../adapters/claude/registry.js';
import { CodexAccountProvider, codexAccountOptionsFrom } from '../../observer/codex-account.js';
const root=process.argv[2];
/**
 * Claude plan usage, cheapest source first: ccstatusline's own cache (zero extra endpoint calls, no credentials; Kevin's
 * statusline already refreshes it) → our throttled usage-endpoint call (opt-in ROOM_CLAUDE_USAGE_API=on) → the
 * statusline tap (no model-specific limits).
 */
const claudeProvider=(claudeConfigDir:string,usageApi:string,timeoutMs:number,freshMs:number)=>{
  const key=claudeProfileKey(claudeConfigDir);
  return firstAvailable(`claude:${key}`,[
    // ccstatusline's cache is global (the default Claude login), so only the default profile may use it.
    ...(isDefaultClaudeProfile(claudeConfigDir)?[ccstatuslineCacheProvider({profileKey:key})]:[]),
    ...(usageApi==='on'?[claudeUsageApiProvider({claudeConfigDir,timeoutMs,throttle:{cachePath:sharedUsageCachePath(claudeConfigDir)}})]:[]),
    claudeAccountUsageProvider({claudeConfigDir}),
  ],{freshMs});
};
if(!root)throw new Error('Room service requires a canonical root argument.');
try {
  const canonical=await realpath(root);
  const config=loadConfig();
  const usage=usageObserverOptionsFrom(config);
  const activity=new ActivityReader({claudeProjectsDir:usage.claudeProjectsDir,codexSessionsDir:usage.codexSessionsDir,parsers:[claudeActivityParser,codexActivityParser],
    detailBytes:config.activityDetailBytes,windowItems:config.activityWindowItems,startBytes:config.activityStartBytes,maxLineBytes:config.activityMaxLineBytes,readBytes:config.activityReadBytes});
  // Bounded shutdown (6.9): shutdown abandons slow in-flight observations instead of waiting them out; once everything that matters is
  // closed (ledger, lock, endpoint), end this detached process so abandoned work can't keep it (and its handles) alive.
  const running=await startServer(canonical,{adapters:defaultAdapters(canonical),onClosed:(cleanupError)=>{if(cleanupError)console.error(`room service: shutdown cleanup failed: ${(cleanupError as Error).message??String(cleanupError)}`);process.exit(cleanupError?1:process.exitCode??0);},
    monitor:{observer:new UsageObserver(usage),intervalMs:config.participantRefreshMs,workspace:new NativeWorkspaceProvider(workspaceOptionsFrom(config)),stopGraceMs:config.monitorStopGraceMs},
    activity:{reader:activity,intervalMs:config.activityPollMs},
    accounts:{providers:[claudeProvider(resolveClaudeConfigDir(config.claudeConfigDir),config.claudeUsageApi,config.claudeUsageTimeoutMs,config.accountsStaleMs),new CodexAccountProvider(codexAccountOptionsFrom(config,canonical))],intervalMs:config.accountsPollMs,staleAfterMs:config.accountsStaleMs,stopGraceMs:config.monitorStopGraceMs}});
  for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{void running.close().then(()=>{process.exitCode=0;});});
}catch(error){
  // A competing auto-start won the OS bind. Its clients will find that service during readiness probes.
  if((error as NodeJS.ErrnoException).code!=='EADDRINUSE'){console.error((error as Error).message);process.exitCode=1;}
}
