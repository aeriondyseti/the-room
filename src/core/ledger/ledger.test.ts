import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Ledger, type EnqueueInput } from './ledger.js';
import type { DeliveryAttempt, ParticipantState, TargetSnapshot } from '../../contracts/domain.js';
const target: TargetSnapshot = { harness: 'codex', sessionId: '00000000-0000-4000-8000-000000000001' };
const other: TargetSnapshot = { harness: 'claude', sessionId: '00000000-0000-4000-8000-000000000002' };
const input = (overrides: Partial<EnqueueInput> = {}): EnqueueInput => ({
  sender: { name: 'human', kind: 'human', identity: { mode: 'human', source: 'tui' } }, senderScope: 'human',
  body: 'Hello "world"\n$VAR `tick` ✓', requestedRecipients: ['astra'],
  recipients: [{ name: 'astra', target }], addressing: 'direct', ...overrides,
});
async function setup(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'room-ledger-')); const ledger = new Ledger(root);
  t.after(async () => { ledger.close(); await rm(root, { recursive: true, force: true }); });
  return { root, ledger };
}

test('burst deadlines debounce up to the first-commit cap and persist across reopen',async t=>{
 const {root,ledger}=await setup(t);
 const epoch=Date.parse('2026-09-28T00:00:00Z');t.mock.timers.enable({apis:['Date'],now:epoch});
 const burstInput=()=>input({holdMs:500,batchHeld:true,batchMaxHoldMs:1000});
 const first=ledger.enqueue(burstInput());
 t.mock.timers.tick(400);const second=ledger.enqueue(burstInput());
 assert.equal(ledger.delivery(first.message.id,'astra').notBefore,new Date(epoch+900).toISOString());
 t.mock.timers.tick(400);ledger.enqueue(burstInput());
 assert.equal(ledger.delivery(first.message.id,'astra').notBefore,new Date(epoch+1000).toISOString());
 assert.equal(ledger.delivery(second.message.id,'astra').notBefore,new Date(epoch+1000).toISOString());
 const reopened=new Ledger(root);try{assert.equal(reopened.delivery(first.message.id,'astra').notBefore,new Date(epoch+1000).toISOString());}finally{reopened.close();}
 t.mock.timers.tick(201);const afterCap=ledger.enqueue(burstInput());
 assert.notEqual(afterCap.deliveries[0]!.burst!.id,first.deliveries[0]!.burst!.id);
});

test('intervening sender, changed policy and urgency prevent extending or joining an old burst',async t=>{
 const {ledger}=await setup(t);t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-28T00:00:00Z')});
 const policy={holdMs:500,batchHeld:true,batchMaxHoldMs:2000};
 const first=ledger.enqueue(input(policy));
 ledger.enqueue(input({...policy,senderScope:'codex:other',sender:{name:'other',kind:'agent',identity:{mode:'verified',source:'codex-env'}}}));
 const third=ledger.enqueue(input(policy));assert.notEqual(third.deliveries[0]!.burst!.id,first.deliveries[0]!.burst!.id);
 const changed=ledger.enqueue(input({...policy,holdMs:600}));assert.notEqual(changed.deliveries[0]!.burst!.id,third.deliveries[0]!.burst!.id);
 const urgent=ledger.enqueue(input({...policy,crossing:{attemptId:'u',guard:'urgent',urgent:{reason:'time critical'},newSinceSnapshot:null,revisesAttemptId:null}}));
 assert.equal(urgent.deliveries[0]!.notBefore,undefined);assert.equal(urgent.deliveries[0]!.burst,undefined);
 const stop=ledger.enqueue(input({...policy,kind:'stop_request'}));assert.equal(stop.deliveries[0]!.notBefore,undefined);
});
test('message and deliveries persist atomically with full body and snapshot', async t => {
  const { root, ledger } = await setup(t);
  assert.equal(ledger.file, path.join(root, '.roundtable', 'room.db'));
  const saved = ledger.enqueue(input({ recipients: [{ name: 'astra', target }, { name: 'claude', target: other }] }));
  assert.equal(saved.message.seq, 1); assert.equal(saved.deliveries.length, 2);
  assert.equal(saved.message.body, input().body);
  saved.deliveries[0]!.target.sessionId = 'mutated by caller';
  assert.deepEqual(ledger.delivery(saved.message.id, 'astra').target, target);
  const reopened = new Ledger(root);
  try { assert.equal(reopened.read(saved.message.id).message.body, input().body); }
  finally { reopened.close(); }
});
test('a failed delivery insert rolls back the message and every prior delivery', async t => {
  const { ledger } = await setup(t);
  assert.throws(() => ledger.enqueue(input({ recipients: [{ name: 'astra', target }, { name: 'astra', target: other }] })));
  assert.deepEqual(ledger.list(0, 10).items, []); assert.deepEqual(ledger.queued(), []);
  assert.equal(ledger.enqueue(input()).message.seq, 1);
});
test('dedup preserves original recipients across enrollment changes and rejects changed payload', async t => {
  const { ledger } = await setup(t);
  const original = ledger.enqueue(input({ clientMessageId: 'once', requestedRecipients: null, addressing: 'broadcast' }));
  const retry = ledger.enqueue(input({ clientMessageId: 'once', requestedRecipients: null, addressing: 'broadcast', recipients: [{ name: 'newcomer', target: other }] }));
  assert.equal(retry.deduplicated, true); assert.deepEqual(retry.message, original.message);
  assert.deepEqual(retry.deliveries, original.deliveries);
  assert.throws(() => ledger.enqueue(input({ clientMessageId: 'once', body: 'different' })), { code: 'dedup_conflict' });
  const differentSender = ledger.enqueue(input({ clientMessageId: 'once', senderScope: 'codex:new-native-id' }));
  assert.notEqual(differentSender.message.id, original.message.id);
});
test('MCP-to-CLI fallback deduplicates by native sender rather than evidence source', async t => {
  const { ledger } = await setup(t);
  const first = ledger.enqueue(input({ clientMessageId: 'retry', senderScope: 'codex:sender', sender: {name:'agent',kind:'agent',identity:{mode:'verified',source:'codex-mcp-meta'}} }));
  const fallback = ledger.enqueue(input({ clientMessageId: 'retry', senderScope: 'codex:sender', sender: {name:'agent',kind:'agent',identity:{mode:'verified',source:'codex-env'}} }));
  assert.equal(fallback.message.id, first.message.id);
});
test('recipient order survives interleaved messages and caller edits cannot retarget', async t => {
  const { ledger } = await setup(t);
  const first = ledger.enqueue(input());
  ledger.enqueue(input({ recipients: [{ name: 'claude', target: other }] }));
  const third = ledger.enqueue(input());
  assert.deepEqual(ledger.queued('astra').map(d => d.messageId), [first.message.id, third.message.id]);
  assert.throws(() => ledger.updateDelivery(first.message.id, 'astra', d => { d.target = other; }), { code: 'invalid_state' });
  assert.deepEqual(ledger.delivery(first.message.id, 'astra').target, target);
});
test('attempt history is retained through a manual retry and completed records cannot be rewritten', async t => {
  const { ledger } = await setup(t); const message = ledger.enqueue(input()).message;
  const attempt: DeliveryAttempt = { n:1, startedAt:new Date().toISOString(), finishedAt:null, outcome:'in_flight', evidence:null, error:null };
  ledger.updateDelivery(message.id, 'astra', d => { d.attempts.push(attempt); });
  ledger.updateDelivery(message.id, 'astra', d => { d.state='uncertain'; d.attempts[0]!.outcome='uncertain'; d.attempts[0]!.finishedAt=new Date().toISOString(); });
  const original = ledger.delivery(message.id, 'astra').attempts[0];
  ledger.updateDelivery(message.id, 'astra', d => { d.state='queued'; d.attempts.push({...attempt,n:2}); });
  assert.deepEqual(ledger.delivery(message.id, 'astra').attempts[0], original);
  assert.throws(() => ledger.updateDelivery(message.id, 'astra', d => { d.attempts[0]!.outcome='submitted'; }), {code:'invalid_state'});
  assert.throws(() => ledger.updateDelivery(message.id, 'astra', d => { d.attempts=[]; }), {code:'invalid_state'});
});
test('outer transaction rollback and caught nested failure preserve transaction boundaries', async t => {
  const { ledger } = await setup(t);
  assert.throws(() => ledger.transaction(() => { ledger.enqueue(input()); ledger.setRoomState({paused:true,pausedAt:'now',stopRequestId:null}); throw Error('crash'); }));
  assert.equal(ledger.list(0, 10).items.length, 0); assert.equal(ledger.roomState().paused, false);
  ledger.transaction(() => {
    ledger.enqueue(input());
    assert.throws(() => ledger.enqueue(input({recipients:[{name:'astra',target},{name:'astra',target}]})));
    ledger.enqueue(input());
  });
  assert.equal(ledger.list(0, 10).items.length, 2);
});
test('paging and missing reply targets fail honestly', async t => {
  const { ledger } = await setup(t);
  assert.throws(() => ledger.enqueue(input({replyTo:'missing'})), {code:'not_found'});
  const messages = [ledger.enqueue(input()), ledger.enqueue(input()), ledger.enqueue(input())];
  const page = ledger.list(0,2); assert.equal(page.hasMore,true); assert.equal(page.lastSeq,2);
  assert.equal(ledger.list(page.lastSeq,2).items[0]!.message.id,messages[2]!.message.id);
  assert.deepEqual(ledger.list(null,2).items.map(m=>m.message.seq),[2,3]);
  assert.throws(()=>ledger.list(-1,2),{code:'bad_request'});
});
test('runtime participant snapshots and usage cursors survive reconnect independently of registry', async t => {
  const { ledger, root } = await setup(t);
  const participant: ParticipantState = { name:'astra',...target,liveness:'unknown',livenessCheckedAt:null,activity:'unknown',pending:1,usage:null };
  ledger.putParticipant(participant);
  const cursor = { source:'rollout',offset:12,identity:'file-1',updatedAt:'2026-09-28T00:00:00Z' };
  ledger.putCursor('astra',cursor);
  const reopened = new Ledger(root);
  try { assert.deepEqual(reopened.participants(),[participant]); assert.deepEqual(reopened.cursor('astra'),cursor); }
  finally { reopened.close(); }
  ledger.removeParticipant('astra'); assert.deepEqual(ledger.participants(),[]);
});

test('human messages are log-only; an agent without a native target cannot disappear from delivery accounting', async t => {
  const { ledger } = await setup(t);
  const saved = ledger.enqueue(input({requestedRecipients:['human'],recipients:[{name:'human',target:null}]}));
  assert.equal(saved.deliveries.length,0); assert.deepEqual(saved.message.to,['human']);
  assert.throws(()=>ledger.enqueue(input({recipients:[{name:'astra',target:null}]})),{code:'bad_request'});
  assert.equal(ledger.list(0,10).items.length,1);
});
test('bounded SQLite busy timeout tolerates another process briefly owning the writer lock', async t => {
  const { ledger, root } = await setup(t);
  const { spawn } = await import('node:child_process');
  const code = `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('ready\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200); db.exec('ROLLBACK'); db.close();`;
  const child = spawn(process.execPath,['--input-type=module','-e',code,path.join(root,'.roundtable','room.db')],{windowsHide:true});
  t.after(()=>{child.kill();});
  const exited = new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`writer exited ${code}`)));});
  await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject);child.once('exit',code=>{if(code!==0)reject(Error('writer failed before readiness'));});});
  assert.equal(ledger.enqueue(input()).message.seq,1);
  await exited;
});
