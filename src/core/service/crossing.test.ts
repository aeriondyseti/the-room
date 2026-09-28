import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomService} from './service.js';
import {joinParticipant} from '../registry/registry.js';
import type {Caller,Method,Params,Result,RequestFrame} from '../../contracts/ipc.js';
const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002';
const agent=(sessionId:string):Caller=>({kind:'agent',native:{harness:'codex',sessionId,source:'codex-env'},declaredName:null});
async function fixture(t:TestContext){const root=await mkdtemp(join(tmpdir(),'vp-crossing-'));await joinParticipant(root,'a',{harness:'codex',session_id:a});await joinParticipant(root,'b',{harness:'codex',session_id:b});const room=new RoomService(root);t.after(async()=>{await room.close();await rm(root,{recursive:true,force:true,maxRetries:10});});return room;}
async function call<M extends Method>(room:RoomService,method:M,params:Params<M>):Promise<Result<M>>{return await room.handle({v:1,type:'request',id:'test',method,params} as RequestFrame,'cli') as Result<M>;}

test('reciprocal sends race atomically: one commits, the other reviews a delta and revises',async t=>{
 const room=await fixture(t);const sa=await call(room,'inbox',{caller:agent(a)}),sb=await call(room,'inbox',{caller:agent(b)});
 const results=await Promise.all([
  call(room,'guarded_send',{caller:agent(a),to:['b'],body:'proposal A',snapshot:sa.snapshot}),
  call(room,'guarded_send',{caller:agent(b),to:['a'],body:'proposal B',snapshot:sb.snapshot}),
 ]);
 assert.equal(results.filter(r=>r.status==='sent').length,1);assert.equal(room.ledger.list(0,10).items.length,1);
 const index=results.findIndex(r=>r.status==='not_sent');const rejected=results[index]!;assert.equal(rejected.status,'not_sent');if(rejected.status!=='not_sent')return;
 assert.equal(rejected.inbox.items.length,1);assert.equal(rejected.inbox.remaining,0);
 const revised=await call(room,'guarded_send',{caller:agent(index===0?a:b),to:['human'],body:'revised plan',snapshot:rejected.inbox.snapshot,revisesAttemptId:rejected.attemptId});
 assert.equal(revised.status,'sent');
});

test('missing snapshot never enqueues; own sends reuse a token; committed retry precedes freshness',async t=>{
 const room=await fixture(t);const request={caller:agent(a),to:['human'],body:'hello',clientMessageId:'stable'};
 const missing=await call(room,'guarded_send',request);assert.equal(missing.status,'not_sent');if(missing.status!=='not_sent')return;
 assert.equal(room.ledger.list(0,10).items.length,0);
 const first=await call(room,'guarded_send',{...request,snapshot:missing.inbox.snapshot});assert.equal(first.status,'sent');
 assert.equal((await call(room,'guarded_send',{...request,body:'second',clientMessageId:'second',snapshot:missing.inbox.snapshot})).status,'sent');
 await call(room,'send',{caller:{kind:'human'},to:['a'],body:'new directive'});
 const retry=await call(room,'guarded_send',{...request,snapshot:missing.inbox.snapshot});assert.equal(retry.status,'sent');if(retry.status==='sent')assert.equal(retry.result.deduplicated,true);
 const stale=await call(room,'guarded_send',{...request,clientMessageId:'third',snapshot:missing.inbox.snapshot});assert.equal(stale.status,'not_sent');
 await assert.rejects(call(room,'send',request),/require guarded_send/);
});

test('baseline exempts only history at its call; later human message still blocks; foreign lineage rejected',async t=>{
 const room=await fixture(t);await call(room,'send',{caller:{kind:'human'},to:['a'],body:'old history'});
 const page=await call(room,'inbox',{caller:agent(a),baseline:{reason:'Explicit migration'}});assert.equal(page.baseline?.exemptedCount,1);
 await call(room,'send',{caller:{kind:'human'},to:['a'],body:'new directive'});
 const result=await call(room,'guarded_send',{caller:agent(a),to:['human'],body:'old plan',snapshot:page.snapshot});assert.equal(result.status,'not_sent');if(result.status!=='not_sent')return;
 assert.equal(result.inbox.items.length,1);
 await assert.rejects(call(room,'guarded_send',{caller:agent(b),to:['human'],body:'x',revisesAttemptId:result.attemptId}),/does not belong/);
});
