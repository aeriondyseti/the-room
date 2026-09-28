import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RoomError } from '../contracts/errors.js';
import type { Method, Params } from '../contracts/ipc.js';
import { RoomClient } from '../ipc/client.js';
import type { IdentityResult } from './identity.js';
import { createRoomMcpServer, parseRecipients, type RoomLink } from './server.js';

const THREAD = '01a0e605-2485-7693-a111-97e35d22a97e';
const codexIdentity = async (meta: Record<string, unknown> | undefined): Promise<IdentityResult> =>
  typeof meta?.['threadId'] === 'string'
    ? { ok: true, native: { harness: 'codex', sessionId: meta['threadId'] as string, source: 'codex-mcp-meta' } }
    : { ok: false, code: 'identity_unresolved', message: 'no identity' };

async function connectClient(link: RoomLink, identify = codexIdentity) {
  const server = createRoomMcpServer({ connect: async () => link, identify });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>, meta: Record<string, unknown> = { threadId: THREAD }) => {
    const r = (await client.callTool({ name, arguments: args, _meta: meta })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    return { isError: r.isError === true, text: r.content.map((c) => c.text).join('\n') };
  };
  return { client, call };
}

/** A fake room: records requests and answers with canned results. */
function fakeLink(answers: Partial<Record<Method, (params: unknown) => unknown>>) {
  const requests: Array<{ method: Method; params: unknown }> = [];
  const link: RoomLink = {
    request: async (method, params) => {
      requests.push({ method, params });
      const answer = answers[method];
      if (!answer) throw new RoomError('bad_request', `unexpected ${method}`);
      return answer(params) as never;
    },
  };
  return { link, requests };
}

const msg = (seq: number, over: Record<string, unknown> = {}) => ({
  message: { id: `m${seq}`, seq, createdAt: '2026-09-28T10:00:00Z', from: { name: 'astra', kind: 'agent', identity: { mode: 'verified', source: 'codex-mcp-meta' } }, to: ['claude'], addressing: 'direct', replyTo: null, kind: 'chat', body: `body ${seq}`, clientMessageId: null, ...over },
  deliveries: [],
});

test('tools are listed with descriptions', async () => {
  const { client } = await connectClient(fakeLink({}).link);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['room_join', 'room_read', 'room_send', 'room_who']);
});

test('reply_to defaults to the original sender while a missing address still fails',async()=>{
  const f=fakeLink({read:()=>({items:[msg(12,{from:{name:'claude',kind:'agent',identity:{mode:'verified',source:'claude-ancestry'}}})],lastSeq:12,hasMore:false}),send:p=>({...msg(13,{to:(p as Params<'send'>).to}),deduplicated:false})});
  const{client,call}=await connectClient(f.link);
  try{
    const reply=await call('room_send',{reply_to:'m12',text:'ack'});assert.equal(reply.isError,false);
    assert.deepEqual((f.requests.find(r=>r.method==='send')!.params as Params<'send'>).to,['claude']);
    const missing=await call('room_send',{text:'unaddressed'});assert.equal(missing.isError,true);assert.match(missing.text,/Provide to|reply_to/);
  }finally{await client.close();}
});

test('room_read exposes uncertain delivery diagnostics and reconciliation guidance',async()=>{
 const item={...msg(1),deliveries:[{recipient:'astra',state:'uncertain',held:false,waiting:null,attempts:[{error:{code:'service_unavailable',message:'Receipt lost.',hint:'Inspect the target queue before retrying.'}}]}]};
 const f=fakeLink({read:()=>({items:[item],lastSeq:1,hasMore:false})});const{client,call}=await connectClient(f.link);
 try{const result=await call('room_read',{});assert.match(result.text,/Receipt lost/);assert.match(result.text,/Inspect the target queue/);assert.match(result.text,/Reconcile/);}finally{await client.close();}
});

test('room_send resolves identity per call, parses recipients, resolves #N replies, and always sends a client_message_id', async () => {
  const f = fakeLink({
    read: () => ({ items: [msg(12)], lastSeq: 12, hasMore: false }),
    send: (p) => {
      const params = p as Params<'send'>;
      return { ...msg(13, { to: params.to, body: params.body }), deliveries: [{ recipient: 'claude', state: 'queued', held: false, waiting: null }], deduplicated: false };
    },
  });
  const { call } = await connectClient(f.link);
  const r = await call('room_send', { to: '@claude, astra', text: 'line 1\n"quoted" `tick` $HOME ✓', reply_to: '#12' });
  assert.equal(r.isError, false, r.text);
  const send = f.requests.find((x) => x.method === 'send')!.params as Params<'send'>;
  assert.deepEqual(send.caller, { kind: 'agent', native: { harness: 'codex', sessionId: THREAD, source: 'codex-mcp-meta' }, declaredName: null });
  assert.deepEqual(send.to, ['claude', 'astra']);
  assert.equal(send.replyTo, 'm12');
  assert.equal(send.body, 'line 1\n"quoted" `tick` $HOME ✓', 'exact text');
  assert.match(send.clientMessageId ?? '', /^[0-9a-f-]{36}$/);
  assert.match(r.text, /Sent #13/);
  assert.match(r.text, /claude queued/);
});

test('identity failure is an error and nothing is sent', async () => {
  const f = fakeLink({ send: () => assert.fail('must not send') });
  const { call } = await connectClient(f.link);
  const r = await call('room_send', { to: 'all', text: 'hi' }, {});
  assert.equal(r.isError, true);
  assert.match(r.text, /identity_unresolved/);
  assert.match(r.text, /What to do:/);
  assert.equal(f.requests.length, 0);
});

test('room errors come back with their code and hint', async () => {
  const f = fakeLink({ send: () => { throw new RoomError('unknown_recipient', 'no participant "bob"'); } });
  const { call } = await connectClient(f.link);
  const r = await call('room_send', { to: 'bob', text: 'hi' });
  assert.equal(r.isError, true);
  assert.match(r.text, /unknown_recipient: no participant "bob"\nWhat to do: Run `room who`/);
});

test('room_join with rebind passes the current binding as expectedPrevious', async () => {
  const f = fakeLink({
    who: () => ({ participants: [{ name: 'astra', harness: 'codex', sessionId: 'old-thread-0000', liveness: 'rebind_needed', activity: 'unknown', pending: 0, usage: null, livenessCheckedAt: null }], room: { paused: false, pausedAt: null, stopRequestId: null } }),
    join: () => ({ registration: { name: 'astra', harness: 'codex', sessionId: THREAD }, created: false, rebound: true }),
  });
  const { call } = await connectClient(f.link);
  const r = await call('room_join', { name: 'astra', rebind: true });
  assert.match(r.text, /Rebound as "astra"/);
  const join = f.requests.find((x) => x.method === 'join')!.params as Params<'join'>;
  assert.deepEqual(join.expectedPrevious, { harness: 'codex', sessionId: 'old-thread-0000' });
  assert.equal(join.native.sessionId, THREAD);
});

test('room_rejoin: rebind never takes over a live name or another harness\'s name', async () => {
  const who = (liveness: string, harness = 'codex') => () => ({ participants: [{ name: 'astra', harness, sessionId: 'old-thread-0000', liveness, activity: 'idle', pending: 0, usage: null, livenessCheckedAt: null }], room: { paused: false, pausedAt: null, stopRequestId: null } });
  const live = await connectClient(fakeLink({ who: who('online'), join: () => assert.fail('must not join') }).link);
  assert.match((await live.call('room_join', { name: 'astra', rebind: true })).text, /rebind_conflict: .*still online/);
  const cross = await connectClient(fakeLink({ who: who('offline', 'claude'), join: () => assert.fail('must not join') }).link);
  assert.match((await cross.call('room_join', { name: 'astra', rebind: true })).text, /rebind_conflict: .*claude session/);
});

test('room_read formats messages and a full fetch by #N', async () => {
  const f = fakeLink({
    read: (p) => {
      const q = p as Params<'read'>;
      if (q.messageId) return { items: [msg(5, { body: 'the full text' })], lastSeq: 25, hasMore: false };
      if (q.afterSeq !== undefined && q.afterSeq !== null && q.limit === 1) return { items: [msg(q.afterSeq + 1)], lastSeq: 25, hasMore: true };
      return { items: [msg(24), msg(25)], lastSeq: 25, hasMore: true };
    },
  });
  const { call } = await connectClient(f.link);
  const list = await call('room_read', { limit: 2 });
  assert.match(list.text, /#24 .* astra → claude\nbody 24/);
  assert.match(list.text, /older messages exist: room_read with after=21 limit=2/, 'latest reads point at OLDER history');
  const forward = await call('room_read', { after: 3, limit: 2 });
  assert.match(forward.text, /newer messages exist: room_read with after=25/);
  const one = await call('room_read', { message_id: '#5' });
  assert.match(one.text, /id: m5\nthe full text/);
});

test('parseRecipients: all wins, @ and case are normalized, empty is an error', () => {
  assert.deepEqual(parseRecipients('@Astra claude'), ['astra', 'claude']);
  assert.deepEqual(parseRecipients(['astra', 'all']), ['all']);
  assert.throws(() => parseRecipients(' , '), /No recipients/);
});

// ---- integration with the real room service ------------------------------------------------------------------

const repo = mkdtempSync(join(tmpdir(), 'vp-mcp-real-'));
execFileSync('git', ['init', '-q', repo]);
// Isolation: the auto-started service inherits this env, so production adapter wiring can never reach a real
// Codex install from tests (the fake thread ids below must not be queued anywhere real).
process.env['ROOM_CODEX_EXECUTABLE'] = join(repo, 'no-such-codex.exe');
after(async () => {
  try {
    const admin = await RoomClient.connect(repo, { client: 'cli', autoStart: false });
    await admin.request('shutdown', { caller: { kind: 'human' } }).catch(() => {});
    admin.close();
  } catch {
    // already stopped
  }
  await new Promise((r) => setTimeout(r, 300));
  rmSync(repo, { recursive: true, force: true });
});

test('integration: two Codex agents join and message each other through the real service', { timeout: 30_000 }, async () => {
  const connect = () => RoomClient.connect(repo, { client: 'mcp', autoStart: true });
  const { call } = await connectClient({ request: async (m, p) => (await linkOnce()).request(m, p) } as RoomLink);
  let cached: RoomClient | null = null;
  async function linkOnce() {
    cached ??= await connect();
    return cached;
  }
  const A = '01a0e605-aaaa-7000-8000-000000000001';
  const B = '01a0e605-bbbb-7000-8000-000000000002';
  assert.match((await call('room_join', { name: 'alpha' }, { threadId: A })).text, /Joined as "alpha"/);
  assert.match((await call('room_join', { name: 'beta' }, { threadId: B })).text, /Joined as "beta"/);
  const text = 'hello beta\n"quotes" `ticks` $HOME ✓';
  const sent = await call('room_send', { to: 'beta', text }, { threadId: A });
  assert.equal(sent.isError, false, sent.text);
  const read = await call('room_read', { message_id: '#1' }, { threadId: B });
  assert.match(read.text, /alpha → beta/);
  assert.equal(read.text.split('\n').slice(2, 2 + text.split('\n').length).join('\n'), text, 'exact multiline/quote/Unicode body before delivery diagnostics');
  assert.match(read.text, /Delivery: beta/);
  const who = await call('room_who', {}, { threadId: B });
  assert.match(who.text, /alpha \(codex\)/);
  const spoof = await call('room_send', { to: 'alpha', text: 'x' }, { threadId: '01a0e605-cccc-7000-8000-000000000003' });
  assert.equal(spoof.isError, true, 'an unregistered thread cannot send');
  (cached as RoomClient | null)?.close();
});
