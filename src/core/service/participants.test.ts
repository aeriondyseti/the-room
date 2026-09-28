// 7.8: the registry is the truth for who is in the room. A name that leaves it (rename, removed section) is pruned
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
