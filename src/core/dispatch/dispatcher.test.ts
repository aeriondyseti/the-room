import assert from 'node:assert/strict';
import { test,type TestContext } from 'node:test';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
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
async function setup(t:TestContext,sendHoldMs:number|null=0){const root=await mkdtemp(path.join(tmpdir(),'room-dispatch-'));const adapter=new FakeAdapter();
 await joinParticipant(root,'astra',{harness:'codex',session_id:a});await joinParticipant(root,'other',{harness:'codex',session_id:b});
 const room=new RoomService(root,[adapter],sendHoldMs===null?{}:{sendHoldMs});t.after(async()=>{await room.close();await rm(root,{recursive:true,force:true});});return{root,room,adapter};}
async function call<M extends Method>(room:RoomService,method:M,params:Params<M>):Promise<Result<M>>{return await room.handle({v:1,type:'request',id:'test',method,params} as RequestFrame,'cli') as Result<M>;}
const send=(room:RoomService,body='hello',to=['astra'])=>call(room,'send',{caller:human,to,body});
const until=async(condition:()=>boolean)=>{const end=Date.now()+2000;while(!condition()){if(Date.now()>end)throw Error('Condition timed out');await new Promise(r=>setTimeout(r,2));}};

test('held burst submits once, claims every member atomically and covers exactly their bodies',async t=>{
 const {room,adapter}=await setup(t,150);
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});adapter.action=async()=>{await gate;return {status:'submitted',evidence:{kind:'codex-queue',nativeId:'batch'}};};
 const first=await send(room,'one');const second=await send(room,'two');
 assert.equal(adapter.sent.length,0);
 await until(()=>adapter.sent.length===1);
 assert.match(adapter.sent[0]!.envelope,/batch=2/);
 for(const msg of [first,second])assert.equal(room.ledger.delivery(msg.message.id,'astra').attempts.at(-1)?.outcome,'in_flight');
 const withdrawn=await call(room,'withdraw',{caller:human,messageId:second.message.id});
 assert.equal(withdrawn.recipients[0]!.disposition,'already_submitting');
 const token=/snapshot: (\S+)/.exec(adapter.sent[0]!.envelope)![1]!;
 assert.equal(room.inbox.uncovered(`codex:${a}`,token),0);
 release();await room.dispatcher.idle();
 for(const msg of [first,second])assert.equal(room.ledger.delivery(msg.message.id,'astra').state,'submitted');
});

test('withdraw during hold excludes the body while the timer dispatches the remaining message',async t=>{
 const {room,adapter}=await setup(t,100);
 const first=await send(room,'remove me');const second=await send(room,'keep me');
 const result=await call(room,'withdraw',{caller:human,messageId:first.message.id});
 assert.equal(result.recipients[0]!.disposition,'withdrawn');
 await until(()=>adapter.sent.length===1);await room.dispatcher.idle();
 assert.equal(adapter.sent[0]!.messageId,second.message.id);
 assert.doesNotMatch(adapter.sent[0]!.envelope,/remove me/);
});

test('settings IPC applies live, restricts writes to human, and can turn the hold off',async t=>{
 const {room,adapter}=await setup(t,null);
 const settings=await call(room,'settings_update',{caller:human,patch:{deliveryHoldMs:0}});
 assert.equal(settings.effective.deliveryHoldMs,0);
 const first=await send(room);await room.dispatcher.idle();assert.equal(adapter.sent[0]!.messageId,first.message.id);
 await assert.rejects(room.handle({v:1,type:'request',id:'x',method:'settings_update',params:{caller:human,patch:{batchHeld:false}}},'mcp'),/human/);
});

test('invalid live settings cannot block human or guarded agent sends',async t=>{
 const {root,room}=await setup(t,null);
 await call(room,'settings_update',{caller:human,patch:{deliveryHoldMs:0}});
 await writeFile(path.join(root,'.roundtable','settings.json'),'broken');
 const settings=await call(room,'settings_get',{});assert.equal(settings.problem?.fallback,'last_good');
 assert.equal((await send(room,'human still sends')).message.body,'human still sends');
 const caller={kind:'agent' as const,native:{harness:'codex' as const,sessionId:b,source:'codex-env' as const},declaredName:'other'};
 const page=await call(room,'inbox',{caller});
 const agent=await call(room,'guarded_send',{caller,to:['astra'],body:'agent still sends',snapshot:page.snapshot});
 assert.equal(agent.status,'sent');
});

test('debounce publishes the revised sibling deadline after persistence',async t=>{
 const {room}=await setup(t,500);
 const first=await send(room,'one');
 const updates:string[]=[];
 room.onEvent(e=>{if(e.type==='delivery.updated'&&e.delivery.messageId===first.message.id){assert.equal(e.delivery.notBefore,room.ledger.delivery(first.message.id,'astra').notBefore);updates.push(e.delivery.notBefore!);}});
 await new Promise(r=>setTimeout(r,10));await send(room,'two');
 assert.equal(updates.length,1);assert.ok(updates[0]!>first.deliveries[0]!.notBefore!);
});

test('batch uncertainty settles every member and never auto-replays',async t=>{
 const {room,adapter}=await setup(t,100);
 adapter.action=async()=>{throw new Error('ambiguous write');};
 const first=await send(room,'one'),second=await send(room,'two');
 await until(()=>adapter.sent.length===1);await room.dispatcher.idle();
 for(const msg of [first,second])assert.equal(room.ledger.delivery(msg.message.id,'astra').state,'uncertain');
 await room.dispatcher.idle();assert.equal(adapter.sent.length,1);
});

test('pause preserves hold deadline and resume releases elapsed burst without another wait',async t=>{
 const {room,adapter}=await setup(t,100);
 await call(room,'pause',{caller:human});await room.dispatcher.idle();adapter.sent=[];
 const first=await send(room,'held one'),second=await send(room,'held two');
 const deadline=room.ledger.delivery(first.message.id,'astra').notBefore!;
 await new Promise(r=>setTimeout(r,150));assert.equal(adapter.sent.length,0);
 await call(room,'resume',{caller:human});await room.dispatcher.idle();
 assert.equal(adapter.sent.length,1);assert.match(adapter.sent[0]!.envelope,/batch=2/);
 assert.equal(room.ledger.delivery(first.message.id,'astra').notBefore,deadline);
 assert.equal(room.ledger.delivery(second.message.id,'astra').state,'submitted');
});
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
 const outcome=await call(room,'guarded_send',{snapshot:room.inbox.review('codex:'+a).snapshot,caller:{kind:'agent',native:{harness:'codex',sessionId:a,source:'codex-env'},declaredName:'astra'},to:['human'],body:'ack',replyTo:first.message.id});
 assert.equal(outcome.status,'sent');if(outcome.status!=='sent')throw Error('Expected sent reply');const reply=outcome.result;
 const delivery=room.ledger.delivery(first.message.id,'astra');assert.equal(delivery.state,'replied');assert.equal(delivery.repliedBy,reply.message.id);
});
test('oversize envelope is explicitly referenced; original content remains intact',async t=>{
 const {root,room,adapter}=await setup(t);adapter.maxEnvelopeChars=760;
 const body='quotes " ✓ '.repeat(200);const saved=await send(room,body);await room.dispatcher.idle();
 assert.equal(room.ledger.read(saved.message.id).message.body,body);assert.equal(room.ledger.delivery(saved.message.id,'astra').referenced,true);
 assert.ok(adapter.sent[0]!.envelope.length<=760);assert.match(adapter.sent[0]!.envelope,/Referenced content/);
 assert.throws(()=>buildEnvelope(root,saved.message,'astra',5),{code:'message_too_large'});
});

test('a room reply received before adapter completion remains replied after settlement',async t=>{
 const {room,adapter}=await setup(t);let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 adapter.action=async()=>{await gate;return{status:'submitted',evidence:{kind:'codex-queue',nativeId:'n'}};};
 const first=await send(room);await until(()=>adapter.sent.length===1);
 const outcome=await call(room,'guarded_send',{snapshot:room.inbox.review('codex:'+a).snapshot,caller:{kind:'agent',native:{harness:'codex',sessionId:a,source:'codex-env'},declaredName:'astra'},to:['human'],body:'already received',replyTo:first.message.id});
 assert.equal(outcome.status,'sent');if(outcome.status!=='sent')throw Error('Expected sent reply');const reply=outcome.result;
 release();await room.dispatcher.idle();const d=room.ledger.delivery(first.message.id,'astra');
 assert.equal(d.state,'replied');assert.equal(d.repliedBy,reply.message.id);assert.equal(d.attempts[0]!.outcome,'submitted');
});
test('definite adapter failure and pre-submission probe exceptions surface without silent retries',async t=>{
 const {room,adapter}=await setup(t);adapter.action=async()=>({status:'failed',error:{code:'internal',message:'before write'}});
 const first=await send(room);await room.dispatcher.idle();assert.equal(room.ledger.delivery(first.message.id,'astra').state,'failed');
 adapter.probe=async()=>{throw Error('query failure');};const second=await send(room);await room.dispatcher.idle();
 const failed=room.ledger.delivery(second.message.id,'astra');assert.equal(failed.state,'failed');assert.match(failed.attempts[0]!.error!.message,/roundtable doctor/);
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

test('dispatcher envelope snapshot covers its own body only, never all prior addressed history',async t=>{
 const {room,adapter}=await setup(t);
 await send(room,'older');await room.dispatcher.idle();
 await send(room,'newer');await room.dispatcher.idle();
 const token=adapter.sent.at(-1)!.envelope.match(/snapshot: ([A-Za-z0-9_-]+)/)?.[1];
 assert.ok(token,'full native envelope carries a service-issued token');
 assert.equal(room.inbox.uncovered('codex:'+a,token),1,'older body is not implicitly credited');
 assert.equal(room.inbox.uncovered('codex:'+b,token),null,'another native binding cannot use it');
});

test('dispatch observations preserve the binding inbox display snapshot',async t=>{
 const {room}=await setup(t);
 for(const participant of await room.participants())room.ledger.putParticipant(participant);
 const page=await call(room,'inbox',{caller:{kind:'agent',native:{harness:'codex',sessionId:a,source:'codex-env'},declaredName:'astra'}});
 await send(room,'new addressed content');await room.dispatcher.idle();
 const state=room.ledger.participants().find(p=>p.name==='astra')!;
 assert.equal(state.inbox?.snapshot,page.snapshot);assert.equal(state.inbox?.uncovered,1);
});

test('withdraw wins during a pending probe, keeps a tombstone, and cannot erase a human-visible copy',async t=>{
 const {room,adapter}=await setup(t);let release!:()=>void;let probing=false;
 adapter.probe=async()=>{probing=true;await new Promise<void>(r=>release=r);return{liveness:'online',activity:'unknown'};};
 const first=await send(room,'cancel me',['astra','human']);await until(()=>probing);
 const outcome=await call(room,'withdraw',{caller:human,messageId:first.message.id});
 assert.deepEqual(outcome.recipients.map(r=>r.disposition),['withdrawn','already_visible']);
 const tombstone=room.ledger.delivery(first.message.id,'astra');assert.ok(tombstone.withdrawnAt);assert.equal(tombstone.state,'withdrawn');
 release();await room.dispatcher.idle();assert.equal(adapter.sent.length,0);
 assert.equal((await call(room,'withdraw',{caller:human,messageId:first.message.id,recipients:['astra']})).recipients[0]?.disposition,'already_withdrawn');
 assert.equal(room.ledger.read(first.message.id).message.body,'cancel me');
 await assert.rejects(call(room,'withdraw',{caller:{kind:'agent',native:{harness:'codex',sessionId:a,source:'codex-env'},declaredName:'astra'},messageId:first.message.id}),{code:'identity_mismatch'});
});

test('withdraw never succeeds after dispatch claim or uncertain native submission',async t=>{
 const {room,adapter}=await setup(t);let release!:(r:SubmitResult)=>void;
 adapter.action=async()=>await new Promise<SubmitResult>(r=>release=r);
 const first=await send(room);await until(()=>adapter.sent.length===1);
 assert.equal((await call(room,'withdraw',{caller:human,messageId:first.message.id})).recipients[0]?.disposition,'already_submitting');
 release({status:'uncertain',error:{code:'service_unavailable',message:'fixture ambiguity'}});await room.dispatcher.idle();
 assert.equal((await call(room,'withdraw',{caller:human,messageId:first.message.id})).recipients[0]?.disposition,'uncertain');
 assert.equal(room.ledger.delivery(first.message.id,'astra').state,'uncertain');
});

test('urgent lane preserves lane FIFO and respects pause before overtaking broker-held normal work',async t=>{
 const {room,adapter}=await setup(t);await call(room,'pause',{caller:human});await room.dispatcher.idle();adapter.sent=[];
 const normal=await send(room,'normal');
 const urgent1=await call(room,'guarded_send',{caller:human,to:['astra'],body:'urgent1',urgent:{reason:'coordination deadline'}});
 const urgent2=await call(room,'guarded_send',{caller:human,to:['astra'],body:'urgent2',urgent:{reason:'follow-up'}});
 assert.equal(urgent1.status,'sent');assert.equal(urgent2.status,'sent');if(urgent1.status!=='sent'||urgent2.status!=='sent')return;
 await room.dispatcher.idle();assert.equal(adapter.sent.length,0);
 assert.equal(room.ledger.delivery(urgent1.result.message.id,'astra').priority,'urgent');
 await call(room,'resume',{caller:human});await room.dispatcher.idle();
 assert.deepEqual(adapter.sent.map(s=>s.messageId),[urgent1.result.message.id,urgent2.result.message.id,normal.message.id]);
});

test('urgent arrival while an ordinary native probe waits changes the next dispatch claim',async t=>{
 const {room,adapter}=await setup(t);let release!:()=>void;let probes=0;
 adapter.probe=async()=>{if(++probes===1)await new Promise<void>(r=>release=r);return{liveness:'online',activity:'unknown'};};
 const normal=await send(room,'normal');await until(()=>probes===1);
 const urgent=await call(room,'guarded_send',{caller:human,to:['astra'],body:'urgent',urgent:{reason:'time critical'}});assert.equal(urgent.status,'sent');if(urgent.status!=='sent')return;
 release();await room.dispatcher.idle();
 assert.deepEqual(adapter.sent.map(s=>s.messageId),[urgent.result.message.id,normal.message.id]);
});

test('snapshot storage failure falls back to the plain envelope, not an oversize failure',async t=>{
 const {room,adapter}=await setup(t);room.inbox.envelopeToken=()=>{throw Error('fixture storage unavailable');};
 const first=await send(room,'deliver despite token issue');await room.dispatcher.idle();
 assert.equal(room.ledger.delivery(first.message.id,'astra').state,'submitted');
 assert.equal(adapter.sent.length,1);assert.ok(!adapter.sent[0]!.envelope.includes('snapshot:'));
});

test('an envelope token omitted for space is discarded from persistent storage',async t=>{
 const {room,adapter,root}=await setup(t);let issued='';const original=room.inbox.envelopeToken.bind(room.inbox);
 room.inbox.envelopeToken=(scope,messageId)=>{issued=original(scope,messageId);return issued;};
 const first=room.ledger.enqueue({sender:{name:'human',kind:'human',identity:{mode:'human',source:'tui'}},senderScope:'human',body:'body',requestedRecipients:['astra'],recipients:[{name:'astra',target:{harness:'codex',sessionId:a}}],addressing:'direct'});
 adapter.maxEnvelopeChars=buildEnvelope(root,first.message,'astra',24000).text.length;
 await room.dispatcher.idle();assert.ok(issued);assert.equal(room.ledger.crossing(issued,'codex:'+a,'snapshot'),null);
 assert.equal(room.ledger.delivery(first.message.id,'astra').state,'submitted');
});
