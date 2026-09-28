import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller, Method, Params, RequestFrame, Result, RoomEvent } from '../../contracts/ipc.js';
import type { DeliveryAdapter } from '../../contracts/adapter.js';
import { readRegistry } from '../registry/registry.js';
import { RoomService } from './service.js';

const a='00000000-0000-4000-8000-00000000000a',b='00000000-0000-4000-8000-00000000000b';
const agent=(sessionId:string):Caller=>({kind:'agent',native:{harness:'codex',sessionId,source:'codex-env'},declaredName:null});
async function call<M extends Method>(room:RoomService,method:M,params:Params<M>):Promise<Result<M>>{
  return await room.handle({v:1,type:'request',id:'test',method,params} as RequestFrame,'cli') as Result<M>;
}

test('self-rename relabels queued deliveries without redirecting, and keeps the current inbox token usable',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vp-rename-'));const room=new RoomService(root);
  t.after(async()=>{await room.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  await call(room,'join',{name:'old',native:{harness:'codex',sessionId:a,source:'codex-env'}});
  await call(room,'join',{name:'other',native:{harness:'codex',sessionId:b,source:'codex-env'}});
  const events:RoomEvent[]=[];room.onEvent(event=>events.push(event));
  const sent=await call(room,'send',{caller:{kind:'human'},to:['old'],body:'before rename'});
  const reviewed=await call(room,'inbox',{caller:agent(a)});
  const renamed=await call(room,'rename',{caller:agent(a),newName:'new'});
  assert.deepEqual(renamed.registration,{name:'new',harness:'codex',sessionId:a});
  assert.equal(renamed.relabeled,1);
  assert.equal(room.ledger.delivery(sent.message.id,'new').target.sessionId,a);
  assert.deepEqual(room.ledger.read(sent.message.id).message.to,['old']);
  assert.throws(()=>room.ledger.delivery(sent.message.id,'old'),{code:'not_found'});
  assert.deepEqual((await call(room,'who',{})).participants.map(p=>p.name).sort(),['new','other']);
  assert.ok(events.some(e=>e.type==='participant.removed'&&e.name==='old'));
  const notice=room.ledger.read(renamed.noticeId!).message;
  assert.equal(notice.from.kind,'system');
  assert.deepEqual(notice.to.sort(),['human','other']);
  assert.equal((await call(room,'guarded_send',{caller:agent(a),to:['human'],body:'next',snapshot:reviewed.snapshot})).status,'sent');
  await assert.rejects(call(room,'send',{caller:{kind:'human'},to:['old'],body:'old address'}),/renamed to new/);
});

test('rename during an old-name probe lets the old worker exit and submits once under the new name',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vp-rename-race-'));
  let releaseProbe!:()=>void,probeStarted!:()=>void;
  const blocked=new Promise<void>(resolve=>{releaseProbe=resolve;});
  const started=new Promise<void>(resolve=>{probeStarted=resolve;});
  let probes=0;const submitted:{messageId:string;recipient:string}[]=[];
  const adapter:DeliveryAdapter={harness:'codex',maxEnvelopeChars:24_000,
    probe:async()=>{if(++probes===1){probeStarted();await blocked;}return{liveness:'online',activity:'idle'};},
    submit:async request=>{submitted.push({messageId:request.messageId,recipient:request.recipient});return{status:'submitted',evidence:{kind:'codex-queue',nativeId:null}};}};
  const room=new RoomService(root,[adapter],{sendHoldMs:0});
  t.after(async()=>{releaseProbe();await room.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  await call(room,'join',{name:'old',native:{harness:'codex',sessionId:a,source:'codex-env'}});
  await call(room,'join',{name:'other',native:{harness:'codex',sessionId:b,source:'codex-env'}});
  await room.start();
  const sent=await call(room,'send',{caller:{kind:'human'},to:['old'],body:'race'});
  await started;
  await call(room,'rename',{caller:agent(a),newName:'new'});
  releaseProbe();
  await room.dispatcher.idle();
  assert.deepEqual(submitted.filter(s=>s.messageId===sent.message.id),[{messageId:sent.message.id,recipient:'new'}]);
  assert.equal(room.ledger.delivery(sent.message.id,'new').state,'submitted');
});

test('rename refuses a delivery-key collision before changing the registry',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vp-rename-conflict-'));const room=new RoomService(root);
  t.after(async()=>{await room.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  await call(room,'join',{name:'old',native:{harness:'codex',sessionId:a,source:'codex-env'}});
  await call(room,'join',{name:'new',native:{harness:'codex',sessionId:b,source:'codex-env'}});
  await call(room,'send',{caller:{kind:'human'},to:['old','new'],body:'two distinct original recipients'});
  await writeFile(join(root,'session.toml'),`[participants.old]\nharness="codex"\nsession_id="${a}"\n`);
  await assert.rejects(call(room,'rename',{caller:agent(a),newName:'new'}),{code:'invalid_state'});
  assert.deepEqual(Object.keys(await readRegistry(root)),['old']);
});

test('a send already resolving the old name finishes before rename relabels it',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vp-rename-order-'));const room=new RoomService(root);
  t.after(async()=>{await room.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  await call(room,'join',{name:'old',native:{harness:'codex',sessionId:a,source:'codex-env'}});
  let started!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;});
  const held=new Promise<void>(resolve=>{release=resolve;});
  const realGet=room.settings.get.bind(room.settings);
  room.settings.get=async()=>{started();await held;return realGet();};
  const sending=call(room,'send',{caller:{kind:'human'},to:['old'],body:'started before rename'});
  await entered;
  const renaming=call(room,'rename',{caller:agent(a),newName:'new'});
  release();
  const [sent,renamed]=await Promise.all([sending,renaming]);
  assert.equal(renamed.relabeled,1);
  assert.equal(room.ledger.delivery(sent.message.id,'new').state,'queued');
  assert.equal(room.ledger.findDelivery(sent.message.id,'old'),null);
});
