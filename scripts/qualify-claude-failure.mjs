// Runs only against the explicitly handed-off 4.2 fixture; never an ordinary room.
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import{RoomClient}from'../dist/ipc/client.js';import{startServer}from'../dist/ipc/server.js';
import{defaultAdapters}from'../dist/core/service/default-adapters.js';import{readRegistry}from'../dist/core/registry/registry.js';
const [input,sessionId]=process.argv.slice(2);const root=await fs.realpath(input);
assert.ok(path.basename(root).startsWith('vpfix-astra42-'));
const registry=await readRegistry(root);assert.equal(Object.keys(registry).length,1);assert.equal(registry.fxh?.session_id,sessionId);assert.equal(registry.fxh?.harness,'claude');
let client=await RoomClient.connect(root,{client:'tui',autoStart:false});let running;
const evidence={at:new Date().toISOString(),sessionId,checks:{}};
const until=async check=>{const end=Date.now()+60000;for(;;){const result=await check();if(result)return result;if(Date.now()>end)throw Error('Live Claude qualification timeout');await new Promise(r=>setTimeout(r,100));}};
try{
 await client.request('shutdown',{caller:{kind:'human'}});client.close();
 await until(async()=>{try{await fs.stat(path.join(root,'.room/service.lock'));return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}});
 process.env.ROOM_CLAUDE_MAX_ENVELOPE_CHARS='1200';
 running=await startServer(root,{adapters:defaultAdapters(root)});client=await RoomClient.connect(root,{client:'tui',autoStart:false});
 const paused=await client.request('pause',{caller:{kind:'human'},stopRequestBody:'TEST HARNESS: pause acceptance check on this disposable session. Acknowledge this stop request through room_send; no additional work is requested.'});
 evidence.checks.stopReply=await until(async()=> (await client.request('read',{afterSeq:paused.stopRequest.message.seq})).items.find(i=>i.message.replyTo===paused.stopRequest.message.id));
 evidence.checks.stopDelivery=(await client.request('deliveries',{messageId:paused.stopRequest.message.id})).deliveries[0];
 const body='TEST HARNESS: reference check. Read the full message with room_read using the id in the envelope before sending your ACK.\n'+'padding " ✓\n'.repeat(500)+'REFERENCE-FULL-BODY';
 const held=await client.request('send',{caller:{kind:'human'},to:['fxh'],body});assert.ok(held.deliveries[0].held);assert.equal(held.deliveries[0].attempts.length,0);evidence.checks.held=true;
 client.close();await running.close();running=await startServer(root,{adapters:defaultAdapters(root)});client=await RoomClient.connect(root,{client:'tui',autoStart:false});
 assert.equal((await client.request('who',{})).room.paused,true);evidence.checks.pauseSurvivesRestart=true;
 await client.request('resume',{caller:{kind:'human'}});
 evidence.checks.referenceReply=await until(async()=> (await client.request('read',{afterSeq:held.message.seq})).items.find(i=>i.message.replyTo===held.message.id));
 evidence.checks.referenceDelivery=(await client.request('deliveries',{messageId:held.message.id})).deliveries[0];assert.equal(evidence.checks.referenceDelivery.referenced,true);
 assert.equal((await client.request('read',{messageId:held.message.id})).items[0].message.body,body);evidence.checks.fullBodyReadable=true;
 await fs.writeFile(path.join(root,'astra42-results.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{client.close();await running?.close();}
