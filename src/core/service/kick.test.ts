import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller, Method, Params, RequestFrame, Result, RoomEvent } from '../../contracts/ipc.js';
import { RoomService } from './service.js';
import { openKickProposal } from './kick-vote.js';
import type { DeliveryAdapter } from '../../contracts/adapter.js';
import { joinParticipant, readRegistry, removeRegistryParticipant, renameParticipant } from '../registry/registry.js';
import { setTimeout as delay } from 'node:timers/promises';

const a='00000000-0000-4000-8000-00000000000a',b='00000000-0000-4000-8000-00000000000b',c='00000000-0000-4000-8000-00000000000c';
const agent=(sessionId:string):Caller=>({kind:'agent',native:{harness:'codex',sessionId,source:'codex-env'},declaredName:null});
async function call<M extends Method>(room:RoomService,method:M,params:Params<M>):Promise<Result<M>>{
  return await room.handle({v:1,type:'request',id:'test',method,params} as RequestFrame,'cli') as Result<M>;
}
async function joinThree(room:RoomService):Promise<void>{
  for(const [name,sessionId] of [['astra',a],['fable',b],['target',c]]){
    await call(room,'join',{name:name!,native:{harness:'codex',sessionId:sessionId!,source:'codex-env'}});
    const p=room.ledger.participants().find(row=>row.name===name)!;
    room.ledger.putParticipant({...p,liveness:'online',activity:'idle',livenessCheckedAt:new Date().toISOString()});
  }
}

test('two online non-target agents vote once each; unanimous kick cancels only queued target deliveries',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vp-kick-'));const room=new RoomService(root);
  t.after(async()=>{await room.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  await joinThree(room);const events:RoomEvent[]=[];room.onEvent(event=>events.push(event));
  const sent=await call(room,'send',{caller:{kind:'human'},to:['target'],body:'pending'});
  const opened=await call(room,'kick',{caller:agent(a),name:'target',reason:'no longer participating'});
  assert.equal(opened.status,'open');if(opened.status!=='open')return;
  assert.deepEqual(opened.proposal.voters.map(v=>v.name),['astra','fable']);
  assert.equal(opened.vote,'recorded');
  assert.equal((await call(room,'kick',{caller:agent(a),name:'target'})).status,'open');
  const targetReply=await call(room,'kick',{caller:agent(c),name:'target'});
  assert.equal(targetReply.status,'open');if(targetReply.status==='open')assert.equal(targetReply.vote,'target');
  const done=await call(room,'kick',{caller:agent(b),name:'target'});
  assert.equal(done.status,'executed');if(done.status!=='executed')return;
  assert.equal(done.vote,'recorded');assert.equal(done.proposal?.status,'executed');
  assert.equal(room.ledger.delivery(sent.message.id,'target').state,'withdrawn');
  assert.equal(room.ledger.delivery(sent.message.id,'target').withdrawalCause,'kick');
  assert.deepEqual((await call(room,'who',{})).participants.map(p=>p.name).sort(),['astra','fable']);
  assert.ok(events.some(e=>e.type==='participant.removed'&&e.name==='target'));
  assert.equal(room.ledger.read(done.noticeId!).message.from.kind,'system');
  await assert.rejects(call(room,'inbox',{caller:agent(c)}),{code:'not_registered'});
});

test('an open proposal survives restart and the human can kick immediately without a proposal',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vp-kick-restart-'));let room=new RoomService(root);
  t.after(async()=>{await room.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  await joinThree(room);
  const opened=await call(room,'kick',{caller:agent(a),name:'target',reason:'proposal survives'});
  assert.equal(opened.status,'open');
  await room.close();room=new RoomService(root);await room.start();
  const voted=await call(room,'kick',{caller:agent(b),name:'target'});
  assert.equal(voted.status,'executed');
  const human=await call(room,'kick',{caller:{kind:'human'},name:'fable',reason:'remove now'});
  assert.equal(human.status,'executed');if(human.status==='executed')assert.equal(human.vote,'human');
  assert.deepEqual((await call(room,'who',{})).participants.map(p=>p.name),['astra']);
});

test('an unknown other agent is disclosed but does not block the authenticated proposer',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vp-kick-unknown-'));const room=new RoomService(root);
  t.after(async()=>{await room.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  await joinThree(room);
  const fable=room.ledger.participants().find(p=>p.name==='fable')!;
  room.ledger.putParticipant({...fable,liveness:'unknown',livenessCheckedAt:new Date().toISOString()});
  const done=await call(room,'kick',{caller:agent(a),name:'target',reason:'only one qualified voter'});
  assert.equal(done.status,'executed');
  if(done.status==='executed')assert.deepEqual(done.proposal?.excluded,[{name:'fable',reason:'unknown'}]);
});

test('startup finishes a unanimous proposal interrupted before registry removal',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vp-kick-recover-'));let room=new RoomService(root);
  t.after(async()=>{await room.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  await joinThree(room);
  const pending=await call(room,'send',{caller:{kind:'human'},to:['target'],body:'must be cancelled'});
  const now=new Date();
  const proposal=openKickProposal({astra:{harness:'codex',session_id:a},fable:{harness:'codex',session_id:b},target:{harness:'codex',session_id:c}},room.ledger.participants(),
    'target',{harness:'codex',sessionId:a},'approved before crash',now,5000,600_000);
  proposal.voters=proposal.voters.map(v=>({...v,votedAt:now.toISOString()}));
  room.ledger.putKickProposal(proposal);
  await room.close();room=new RoomService(root);await room.start();
  assert.deepEqual((await call(room,'who',{})).participants.map(p=>p.name).sort(),['astra','fable']);
  assert.equal(room.ledger.delivery(pending.message.id,'target').withdrawalCause,'kick');
  assert.equal(room.ledger.openKickProposal({harness:'codex',sessionId:c}),null);
});

test('an expired proposal closes on restart without removing its target',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vp-kick-expire-'));let room=new RoomService(root);
  t.after(async()=>{await room.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  await joinThree(room);
  const now=new Date();
  const proposal=openKickProposal({astra:{harness:'codex',session_id:a},fable:{harness:'codex',session_id:b},target:{harness:'codex',session_id:c}},room.ledger.participants(),
    'target',{harness:'codex',sessionId:a},'will expire',now,5000,600_000);
  room.ledger.putKickProposal({...proposal,expiresAt:new Date(now.getTime()-1).toISOString()});
  await room.close();room=new RoomService(root);await room.start();
  assert.deepEqual((await call(room,'who',{})).participants.map(p=>p.name).sort(),['astra','fable','target']);
  assert.equal(room.ledger.openKickProposal({harness:'codex',sessionId:c}),null);
  assert.ok(room.ledger.list(null,10).items.some(item=>item.message.kind==='system'&&item.message.body.includes('expired')));
});

test('a human kick interrupted after registry removal completes its queued tombstones on restart',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vp-kick-human-recover-'));let room=new RoomService(root);
  t.after(async()=>{await room.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  await joinThree(room);
  const pending=await call(room,'send',{caller:{kind:'human'},to:['target'],body:'cancel after crash'});
  room.ledger.putHumanKickIntent({id:'interrupted-human-kick',target:{name:'target',harness:'codex',sessionId:c},reason:'human requested removal',createdAt:new Date().toISOString()});
  await removeRegistryParticipant(root,'target',{harness:'codex',session_id:c});
  await room.close();room=new RoomService(root);await room.start();
  assert.equal(room.ledger.delivery(pending.message.id,'target').withdrawalCause,'kick');
  assert.deepEqual(room.ledger.humanKickIntents(),[]);
  assert.deepEqual((await call(room,'who',{})).participants.map(p=>p.name).sort(),['astra','fable']);
});

test('a pending human kick follows its binding if the name changes during downtime',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vp-kick-human-rename-'));let room=new RoomService(root);
  t.after(async()=>{await room.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  await joinThree(room);
  const pending=await call(room,'send',{caller:{kind:'human'},to:['target'],body:'cancel for binding'});
  room.ledger.putHumanKickIntent({id:'interrupted-before-rename',target:{name:'target',harness:'codex',sessionId:c},reason:'human requested removal',createdAt:new Date().toISOString()});
  await renameParticipant(root,'target','newtarget',{harness:'codex',session_id:c});
  await room.close();room=new RoomService(root);await room.start();
  assert.equal(room.ledger.delivery(pending.message.id,'newtarget').withdrawalCause,'kick');
  assert.deepEqual(room.ledger.humanKickIntents(),[]);
  assert.deepEqual((await call(room,'who',{})).participants.map(p=>p.name).sort(),['astra','fable']);
});

test('recovering a human kick never removes a replacement binding at the old name',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vp-kick-human-rebind-'));let room=new RoomService(root);
  t.after(async()=>{await room.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  await joinThree(room);
  const pending=await call(room,'send',{caller:{kind:'human'},to:['target'],body:'old binding only'});
  room.ledger.putHumanKickIntent({id:'interrupted-before-rebind',target:{name:'target',harness:'codex',sessionId:c},reason:'remove the old binding',createdAt:new Date().toISOString()});
  await removeRegistryParticipant(root,'target',{harness:'codex',session_id:c});
  await joinParticipant(root,'target',{harness:'codex',session_id:'00000000-0000-4000-8000-00000000000d'});
  await room.close();room=new RoomService(root);await room.start();
  assert.equal(room.ledger.delivery(pending.message.id,'target').withdrawalCause,'kick');
  assert.deepEqual(room.ledger.humanKickIntents(),[]);
  assert.equal((await readRegistry(root)).target?.session_id,'00000000-0000-4000-8000-00000000000d');
});

test('kick waits for an accepted native handoff and cancels only the still-queued delivery',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vp-kick-in-flight-'));
  let release!:()=>void,started!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const entered=new Promise<void>(resolve=>{started=resolve;});
  const adapter:DeliveryAdapter={harness:'codex',maxEnvelopeChars:24_000,
    probe:async()=>({liveness:'online',activity:'idle'}),
    submit:async()=>{started();await held;return{status:'submitted',evidence:{kind:'codex-queue',nativeId:'native-1'}};}};
  const room=new RoomService(root,[adapter],{sendHoldMs:0});
  t.after(async()=>{release();await room.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  await call(room,'join',{name:'target',native:{harness:'codex',sessionId:c,source:'codex-env'}});await room.start();
  const accepted=await call(room,'send',{caller:{kind:'human'},to:['target'],body:'already handed to native session'});
  await entered;
  const pending=await call(room,'send',{caller:{kind:'human'},to:['target'],body:'still queued in the room'});
  const kicking=call(room,'kick',{caller:{kind:'human'},name:'target',reason:'stop future room deliveries'});
  let removed=false;
  for(let i=0;i<100;i++){if(!Object.hasOwn(await readRegistry(root),'target')){removed=true;break;}await delay(5);}
  assert.equal(removed,true,'kick removed the registry binding before the native handoff settled');
  release();await kicking;
  assert.equal(room.ledger.delivery(accepted.message.id,'target').state,'submitted');
  assert.equal(room.ledger.delivery(pending.message.id,'target').state,'withdrawn');
  assert.equal(room.ledger.delivery(pending.message.id,'target').withdrawalCause,'kick');
});
