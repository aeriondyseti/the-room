import { defaultAdapters } from './default-adapters.js';
import { realpath } from 'node:fs/promises';
import { startServer } from '../../ipc/server.js';
import { loadConfig } from '../config.js';
import { UsageObserver, usageObserverOptionsFrom } from '../../observer/index.js';
const root=process.argv[2];
if(!root)throw new Error('Room service requires a canonical root argument.');
try {
  const canonical=await realpath(root);
  const config=loadConfig();
  const running=await startServer(canonical,{adapters:defaultAdapters(canonical),
    monitor:{observer:new UsageObserver(usageObserverOptionsFrom(config)),intervalMs:config.participantRefreshMs}});
  for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{void running.close().then(()=>{process.exitCode=0;});});
}catch(error){
  // A competing auto-start won the OS bind. Its clients will find that service during readiness probes.
  if((error as NodeJS.ErrnoException).code!=='EADDRINUSE'){console.error((error as Error).message);process.exitCode=1;}
}
