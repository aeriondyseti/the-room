// Live qualification, never normal participants: the caller must supply an owned throwaway manifest.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {startServer} from '../dist/ipc/server.js';
import {RoomClient} from '../dist/ipc/client.js';
import {defaultAdapters} from '../dist/core/service/default-adapters.js';
import {joinParticipant} from '../dist/core/registry/registry.js';
const root=await fs.realpath(process.argv[2]);
const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
assert.equal(manifest.purpose,'room-failure-qualification');
assert.equal(manifest.threads.length,1);
const target=manifest.threads[0].id;
process.env.ROOM_CODEX_MAX_ENVELOPE_CHARS='1200';
await joinParticipant(root,'fixture',{harness:'codex',session_id:target});
let running=await startServer(root,{adapters:defaultAdapters(root)});
let client=await RoomClient.connect(root,{client:'cli',autoStart:false});
const evidence={at:new Date().toISOString(),threadId:target,checks:{},processingEvidence:false};
async function accepted(messageId){
 const deadline=Date.now()+15000;
 for(;;){const d=(await client.request('deliveries',{messageId})).deliveries[0];
  if(d.state==='submitted')return d;
  if(d.state==='failed'||d.state==='uncertain')throw Error(JSON.stringify(d));
  if(Date.now()>deadline)throw Error('Native acceptance timeout');
  await new Promise(r=>setTimeout(r,25));
 }
}
try{
 const paused=await client.request('pause',{caller:{kind:'human'},stopRequestBody:'TEST HARNESS: stop request qualification on this disposable session. No ongoing task; acknowledge only if running.'});
 evidence.checks.stopRequest=await accepted(paused.stopRequest.message.id);
 const marker=`REFERENCE-END-${Date.now().toString(36)}`;
 const body='TEST HARNESS: oversized reference qualification.\n'+'padding ✓ "quotes"\n'.repeat(500)+'\n'+marker;
 const held=await client.request('send',{caller:{kind:'human'},to:['fixture'],body});
 assert.ok(held.deliveries[0].held);assert.equal(held.deliveries[0].attempts.length,0);
 evidence.checks.heldBeforeResume=true;
 client.close();await running.close();
 running=await startServer(root,{adapters:defaultAdapters(root)});client=await RoomClient.connect(root,{client:'cli',autoStart:false});
 assert.equal((await client.request('who',{})).room.paused,true);
 assert.equal((await client.request('deliveries',{messageId:held.message.id})).deliveries[0].held,true);
 evidence.checks.pauseSurvivesRestart=true;
 await client.request('resume',{caller:{kind:'human'}});
 evidence.checks.resumed=await accepted(held.message.id);assert.equal(evidence.checks.resumed.referenced,true);
 const read=(await client.request('read',{messageId:held.message.id})).items[0];assert.equal(read.message.body,body);
 evidence.checks.fullBodyReadable=true;evidence.reference={messageId:held.message.id,marker};
 await fs.writeFile(path.join(root,'native-results.json'),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify(evidence));
}finally{client.close();await running.close();}
