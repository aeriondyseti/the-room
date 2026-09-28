import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer } from './server.js';
import { RoomClient } from './client.js';
import { joinParticipant } from '../core/registry/registry.js';
import type { RoomEvent } from '../contracts/ipc.js';
const id='00000000-0000-4000-8000-000000000001';
const native={harness:'codex' as const,sessionId:id,source:'codex-env' as const};
async function fixture(t:TestContext){const root=await mkdtemp(path.join(tmpdir(),'room-ipc-'));return root;}
async function setup(t:TestContext){const root=await fixture(t);const server=await startServer(root);const client=await RoomClient.connect(root,{client:'cli',autoStart:false});t.after(async()=>{client.close();await server.close();await rm(root,{recursive:true,force:true});});return{root,server,client};}
const send={caller:{kind:'human' as const},to:['astra'],body:'first'};
test('real IPC join/send/read/who, identity and delivery events are ordered',async t=>{
 const {server,client}=await setup(t);const events:RoomEvent[]=[];client.onEvent(event=>events.push(event));
 await client.request('subscribe',{});
 await client.request('join',{name:'astra',native});
 const first=await client.request('send',send);
 const changed=server.service.ledger.updateDelivery(first.message.id,'astra',d=>{d.held=true;});
 server.service.publish({type:'delivery.updated',delivery:changed});
 const second=await client.request('send',{...send,body:'second'});
 const history=await client.request('read',{afterSeq:0});
 assert.deepEqual(history.items.map(i=>i.message.id),[first.message.id,second.message.id]);
 assert.deepEqual(events.map(e=>e.type),['participant.updated','message.created','delivery.updated','message.created']);
 assert.equal((await client.request('who',{})).participants[0]!.pending,2);
});
test('service enforces MCP human restriction and native harness/source binding',async t=>{
 const {root,client}=await setup(t);await client.request('join',{name:'astra',native});
 const mcp=await RoomClient.connect(root,{client:'mcp',autoStart:false});t.after(()=>mcp.close());
 await assert.rejects(mcp.request('send',send),{code:'identity_mismatch'});
 await assert.rejects(mcp.request('shutdown',{caller:{kind:'human'}}),{code:'identity_mismatch'});
 await assert.rejects(client.request('join',{name:'other',native:{...native,source:'claude-ancestry'}}),{code:'bad_request'});
 await assert.rejects(client.request('send',{...send,caller:{kind:'agent',native,declaredName:'other'}}),{code:'identity_mismatch'});
 await assert.rejects(mcp.request('send',{...send,caller:{kind:'agent',native:null,declaredName:'astra'}}),{code:'identity_unresolved'});
 const reply=await mcp.request('send',{caller:{kind:'agent',native:{...native,source:'codex-mcp-meta'},declaredName:null},to:['human'],body:'hello human'});
 assert.equal(reply.message.from.name,'astra');assert.equal(reply.deliveries.length,0);
});
test('subscribe replays stored messages in order, and reconnect can refresh held state',async t=>{
 const {root,client,server}=await setup(t);await client.request('join',{name:'astra',native});
 const first=await client.request('send',send);await client.request('send',{...send,body:'second'});
 server.service.ledger.updateDelivery(first.message.id,'astra',d=>{d.held=true;});
 const subscriber=await RoomClient.connect(root,{client:'tui',autoStart:false});t.after(()=>subscriber.close());
 const events:RoomEvent[]=[];subscriber.onEvent(e=>events.push(e));await subscriber.request('subscribe',{afterSeq:0});
 assert.deepEqual(events.filter(e=>e.type==='message.created').map(e=>e.message.seq),[1,2]);
 assert.equal((await subscriber.request('read',{messageId:first.message.id})).items[0]!.deliveries[0]!.held,true);
});
test('OS lock refuses a second writer; stale owner metadata is replaced only after exclusive bind',async t=>{
 const root=await fixture(t);await mkdir(path.join(root,'.room'));await writeFile(path.join(root,'.room/service.lock'),JSON.stringify({pid:999999999,nonce:'stale'}));
 const server=await startServer(root);t.after(async()=>{await server.close();await rm(root,{recursive:true,force:true});});
 const owner=JSON.parse(await readFile(path.join(root,'.room/service.lock'),'utf8')) as {pid:number;nonce:string};
 assert.equal(owner.pid,process.pid);assert.notEqual(owner.nonce,'stale');
 await assert.rejects(startServer(root),{code:'EADDRINUSE'});
 assert.equal(JSON.parse(await readFile(path.join(root,'.room/service.lock'),'utf8')).nonce,owner.nonce);
});
test('two independent auto-starting clients find one detached service and shutdown cleans ownership',async t=>{
 const root=await fixture(t);await joinParticipant(root,'astra',{harness:'codex',session_id:id});
 const moduleUrl=new URL('./client.js',import.meta.url).href;
 const script=`import {RoomClient} from ${JSON.stringify(moduleUrl)}; const c=await RoomClient.connect(process.argv[1],{client:'cli'}); console.log(JSON.stringify(await c.request('who',{}))); c.close();`;
 const run=()=>new Promise<string>((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',script,root],{windowsHide:true});let out='';let err='';child.stdout.on('data',chunk=>{out+=String(chunk);});child.stderr.on('data',chunk=>{err+=String(chunk);});child.on('error',reject);child.on('exit',code=>code===0?resolve(out):reject(Error(err)));});
 const clientPromise=Promise.all([run(),run()]);
 t.after(async()=>{try{const client=await RoomClient.connect(root,{client:'cli',autoStart:false});await client.request('shutdown',{caller:{kind:'human'}});client.close();}catch{} await rm(root,{recursive:true,force:true});});
 const outputs=await clientPromise;assert.ok(outputs.every(output=>JSON.parse(output).participants[0].name==='astra'));
 const client=await RoomClient.connect(root,{client:'cli',autoStart:false});await client.request('shutdown',{caller:{kind:'human'}});client.close();
 const deadline=Date.now()+3000;
 while(Date.now()<deadline){try{await readFile(path.join(root,'.room/service.lock'));await new Promise(r=>setTimeout(r,20));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}}
 assert.fail('service owner metadata remained after shutdown');
});

test('retry after recipient removal returns the original snapshotted delivery',async t=>{
 const {root,client}=await setup(t);await client.request('join',{name:'astra',native});
 const first=await client.request('send',{...send,clientMessageId:'stable'});
 await writeFile(path.join(root,'session.toml'),'[participants]\n');
 const retry=await client.request('send',{...send,clientMessageId:'stable'});
 assert.equal(retry.message.id,first.message.id);assert.equal(retry.deduplicated,true);
 assert.equal(retry.deliveries[0]!.target.sessionId,id);
});

test('large replay drains without dropping the connection or losing live catch-up events',async t=>{
 const {root,server,client}=await setup(t);await client.request('join',{name:'astra',native});
 for(let i=0;i<12;i++)await client.request('send',{...send,body:`${i}:`+'x'.repeat(1_000_000)});
 const subscriber=await RoomClient.connect(root,{client:'tui',autoStart:false});t.after(()=>subscriber.close());
 const seen:number[]=[];subscriber.onEvent(e=>{if(e.type==='message.created')seen.push(e.message.seq);});
 const replaying=subscriber.request('subscribe',{afterSeq:0});
 await client.request('send',{...send,body:'live during replay'});
 await replaying;await subscriber.request('who',{});
 assert.deepEqual(seen,Array.from({length:13},(_,i)=>i+1));
});
test('hello waits until initialization and event forwarding are complete',async t=>{
 const root=await fixture(t);let release!:()=>void;let entered!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});const bound=new Promise<void>(resolve=>{entered=resolve;});
 const starting=startServer(root,{beforeReady:async()=>{entered();await gate;}});await bound;
 const connecting=RoomClient.connect(root,{client:'cli',autoStart:false});
 const premature=await Promise.race([connecting.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),20))]);
 assert.equal(premature,false);release();const server=await starting;const client=await connecting;
 t.after(async()=>{client.close();await server.close();await rm(root,{recursive:true,force:true});});
 const events:RoomEvent[]=[];client.onEvent(e=>events.push(e));await client.request('subscribe',{});
 await client.request('join',{name:'astra',native});await client.request('send',send);
 assert.ok(events.some(e=>e.type==='message.created'));
});
test('shutdown retains exclusive ownership until active work has drained and ledger is closed',async t=>{
 const {root,server,client}=await setup(t);let release!:()=>void;let entered!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});const waiting=new Promise<void>(resolve=>{entered=resolve;});
 const original=server.service.handle.bind(server.service);
 server.service.handle=async(req,kind)=>{if(req.method==='who'){entered();await gate;}return original(req,kind);};
 const inFlight=client.request('who',{}).catch(()=>null);await waiting;
 const closing=server.close();await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(startServer(root),{code:'EADDRINUSE'});
 release();await inFlight;await closing;
 const successor=await startServer(root);await successor.close();
});
