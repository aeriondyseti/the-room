// Qualification-only process: explicit fake adapters, never production native transports.
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { startServer } from '../ipc/server.js';
import type { DeliveryAdapter } from '../contracts/adapter.js';
const [root,mode]=process.argv.slice(2);
if(!root||!['offline','online','crash'].includes(mode??''))throw Error('Fixture requires root and offline|online|crash.');
const adapters:DeliveryAdapter[]=(['codex','claude'] as const).map(harness=>({
 harness,maxEnvelopeChars:1000,
 probe:async()=>({liveness:mode==='offline'?'offline':'unknown',activity:'unknown'}),
 submit:async request=>{
  appendFileSync(path.join(root,'native-attempts.jsonl'),JSON.stringify(request)+'\n');
  // Simulate native acceptance followed by sudden service death before receipt persistence.
  if(mode==='crash')process.exit(89);
  return {status:'submitted',evidence:harness==='codex'?{kind:'codex-queue',nativeId:'fixture-acceptance'}:{kind:'claude-pipe-write',pid:123}};
 },
}));
const running=await startServer(root,{adapters});
console.log('READY');
process.on('SIGTERM',()=>void running.close());
