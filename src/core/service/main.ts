import { defaultAdapters } from './default-adapters.js';
import { realpath } from 'node:fs/promises';
import { startServer } from '../../ipc/server.js';
import { loadConfig } from '../config.js';
import { UsageObserver, usageObserverOptionsFrom } from '../../observer/index.js';
import { ActivityReader } from '../../observer/activity-reader.js';
import { claudeActivityParser } from '../../observer/claude-activity.js';
import { codexActivityParser } from '../../observer/codex-activity.js';
import { claudeAccountUsageProvider } from '../../adapters/claude/rate-limits.js';
import { resolveClaudeConfigDir } from '../../adapters/claude/registry.js';
const root=process.argv[2];
if(!root)throw new Error('Room service requires a canonical root argument.');
try {
  const canonical=await realpath(root);
  const config=loadConfig();
  const usage=usageObserverOptionsFrom(config);
  const activity=new ActivityReader({claudeProjectsDir:usage.claudeProjectsDir,codexSessionsDir:usage.codexSessionsDir,parsers:[claudeActivityParser,codexActivityParser],
    detailBytes:config.activityDetailBytes,windowItems:config.activityWindowItems,startBytes:config.activityStartBytes,maxLineBytes:config.activityMaxLineBytes,readBytes:config.activityReadBytes});
  const running=await startServer(canonical,{adapters:defaultAdapters(canonical),
    monitor:{observer:new UsageObserver(usage),intervalMs:config.participantRefreshMs},
    activity:{reader:activity,intervalMs:config.activityPollMs},
    accounts:{providers:[claudeAccountUsageProvider({claudeConfigDir:resolveClaudeConfigDir(config.claudeConfigDir)})],intervalMs:config.accountsPollMs,staleAfterMs:config.accountsStaleMs}});
  for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{void running.close().then(()=>{process.exitCode=0;});});
}catch(error){
  // A competing auto-start won the OS bind. Its clients will find that service during readiness probes.
  if((error as NodeJS.ErrnoException).code!=='EADDRINUSE'){console.error((error as Error).message);process.exitCode=1;}
}
