import { roomGitEnvironment } from '../core/registry/root.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runCommand } from './commands.js';
import { startServer } from '../ipc/server.js';
import { RoomClient } from '../ipc/client.js';
import type { Caller } from '../contracts/ipc.js';
import type { DeliveryAdapter } from '../contracts/adapter.js';

const a='00000000-0000-4000-8000-000000000001', b='00000000-0000-4000-8000-000000000002';
const agent=(id=a,name:string|null=null):Caller=>({kind:'agent',native:{harness:'codex',sessionId:id,source:'codex-env'},declaredName:name});
async function setup(t:TestContext){
  const root=await mkdtemp(path.join(tmpdir(),'room-cli-'));
  await promisify(execFile)('git',['init','--quiet',root],{env:roomGitEnvironment(process.env),windowsHide:true});
  const adapter:DeliveryAdapter={harness:'codex',maxEnvelopeChars:24000,probe:async()=>({liveness:'unknown',activity:'unknown'}),submit:async()=>({status:'submitted',evidence:{kind:'codex-queue',nativeId:'fixture'}})};
  const server=await startServer(root,{adapters:[adapter]});
  t.after(async()=>{await server.close();await rm(root,{recursive:true,force:true});});
  async function command(cmd:string,args:string[]=[],caller:Caller={kind:'human'},stdin=''){
    const lines:string[]=[],errors:string[]=[];
    const code=await runCommand(cmd,['--json',...args],{cwd:root,env:{},out:s=>lines.push(s),err:s=>errors.push(s),identify:name=>Promise.resolve(caller.kind==='agent'?{...caller,declaredName:name}:caller),stdin:async()=>stdin,connect:()=>RoomClient.connect(root,{client:'cli',autoStart:false})});
    return{code,value:lines[0]?JSON.parse(lines[0]):null,errors};
  }
  return{root,server,command};
}

test('CLI commands round trip via IPC: join, all input sources, read, who, pause, resume, retry and shutdown',async t=>{
  const {root,server,command}=await setup(t);
  assert.equal((await command('join',['--as','astra'],agent())).code,0);
  assert.equal((await command('join',['--as','peer'],agent(b))).code,0);
  const registry=await readFile(path.join(root,'session.toml'),'utf8');
  assert.match(registry,/session_id/);assert.doesNotMatch(registry,/cwd|token|pid|executable/);
  const body='line 1 "quotes" `tick` $VAR ✓\nline 2';
  const file=path.join(root,'message.txt');await writeFile(file,body);
  // M7: agent sends carry the snapshot from their inbox; the human is never guarded.
  const snap=async(caller:Caller,args:string[]=[])=>(await command('inbox',args,caller)).value.snapshot as string;
  const sa=await snap(agent());
  const sent=await command('send',['--as','astra','--to','peer','--file',file,'--client-message-id','stable','--snapshot',sa],agent());
  assert.equal(sent.code,0);assert.equal(sent.value.status,'sent');assert.equal(sent.value.result.message.body,body);assert.equal(sent.value.result.message.from.identity.mode,'verified');
  assert.equal((await command('send',['--as','astra','--to','peer','--file',file,'--client-message-id','stable','--snapshot',sa],agent())).value.result.deduplicated,true);
  assert.equal((await command('send',['--stdin'],{kind:'human'},body)).value.message.body,body);
  const stale=await command('reply',['#1','ack'],agent(b));
  assert.equal(stale.code,4,'no snapshot: refused, nothing queued');assert.equal(stale.value.status,'not_sent');
  const sb=stale.value.inbox.snapshot as string;
  const reply=await command('reply',['#1','--snapshot',sb,'--revises',stale.value.attemptId,'ack'],agent(b));
  assert.deepEqual(reply.value.result.message.to,['astra']);assert.equal(reply.value.result.message.replyTo,sent.value.result.message.id);
  const explicit=await command('send',['--reply-to','#1','--to','human','--snapshot',sb,'explicit target'],agent(b));
  assert.deepEqual(explicit.value.result.message.to,['human'],'own sends do not invalidate the snapshot');
  assert.equal((await command('send',['--','--help'])).value.message.body,'--help');
  const read=await command('read',['#1']);assert.equal(read.value.items[0].message.id,sent.value.result.message.id);
  assert.equal((await command('read',['--after','0','--limit','1'])).value.items.length,1);
  assert.equal((await command('who')).value.participants.length,2);
  const doctor=await command('doctor');assert.equal(doctor.code,3);assert.match(doctor.value.codexError.hint,/ROUNDTABLE_CODEX_EXECUTABLE/);
  assert.equal((await command('pause')).value.room.paused,true);
  assert.equal((await command('resume')).value.room.paused,false);
  const sentId=sent.value.result.message.id as string;
  const unsupported=await command('retry',[sentId,'peer']);assert.equal(unsupported.code,2);
  // Fixture creates a lost receipt to qualify explicit uncertain retry acknowledgement.
  await server.service.dispatcher.idle();
  server.service.ledger.updateDelivery(sentId,'peer',d=>{d.state='uncertain';});
  assert.equal((await command('retry',[sentId,'peer'])).code,2);
  assert.equal((await command('retry',[sentId,'peer','--confirm-uncertain'])).code,0);
  assert.equal((await command('shutdown')).value.stopping,true);
});

test('CLI refuses mismatches and agent controls; declared fallback stays labelled',async t=>{
  const {command}=await setup(t);
  await command('join',['--as','astra'],agent());await command('join',['--as','peer'],agent(b));
  assert.equal((await command('send',['--as','peer','--to','human','hello'],agent())).code,2);
  const fallback:Caller={kind:'agent',native:null,declaredName:'astra'};
  const token=(await command('inbox',['--as','astra'],fallback)).value.snapshot as string;
  const declared=await command('send',['--as','astra','--to','human','--snapshot',token,'hello'],fallback);
  assert.equal(declared.value.result.message.from.identity.mode,'declared');
  for(const cmd of ['pause','resume','shutdown','migrate'])assert.equal((await command(cmd,[],agent())).code,2);
  assert.equal((await command('send',['hello'],agent())).code,2);
  assert.equal((await command('send',['--file','missing','also text'])).code,2);
  assert.equal((await command('read',['--after','-1'])).code,2);
  assert.equal((await command('send',['--unknown','x'])).code,2);
});

test('real CLI child joins from CODEX_THREAD_ID and preserves piped message bytes',async t=>{
  const {root,server}=await setup(t);
  const main=fileURLToPath(new URL('./main.js',import.meta.url));
  const env={...process.env,CODEX_THREAD_ID:a,CODEX_SESSION_ID:a,ROUNDTABLE_ROOT:root};
  const exec=promisify(execFile);
  const joined=await exec(process.execPath,[main,'join','--as','child','--json'],{cwd:root,env,windowsHide:true});
  assert.equal(JSON.parse(joined.stdout).registration.sessionId,a);
  const body='exact " multiline\n$quote ✓';
  const inbox=await exec(process.execPath,[main,'inbox','--json'],{cwd:root,env,windowsHide:true});
  const snapshot=JSON.parse(inbox.stdout).snapshot as string;
  const result=await new Promise<{stdout:string,stderr:string}>((resolve,reject)=>{
    const child=execFile(process.execPath,[main,'send','--to','human','--snapshot',snapshot,'--stdin','--json'],{cwd:root,env,windowsHide:true},(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr}));
    child.stdin!.end(body);
  });
  assert.equal(JSON.parse(result.stdout).result.message.body,body);
  assert.match(result.stderr,/client_message_id=/);
  assert.equal(server.service.ledger.list(null,10).items.length,1);
});
