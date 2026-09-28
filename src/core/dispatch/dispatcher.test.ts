import assert from 'node:assert/strict';
import { test,type TestContext } from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';
import {RoomService} from '../service/service.js';
import {joinParticipant} from '../registry/registry.js';
import type {DeliveryAdapter,SubmitRequest,SubmitResult,LivenessProbe} from '../../contracts/adapter.js';
import type {Params,Method,RequestFrame,Result} from '../../contracts/ipc.js';
import {buildEnvelope} from './envelope.js';
const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002';
const human={kind:'human' as const};
class FakeAdapter implements DeliveryAdapter {
 runtimeContext={harness:'codex' as const,executable:'fixture.exe',home:'fixture-home'};
 readonly harness='codex' as const;maxEnvelopeChars=24000;sent:SubmitRequest[]=[];offline=new Set<string>();
 action:(request:SubmitRequest)=>Promise<SubmitResult>=async()=>({status:'submitted',evidence:{kind:'codex-queue',nativeId:'native'}});
 async probe(target:{sessionId:string}):Promise<LivenessProbe>{return{liveness:this.offline.has(target.sessionId)?'offline':'online',activity:'unknown'};}
 async submit(request:SubmitRequest):Promise<SubmitResult>{this.sent.push(request);return this.action(request);}
}
async function setup(t:TestContext){const root=await mkdtemp(path.join(tmpdir(),'room-dispatch-'));const adapter=new FakeAdapter();
 await joinParticipant(root,'astra',{harness:'codex',session_id:a});await joinParticipant(root,'other',{harness:'codex',session_id:b});
 const room=new RoomService(root,[adapter]);t.after(async()=>{await room.close();await rm(root,{recursive:true,force:true});});return{root,room,adapter};}
async function call<M extends Method>(room:RoomService,method:M,params:Params<M>):Promise<Result<M>>{return await room.handle({v:1,type:'request',id:'test',method,params} as RequestFrame,'cli') as Result<M>;}
const send=(room:RoomService,body='hello',to=['astra'])=>call(room,'send',{caller:human,to,body});
const until=async(condition:()=>boolean)=>{const end=Date.now()+2000;while(!condition()){if(Date.now()>end)throw Error('Condition timed out');await new Promise(r=>setTimeout(r,2));}};
test('one worker per recipient preserves ordered messages while offline peers do not block',async t=>{
 const {room,adapter}=await setup(t);adapter.offline.add(a);
 const first=await send(room,'broadcast',['all']);await room.dispatcher.idle();
 assert.equal(room.ledger.delivery(first.message.id,'astra').waiting,'offline');
 assert.equal(room.ledger.delivery(first.message.id,'other').state,'submitted');
 adapter.offline.clear();await send(room,'second');await room.dispatcher.idle();
 assert.deepEqual(adapter.sent.filter(s=>s.recipient==='astra').map(s=>s.messageId),[first.message.id,room.ledger.list(null,1).items[0]!.message.id]);
});
test('busy adapter serializes its recipient while a second recipient keeps working',async t=>{
 const {room,adapter}=await setup(t);let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 adapter.action=async r=>{if(r.recipient==='astra')await gate;return{status:'submitted',evidence:{kind:'codex-queue',nativeId:'n'}};};
 const first=await send(room,'first');await until(()=>adapter.sent.length===1);
 const second=await send(room,'second');const peer=await send(room,'peer',['other']);
 await until(()=>room.ledger.delivery(peer.message.id,'other').state==='submitted');
 assert.equal(adapter.sent.filter(s=>s.recipient==='astra').length,1);release();await room.dispatcher.idle();
 assert.deepEqual(adapter.sent.filter(s=>s.recipient==='astra').map(s=>s.messageId),[first.message.id,second.message.id]);
});
test('pause holds ordinary deliveries but exempts one stop request; repeated pause is idempotent',async t=>{
 const {room,adapter}=await setup(t);adapter.offline.add(a);
 const first=await send(room,'queued');await room.dispatcher.idle();
 const pause=await call(room,'pause',{caller:human});const again=await call(room,'pause',{caller:human});
 assert.equal(again.stopRequest,null);assert.equal(pause.stopRequest!.message.id,again.room.stopRequestId);
 const later=await send(room,'held');adapter.offline.clear();await room.dispatcher.idle();
 assert.equal(room.ledger.delivery(first.message.id,'astra').held,true);assert.equal(room.ledger.delivery(later.message.id,'astra').held,true);
 assert.equal(room.ledger.delivery(pause.stopRequest!.message.id,'astra').state,'submitted');
 const resumed=await call(room,'resume',{caller:human});assert.equal(resumed.released,2);await room.dispatcher.idle();
 assert.deepEqual(adapter.sent.filter(s=>s.recipient==='astra').map(s=>s.messageId),[pause.stopRequest!.message.id,first.message.id,later.message.id]);
});
test('pause while probing cannot submit the now-held ordinary message',async t=>{
 const {room,adapter}=await setup(t);let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let probing=false;
 adapter.probe=async()=>{probing=true;await gate;return{liveness:'online',activity:'unknown'};};
 const first=await send(room);await until(()=>probing);const paused=await call(room,'pause',{caller:human});release();await room.dispatcher.idle();
 assert.equal(room.ledger.delivery(first.message.id,'astra').held,true);
 assert.ok(adapter.sent.every(r=>r.messageId===paused.stopRequest!.message.id));
});
test('failed and uncertain attempts are not automatically retried; explicit retry preserves history',async t=>{
 const {room,adapter}=await setup(t);adapter.action=async()=>({status:'uncertain',error:{code:'internal',message:'after write'}});
 const first=await send(room);await room.dispatcher.idle();await room.dispatcher.idle();assert.equal(adapter.sent.length,1);
 assert.equal(room.ledger.delivery(first.message.id,'astra').state,'uncertain');
 adapter.action=async()=>({status:'submitted',evidence:{kind:'codex-queue',nativeId:'n'}});
 await call(room,'retry',{caller:human,messageId:first.message.id,recipient:'astra'});await room.dispatcher.idle();
 const delivery=room.ledger.delivery(first.message.id,'astra');assert.equal(delivery.state,'submitted');assert.deepEqual(delivery.attempts.map(a=>a.outcome),['uncertain','submitted']);
});
test('startup converts a durable in-flight attempt to uncertain without native replay',async t=>{
 const {room,adapter}=await setup(t);adapter.offline.add(a);const first=await send(room);await room.dispatcher.idle();
 room.ledger.updateDelivery(first.message.id,'astra',d=>{d.attempts.push({n:1,startedAt:'before crash',finishedAt:null,outcome:'in_flight',evidence:null,error:null});});
 room.dispatcher.recover();adapter.offline.clear();await room.dispatcher.idle();assert.equal(adapter.sent.length,0);
 assert.equal(room.ledger.delivery(first.message.id,'astra').state,'uncertain');
});
test('registration rotation holds old snapshots but allows messages addressed to the new binding',async t=>{
 const {room,adapter,root}=await setup(t);adapter.offline.add(a);const first=await send(room);await room.dispatcher.idle();
 const next='00000000-0000-4000-8000-000000000003';await joinParticipant(root,'astra',{harness:'codex',session_id:next},{expectedPrevious:{harness:'codex',session_id:a}});
 const second=await send(room,'new binding');await room.dispatcher.idle();
 assert.equal(room.ledger.delivery(first.message.id,'astra').waiting,'rebind_needed');assert.equal(room.ledger.delivery(first.message.id,'astra').target.sessionId,a);
 assert.equal(room.ledger.delivery(second.message.id,'astra').state,'submitted');assert.equal(adapter.sent[0]!.target.sessionId,next);
 await call(room,'resume',{caller:human});assert.equal(room.ledger.delivery(first.message.id,'astra').held,true);
});
test('room replies mark only the matching native recipient and do not mean task success',async t=>{
 const {room}=await setup(t);const first=await send(room);await room.dispatcher.idle();
 const reply=await call(room,'send',{caller:{kind:'agent',native:{harness:'codex',sessionId:a,source:'codex-env'},declaredName:'astra'},to:['human'],body:'ack',replyTo:first.message.id});
 const delivery=room.ledger.delivery(first.message.id,'astra');assert.equal(delivery.state,'replied');assert.equal(delivery.repliedBy,reply.message.id);
});
test('oversize envelope is explicitly referenced; original content remains intact',async t=>{
 const {root,room,adapter}=await setup(t);adapter.maxEnvelopeChars=700;
 const body='quotes " ✓ '.repeat(200);const saved=await send(room,body);await room.dispatcher.idle();
 assert.equal(room.ledger.read(saved.message.id).message.body,body);assert.equal(room.ledger.delivery(saved.message.id,'astra').referenced,true);
 assert.ok(adapter.sent[0]!.envelope.length<=700);assert.match(adapter.sent[0]!.envelope,/Referenced content/);
 assert.throws(()=>buildEnvelope(root,saved.message,'astra',5),{code:'message_too_large'});
});

test('a room reply received before adapter completion remains replied after settlement',async t=>{
 const {room,adapter}=await setup(t);let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 adapter.action=async()=>{await gate;return{status:'submitted',evidence:{kind:'codex-queue',nativeId:'n'}};};
 const first=await send(room);await until(()=>adapter.sent.length===1);
 const reply=await call(room,'send',{caller:{kind:'agent',native:{harness:'codex',sessionId:a,source:'codex-env'},declaredName:'astra'},to:['human'],body:'already received',replyTo:first.message.id});
 release();await room.dispatcher.idle();const d=room.ledger.delivery(first.message.id,'astra');
 assert.equal(d.state,'replied');assert.equal(d.repliedBy,reply.message.id);assert.equal(d.attempts[0]!.outcome,'submitted');
});
test('definite adapter failure and pre-submission probe exceptions surface without silent retries',async t=>{
 const {room,adapter}=await setup(t);adapter.action=async()=>({status:'failed',error:{code:'internal',message:'before write'}});
 const first=await send(room);await room.dispatcher.idle();assert.equal(room.ledger.delivery(first.message.id,'astra').state,'failed');
 adapter.probe=async()=>{throw Error('query failure');};const second=await send(room);await room.dispatcher.idle();
 const failed=room.ledger.delivery(second.message.id,'astra');assert.equal(failed.state,'failed');assert.match(failed.attempts[0]!.error!.message,/room doctor/);
 assert.equal(adapter.sent.length,1);
});

test('pause holds a previously in-flight ordinary delivery when it returns unavailable',async t=>{
 const {room,adapter}=await setup(t);let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let firstAttempt=true;
 adapter.action=async()=>{if(firstAttempt){firstAttempt=false;await gate;return{status:'unavailable',reason:'offline',detail:'closed before write'};}return{status:'submitted',evidence:{kind:'codex-queue',nativeId:'n'}};};
 const first=await send(room);await until(()=>adapter.sent.length===1);const pause=await call(room,'pause',{caller:human});
 release();await room.dispatcher.idle();await room.dispatcher.idle();
 assert.equal(room.ledger.delivery(first.message.id,'astra').held,true);
 assert.equal(adapter.sent.filter(r=>r.messageId===first.message.id).length,1);
 assert.equal(room.ledger.delivery(pause.stopRequest!.message.id,'astra').state,'submitted');
});
test('concurrent retry requests cannot both reset the same delivery generation',async t=>{
 const {room,adapter}=await setup(t);adapter.action=async()=>({status:'uncertain',error:{code:'internal',message:'unknown'}});
 const first=await send(room);await room.dispatcher.idle();
 const results=await Promise.allSettled([call(room,'retry',{caller:human,messageId:first.message.id,recipient:'astra'}),call(room,'retry',{caller:human,messageId:first.message.id,recipient:'astra'})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);await room.dispatcher.idle();
 assert.equal(adapter.sent.length,2);
});
test('a probe failure after pause never marks the exempt stop request failed',async t=>{
 const {room,adapter}=await setup(t);let reject!:()=>void;let probing=false;let firstProbe=true;
 const gate=new Promise<void>((_,fail)=>{reject=()=>fail(Error('old probe failed'));});
 adapter.probe=async()=>{if(firstProbe){firstProbe=false;probing=true;await gate;}return{liveness:'online',activity:'unknown'};};
 const first=await send(room);await until(()=>probing);const pause=await call(room,'pause',{caller:human});reject();
 await room.dispatcher.idle();await room.dispatcher.idle();
 assert.equal(room.ledger.delivery(first.message.id,'astra').held,true);
 assert.equal(room.ledger.delivery(pause.stopRequest!.message.id,'astra').state,'submitted');
});
test('each native envelope lists the whole broadcast recipient snapshot',async t=>{
 const {room,adapter}=await setup(t);await send(room,'coordinate',['all']);await room.dispatcher.idle();
 assert.equal(adapter.sent.length,2);for(const sent of adapter.sent)assert.match(sent.envelope,/to=astra,other delivery_to=/);
});


test('native context is persisted before submission and survives uncertain outcomes',async t=>{
 const {room,adapter}=await setup(t);const original={...adapter.runtimeContext};
 adapter.action=async request=>{
  assert.deepEqual(room.ledger.delivery(request.messageId,request.recipient).attempts.at(-1)!.runtimeContext,original);
  adapter.runtimeContext.home='changed-after-submission';
  return {status:'uncertain',error:{code:'internal',message:'simulated lost receipt'}};
 };
 const first=await send(room);await room.dispatcher.idle();
 assert.deepEqual(room.ledger.delivery(first.message.id,'astra').attempts[0]!.runtimeContext,original);
});
