import{test,type TestContext}from'node:test';import assert from'node:assert/strict';
import{mkdtemp,readFile,rm,writeFile}from'node:fs/promises';import{tmpdir}from'node:os';import path from'node:path';
import{spawn,execFile,type ChildProcess}from'node:child_process';import{promisify}from'node:util';import{fileURLToPath}from'node:url';
import{RoomClient}from'../ipc/client.js';import{joinParticipant,readRegistry}from'../core/registry/registry.js';import{resolveRoomRoot}from'../core/registry/root.js';
import{stringify}from'smol-toml';
const human={kind:'human' as const};
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const wait=async(check:()=>Promise<boolean>)=>{const end=Date.now()+5000;while(!await check()){if(Date.now()>end)throw Error('Qualification timed out');await new Promise(r=>setTimeout(r,10));}};
async function fixture(t:TestContext){
 const root=await mkdtemp(path.join(tmpdir(),'room-recovery-'));const children:ChildProcess[]=[],clients:RoomClient[]=[];
 t.after(async()=>{for(const c of clients)c.close();for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(r=>child.once('exit',r));}await rm(root,{recursive:true,force:true});});
 async function launch(mode:string){
  const child=spawn(process.execPath,[fileURLToPath(new URL('./fixture-service.js',import.meta.url)),root,mode],{windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);
  await new Promise<void>((resolve,reject)=>{let out='',err='';const timer=setTimeout(()=>reject(Error('Fixture startup timeout')),5000);
   child.stdout!.on('data',chunk=>{out+=chunk.toString();if(out.includes('READY')){clearTimeout(timer);resolve();}});child.stderr!.on('data',chunk=>{err+=chunk.toString();});
   child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);if(!out.includes('READY'))reject(Error(`Fixture exit ${code}: ${err}`));});
  });
  const client=await RoomClient.connect(root,{client:'cli',autoStart:false});clients.push(client);return{child,client};
 }
 return{root,launch};
}

test('real process restart preserves offline work and never replays an ambiguous native attempt',async t=>{
 const {root,launch}=await fixture(t);await joinParticipant(root,'agent',{harness:'codex',session_id:id(1)});
 const offline=await launch('offline');const saved=await offline.client.request('send',{caller:human,to:['agent'],body:'survive restart'});
 await wait(async()=> (await offline.client.request('deliveries',{messageId:saved.message.id})).deliveries[0]!.waiting==='offline');
 const stopped=new Promise(r=>offline.child.once('exit',r));await offline.client.request('shutdown',{caller:human});offline.client.close();await stopped;
 const online=await launch('online');
 await wait(async()=> (await online.client.request('deliveries',{messageId:saved.message.id})).deliveries[0]!.state==='submitted');
 const stopped2=new Promise(r=>online.child.once('exit',r));await online.client.request('shutdown',{caller:human});online.client.close();await stopped2;
 const crash=await launch('crash');const exit=new Promise(r=>crash.child.once('exit',r));
 const request={caller:human,to:['agent'],body:'lost native receipt',clientMessageId:'crash-qualified'};
 // The service can die before or after the IPC acknowledgement; reuse the durable idempotency key.
 await crash.client.request('send',request).catch(()=>{});await exit;assert.equal(crash.child.exitCode,89);crash.client.close();
 const recovered=await launch('online');const dedup=await recovered.client.request('send',request);
 assert.equal(dedup.deduplicated,true);assert.equal(dedup.deliveries[0]!.state,'uncertain');
 assert.equal(dedup.deliveries[0]!.attempts.length,1);
 const lines=(await readFile(path.join(root,'native-attempts.jsonl'),'utf8')).trim().split('\n');assert.equal(lines.length,2);
 assert.equal(JSON.parse(lines[1]!).messageId,dedup.message.id);
});

test('four-instance snapshots survive pause, add/remove/rebind and large reference delivery',async t=>{
 const {root,launch}=await fixture(t);
 for(const [n,name,harness]of [[1,'codex_a','codex'],[2,'codex_b','codex'],[3,'claude_a','claude'],[4,'claude_b','claude']]as const)await joinParticipant(root,name,{harness,session_id:id(n)});
 const {client}=await launch('online');
 const pause=await client.request('pause',{caller:human});
 await wait(async()=> (await client.request('deliveries',{messageId:pause.stopRequest!.message.id})).deliveries.every(d=>d.state==='submitted'));
 const saved=await client.request('send',{caller:human,to:['all'],body:'original recipients'});assert.equal(saved.deliveries.length,4);assert.ok(saved.deliveries.every(d=>d.held));
 const registry=await readRegistry(root);delete registry.claude_b;await writeFile(path.join(root,'session.toml'),stringify({participants:registry}));
 await joinParticipant(root,'codex_b',{harness:'codex',session_id:id(5)},{expectedPrevious:{harness:'codex',session_id:id(2)}});
 await joinParticipant(root,'new_agent',{harness:'claude',session_id:id(6)});
 const resumed=await client.request('resume',{caller:human});assert.equal(resumed.released,4);
 await wait(async()=>{const d=(await client.request('deliveries',{messageId:saved.message.id})).deliveries;return d.filter(x=>x.state==='submitted').length===2&&d.filter(x=>x.waiting==='rebind_needed').length===2;});
 const prior=(await client.request('deliveries',{messageId:saved.message.id})).deliveries;
 assert.equal(prior.find(d=>d.recipient==='codex_b')!.target.sessionId,id(2));assert.ok(!prior.some(d=>d.recipient==='new_agent'));
 const body='quoted " unicode ✓\n'.repeat(1000);const fresh=await client.request('send',{caller:human,to:['all'],body});
 await wait(async()=> (await client.request('deliveries',{messageId:fresh.message.id})).deliveries.every(d=>d.state==='submitted'));
 const result=(await client.request('read',{messageId:fresh.message.id})).items[0]!;assert.equal(result.message.body,body);assert.ok(result.deliveries.every(d=>d.referenced));
 assert.equal(result.deliveries.find(d=>d.recipient==='codex_b')!.target.sessionId,id(5));assert.ok(result.message.to.includes('new_agent'));
 const attempts=(await readFile(path.join(root,'native-attempts.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s));
 assert.equal(attempts.filter(a=>a.messageId===pause.stopRequest!.message.id).length,4);
 assert.ok(attempts.filter(a=>a.messageId===fresh.message.id).every(a=>a.envelope.length<=1000&&a.envelope.includes('Referenced content')));
});

test('linked worktree clients share one canonical service and ledger',async t=>{
 const {root,launch}=await fixture(t);const exec=promisify(execFile);
 await exec('git',['init','--quiet',root]);await exec('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','--allow-empty','-m','fixture']);
 const worktree=path.join(root,'linked');await exec('git',['-C',root,'worktree','add','--quiet','-b','fixture-branch',worktree]);
 assert.equal(await resolveRoomRoot(worktree),await resolveRoomRoot(root));
 const {client}=await launch('offline');const linked=await RoomClient.connect(await resolveRoomRoot(worktree),{client:'cli',autoStart:false});
 try{await client.request('send',{caller:human,to:['human'],body:'shared across worktrees'});assert.equal((await linked.request('read',{})).items[0]!.message.body,'shared across worktrees');}finally{linked.close();}
});
