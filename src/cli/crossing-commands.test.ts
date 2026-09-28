// M7 CLI surfaces (7.3) against a fake room link: guarded agent sends, inbox, withdraw.
import { roomGitEnvironment } from '../core/registry/root.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runCommand } from './commands.js';
import type { Caller, Method } from '../contracts/ipc.js';
import { RoomError } from '../contracts/errors.js';

const agent: Caller = { kind: 'agent', native: { harness: 'codex', sessionId: '00000000-0000-4000-8000-000000000001', source: 'codex-env' }, declaredName: null };
const human: Caller = { kind: 'human' };

const msg = (seq: number) => ({
  message: { id: `m${seq}`, seq, createdAt: '2026-09-28T10:00:00Z', from: { name: 'astra', kind: 'agent', identity: { mode: 'verified', source: 'codex-env' } }, to: ['claude'], addressing: 'direct', replyTo: null, kind: 'chat', body: `body ${seq}\u001b[31m`, clientMessageId: null },
  deliveries: [{ recipient: 'claude', state: 'queued', held: false, waiting: null }],
});
const page = (over: Record<string, unknown> = {}) => ({ items: [{ kind: 'full_message', value: msg(20) }], snapshot: 'snap-9', hasMore: false, nextCursor: null, remaining: 0, ...over });

async function setup(t: TestContext, answers: Partial<Record<Method, (params: Record<string, unknown>) => unknown>>) {
  const root = await mkdtemp(path.join(tmpdir(), 'room-cli-m7-'));
  await promisify(execFile)('git', ['init', '--quiet', root], { env: roomGitEnvironment(process.env), windowsHide: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests: Array<{ method: Method; params: Record<string, unknown> }> = [];
  const link = {
    request: async (method: Method, params: unknown) => {
      requests.push({ method, params: params as Record<string, unknown> });
      const answer = answers[method];
      if (!answer) throw new RoomError('bad_request', `unexpected ${method}`);
      return answer(params as Record<string, unknown>) as never;
    },
    close: () => {},
  };
  async function run(cmd: string, args: string[], caller: Caller = agent) {
    const out: string[] = [], err: string[] = [];
    const code = await runCommand(cmd, args, { cwd: root, env: {}, out: (s) => out.push(s), err: (s) => err.push(s), identify: async () => caller, connect: async () => link as never });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }
  return { run, requests };
}

test('agent send goes through guarded_send with snapshot, urgent reason and revision lineage', async (t) => {
  const { run, requests } = await setup(t, { guarded_send: () => ({ status: 'sent', result: { ...msg(21), deduplicated: false }, attemptId: 'a1', guard: 'urgent', newSinceSnapshot: 2 }) });
  const r = await run('send', ['--to', 'astra', '--snapshot', 'snap-1', '--urgent', '--reason', ' main is red ', '--revises', 'a0', 'hello']);
  assert.equal(r.code, 0, r.err);
  const p = requests.find((x) => x.method === 'guarded_send')!.params;
  assert.equal(p['snapshot'], 'snap-1');
  assert.deepEqual(p['urgent'], { reason: 'main is red' });
  assert.equal(p['revisesAttemptId'], 'a0');
  assert.equal(p['body'], 'hello');
  assert.match(r.out, /Recorded #21/);
  assert.match(r.out, /URGENT over 2 message\(s\).*room inbox\)/);
});

test('a guard refusal exits 4, queues nothing, and shows the delta with shell-syntax next steps', async (t) => {
  const { run } = await setup(t, { guarded_send: () => ({ status: 'not_sent', reason: 'snapshot_required', attemptId: 'a7', inbox: page(), guidance: '' }) });
  const r = await run('send', ['--to', 'astra', 'hi']);
  assert.equal(r.code, 4);
  assert.match(r.out, /^NOT SENT: no snapshot was given\. Nothing was queued\./);
  assert.match(r.out, /#20 /);
  assert.match(r.out, /send again with --snapshot snap-9 --revises a7/);
  assert.doesNotMatch(r.out, /\u001b/, 'peer text is sanitized for the terminal');
});

test('--json keeps the raw outcome and the exit code', async (t) => {
  const { run } = await setup(t, { guarded_send: () => ({ status: 'not_sent', reason: 'snapshot_stale', attemptId: 'a8', inbox: page(), guidance: '' }) });
  const r = await run('send', ['--json', '--to', 'astra', '--snapshot', 'old', 'hi']);
  assert.equal(r.code, 4);
  assert.equal(JSON.parse(r.out).attemptId, 'a8');
});

test('urgent/reason pairing is enforced before anything is sent', async (t) => {
  const { run, requests } = await setup(t, {});
  const a = await run('send', ['--to', 'astra', '--urgent', 'x']);
  assert.equal(a.code, 2);
  assert.match(a.err, /urgent send needs --reason/);
  const b = await run('send', ['--to', 'astra', '--reason', 'why', 'x']);
  assert.equal(b.code, 2);
  assert.match(b.err, /only used with --urgent/);
  assert.equal(requests.length, 0);
});

test('the human keeps the plain send path and cannot pass guard flags', async (t) => {
  const { run, requests } = await setup(t, { send: () => ({ ...msg(22), deduplicated: false }) });
  const ok = await run('send', ['--to', 'astra', 'from kevin'], human);
  assert.equal(ok.code, 0, ok.err);
  assert.deepEqual(requests.map((x) => x.method), ['send']);
  const bad = await run('send', ['--to', 'astra', '--snapshot', 's', 'x'], human);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /the human is never guarded/);
});

test('reply takes the guard flags too', async (t) => {
  const { run, requests } = await setup(t, {
    read: () => ({ items: [msg(12)], lastSeq: 12, hasMore: false }),
    guarded_send: () => ({ status: 'sent', result: { ...msg(23), deduplicated: false }, attemptId: 'a2', guard: 'current', newSinceSnapshot: 0 }),
  });
  const r = await run('reply', ['#12', '--snapshot', 'env-tok', 'ack']);
  assert.equal(r.code, 0, r.err);
  const p = requests.find((x) => x.method === 'guarded_send')!.params;
  assert.equal(p['replyTo'], 'm12');
  assert.deepEqual(p['to'], ['astra']);
  assert.equal(p['snapshot'], 'env-tok');
});

test('inbox forwards snapshot, cursor and limit and prints the continuation in shell syntax', async (t) => {
  const { run, requests } = await setup(t, { inbox: () => page({ hasMore: true, nextCursor: 'cur-3', remaining: 2 }) });
  const r = await run('inbox', ['--snapshot', 'snap-1', '--cursor', 'cur-2', '--limit', '5']);
  assert.equal(r.code, 0, r.err);
  const p = requests[0]!.params;
  assert.equal(p['snapshot'], 'snap-1');
  assert.equal(p['cursor'], 'cur-2');
  assert.equal(p['limit'], 5);
  assert.match(r.out, /room inbox --cursor cur-3 --snapshot snap-9/);
});

test('inbox is refused for the human', async (t) => {
  const { run, requests } = await setup(t, { inbox: () => page() });
  const r = await run('inbox', [], human);
  assert.equal(r.code, 2);
  assert.match(r.err, /identity_mismatch/);
  assert.equal(requests.length, 0);
});

test('withdraw resolves #N, passes recipients and reports each one', async (t) => {
  const { run, requests } = await setup(t, {
    read: () => ({ items: [msg(12)], lastSeq: 12, hasMore: false }),
    withdraw: () => ({ messageId: 'm12', recipients: [{ recipient: 'astra', disposition: 'already_submitting' }] }),
  });
  const r = await run('withdraw', ['#12', '--recipients', '@Astra']);
  assert.equal(r.code, 0, r.err);
  const p = requests.find((x) => x.method === 'withdraw')!.params;
  assert.equal(p['messageId'], 'm12');
  assert.deepEqual(p['recipients'], ['astra']);
  assert.match(r.out, /^Could not withdraw #12 for any recipient\./);
});

test('withdraw needs exactly one message reference', async (t) => {
  const { run } = await setup(t, {});
  assert.equal((await run('withdraw', [])).code, 2);
  assert.equal((await run('withdraw', ['#1', '#2'])).code, 2);
});
