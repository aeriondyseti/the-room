// 8.1: the registry is the truth for who is in the room. A name that leaves it (rename, removed section) is pruned
// from the ledger and announced once with participant.removed; no later display refresh resurrects it.
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomService} from './service.js';
import {joinParticipant} from '../registry/registry.js';
import type {ParticipantState} from '../../contracts/domain.js';
import type {Caller,Method,Params,Result,RequestFrame,RoomEvent} from '../../contracts/ipc.js';

const a='00000000-0000-4000-8000-00000000000a',b='00000000-0000-4000-8000-00000000000b',c='00000000-0000-4000-8000-00000000000c';
const agent=(sessionId:string):Caller=>({kind:'agent',native:{harness:'codex',sessionId,source:'codex-env'},declaredName:null});
const row=(name:string,sessionId:string):ParticipantState=>({name,harness:'codex',sessionId,liveness:'online',livenessCheckedAt:'2026-09-28T00:00:00Z',activity:'idle',pending:0,usage:null});
async function call<M extends Method>(room:RoomService,method:M,params:Params<M>):Promise<Result<M>>{return await room.handle({v:1,type:'request',id:'test',method,params} as RequestFrame,'cli') as Result<M>;}

async function fixture(t:TestContext){
  const root=await mkdtemp(join(tmpdir(),'vp-participants-'));
  await joinParticipant(root,'claude',{harness:'codex',session_id:a});await joinParticipant(root,'astra',{harness:'codex',session_id:b});
  const room=new RoomService(root);t.after(async()=>{await room.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  // What the monitor would have saved for both names before the rename.
  room.ledger.putParticipant(row('claude',a));room.ledger.putParticipant(row('astra',b));
  const events:RoomEvent[]=[];room.onEvent(e=>events.push(e));
  // The rename, as an agent does it today: its own section moves to a new key, everything else untouched.
  const rename=async()=>writeFile(join(root,'session.toml'),`[participants.fable]\nharness = "codex"\nsession_id = "${a}"\n\n[participants.astra]\nharness = "codex"\nsession_id = "${b}"\n`);
  return {root,room,events,rename};
}
const names=(events:RoomEvent[],type:'participant.updated'|'participant.removed')=>events.filter(e=>e.type===type).map(e=>e.type==='participant.updated'?e.participant.name:e.type==='participant.removed'?e.name:'');

test('after a rename, who lists the new name only, the old ledger row is pruned, and participant.removed is emitted once',async t=>{
  const {room,events,rename}=await fixture(t);await rename();
  const who=await call(room,'who',{});
  assert.deepEqual(who.participants.map(p=>p.name).sort(),['astra','fable']);
  assert.deepEqual(names(events,'participant.removed'),['claude']);
  assert.ok(!room.ledger.participants().some(p=>p.name==='claude'),'ledger row pruned');
  await call(room,'who',{});
  assert.deepEqual(names(events,'participant.removed'),['claude'],'announced once, not on every poll');
});

test('an inbox read or a send after a rename never republishes the departed name',async t=>{
  const {room,events,rename}=await fixture(t);await rename();
  const page=await call(room,'inbox',{caller:agent(a)});
  await call(room,'guarded_send',{caller:agent(a),to:['astra'],body:'under the new name',snapshot:page.snapshot});
  await call(room,'send',{caller:{kind:'human'},to:['fable'],body:'to the new name'});
  await call(room,'inbox',{caller:agent(a)});
  assert.ok(!names(events,'participant.updated').includes('claude'),`ghost republished: ${JSON.stringify(names(events,'participant.updated'))}`);
  assert.ok(!room.ledger.participants().some(p=>p.name==='claude'));
  const who=await call(room,'who',{});
  assert.equal(who.participants.find(p=>p.name==='fable')?.pending,1,'the human message is queued to the new name');
});

test('withdraw after a rename recomputes pending for current participants only',async t=>{
  const {room,events,rename}=await fixture(t);
  const page=await call(room,'inbox',{caller:agent(b)});
  const sent=await call(room,'guarded_send',{caller:agent(b),to:['claude'],body:'to be withdrawn',snapshot:page.snapshot});
  assert.equal(sent.status,'sent');if(sent.status!=='sent')return;
  await rename();events.length=0;
  const outcome=await call(room,'withdraw',{caller:agent(b),messageId:sent.result.message.id});
  assert.ok(outcome.recipients.every(r=>r.disposition==='withdrawn'||r.disposition==='already_submitting'),JSON.stringify(outcome));
  assert.ok(!names(events,'participant.updated').includes('claude'));
  assert.deepEqual(names(events,'participant.removed'),['claude']);
});

test('a rebound name is superseded, not removed',async t=>{
  const {root,room,events}=await fixture(t);
  await joinParticipant(root,'astra',{harness:'codex',session_id:c},{expectedPrevious:{harness:'codex',session_id:b}});
  const who=await call(room,'who',{});
  assert.equal(who.participants.find(p=>p.name==='astra')?.sessionId,c);
  assert.deepEqual(names(events,'participant.removed'),[]);
});

test('a TUI rebuilt from who plus later events never shows the departed name',async t=>{
  const {room,events,rename}=await fixture(t);await rename();
  const who=await call(room,'who',{});events.length=0;
  await call(room,'inbox',{caller:agent(a)});await call(room,'inbox',{caller:agent(b)});
  // The TUI reducer upserts participant.updated by name and drops participant.removed by name: with neither event
  // naming the departed participant, the initial who snapshot is all it ever has.
  const shown=new Set(who.participants.map(p=>p.name));
  for(const e of events){if(e.type==='participant.updated')shown.add(e.participant.name);if(e.type==='participant.removed')shown.delete(e.name);}
  assert.deepEqual([...shown].sort(),['astra','fable']);
});

test('startup reconcile relabels queued deliveries left under a departed name to the binding\'s current name',async t=>{
  const {room,events,rename}=await fixture(t);
  const sent=await call(room,'send',{caller:{kind:'human'},to:['claude'],body:'before the rename'});
  // What the dispatcher does when it finds no registry entry for the recipient name.
  room.ledger.updateDelivery(sent.message.id,'claude',d=>{d.held=true;d.waiting='rebind_needed';});
  await rename();events.length=0;
  assert.equal(await room.reconcile(),1);
  const d=room.ledger.delivery(sent.message.id,'fable');
  assert.equal(d.waiting,null);assert.equal(d.held,false);assert.deepEqual(d.target,{harness:'codex',sessionId:a},'same target: relabelled, not redirected');
  assert.throws(()=>room.ledger.delivery(sent.message.id,'claude'),{code:'not_found'});
  assert.ok(events.some(e=>e.type==='delivery.updated'&&e.delivery.recipient==='fable'));
  assert.equal((await call(room,'who',{})).participants.find(p=>p.name==='fable')?.pending,1);
  assert.deepEqual(room.ledger.read(sent.message.id).message.to,['claude'],'history keeps the old label');
  assert.equal(await room.reconcile(),0,'idempotent');
});

test('reconcile leaves a delivery alone when its binding is no longer registered at all',async t=>{
  const {root,room,rename:_}=await fixture(t);
  const sent=await call(room,'send',{caller:{kind:'human'},to:['claude'],body:'orphaned'});
  await writeFile(join(root,'session.toml'),`[participants.astra]\nharness = "codex"\nsession_id = "${b}"\n`);
  assert.equal(await room.reconcile(),0);
  assert.equal(room.ledger.delivery(sent.message.id,'claude').recipient,'claude');
});
test('a relabelled delivery can still be withdrawn, by default and by its current name; the old name is refused with the current list',async t=>{
  const {room,rename}=await fixture(t);
  const page=await call(room,'inbox',{caller:agent(b)});
  const sent=await call(room,'guarded_send',{caller:agent(b),to:['claude'],body:'take it back',snapshot:page.snapshot});
  assert.equal(sent.status,'sent');if(sent.status!=='sent')return;
  await rename();assert.equal(await room.reconcile(),1);
  await assert.rejects(call(room,'withdraw',{caller:agent(b),messageId:sent.result.message.id,recipients:['claude']}),/current recipients of this message \(fable\)/);
  const outcome=await call(room,'withdraw',{caller:agent(b),messageId:sent.result.message.id});
  assert.deepEqual(outcome.recipients,[{recipient:'fable',disposition:'withdrawn'}]);
  assert.equal(room.ledger.delivery(sent.result.message.id,'fable').state,'withdrawn');
});

test('withdraw recomputes and publishes the pending count of current participants',async t=>{
  const {room,events}=await fixture(t);
  const page=await call(room,'inbox',{caller:agent(b)});
  const sent=await call(room,'guarded_send',{caller:agent(b),to:['claude'],body:'pending one',snapshot:page.snapshot});
  assert.equal(sent.status,'sent');if(sent.status!=='sent')return;
  room.ledger.putParticipant({...row('claude',a),pending:1});events.length=0;
  await call(room,'withdraw',{caller:agent(b),messageId:sent.result.message.id});
  assert.equal(room.ledger.participants().find(p=>p.name==='claude')?.pending,0,'stored row recomputed');
  const published=events.find(e=>e.type==='participant.updated'&&e.participant.name==='claude');
  assert.equal(published&&published.type==='participant.updated'?published.participant.pending:-1,0,'published with the recomputed count');
});

test('relabelQueued: a cleared rebind wait follows the pause for ordinary messages but never for a stop request',async t=>{
  const {room,rename}=await fixture(t);
  const ordinary=await call(room,'send',{caller:{kind:'human'},to:['claude'],body:'ordinary'});
  const paused=await call(room,'pause',{caller:{kind:'human'}});
  const stop=paused.stopRequest;assert.ok(stop,'pause sends a stop request');
  for(const id of [ordinary.message.id,stop.message.id])room.ledger.updateDelivery(id,'claude',d=>{d.held=true;d.waiting='rebind_needed';});
  await rename();assert.equal(await room.reconcile(),2);
  const o=room.ledger.delivery(ordinary.message.id,'fable'),s=room.ledger.delivery(stop.message.id,'fable');
  assert.equal(o.waiting,null);assert.equal(o.held,true,'ordinary: held while paused');
  assert.equal(s.waiting,null);assert.equal(s.held,false,'stop request: never held by pause');
});

test('relabelQueued moves only queued rows: a withdrawn row keeps its old label as history',async t=>{
  const {room,rename}=await fixture(t);
  const page=await call(room,'inbox',{caller:agent(b)});
  const sent=await call(room,'guarded_send',{caller:agent(b),to:['claude'],body:'already withdrawn',snapshot:page.snapshot});
  assert.equal(sent.status,'sent');if(sent.status!=='sent')return;
  await call(room,'withdraw',{caller:agent(b),messageId:sent.result.message.id});
  await rename();assert.equal(await room.reconcile(),0);
  assert.equal(room.ledger.delivery(sent.result.message.id,'claude').state,'withdrawn');
});