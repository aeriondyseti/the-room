import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isSubmitResult, type SubmitRequest, type SubmitResult } from '../../contracts/adapter.js';
import { ClaudeAdapter, activityOf } from './adapter.js';
import { keyHashForPipe, lookupSession, type ClaudeRegistryDeps } from './registry.js';

const TOKEN = 'deadbeefdeadbeefdeadbeefdeadbeef';
const DOMAIN = 'test:host';
const root = mkdtempSync(join(tmpdir(), 'vp-claude-adapter-'));
after(() => rmSync(root, { recursive: true, force: true }));

type Mode = 'accept' | 'closeAfterMessage';
interface FakePipe {
  path: string;
  lines: string[];
  server: Server;
}
const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function fakePipe(mode: Mode): Promise<FakePipe> {
  const path = `\\\\.\\pipe\\vp-test-${randomUUID()}`;
  const lines: string[] = [];
  const server = createServer((sock: Socket) => {
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) !== -1) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (mode === 'closeAfterMessage' && lines.length === 2) sock.destroy();
      }
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  servers.push(server);
  return { path, lines, server };
}

interface Fixture {
  deps: ClaudeRegistryDeps;
  dir: string;
}

/** A sessions dir with the given records; pids listed in `alive` are considered running. */
function fixture(records: object[], opts: { alive?: number[]; startTimes?: Record<number, string | null>; keys?: Array<{ pid: number; pipe: string; token?: unknown }> } = {}): Fixture {
  const dir = mkdtempSync(join(root, 'sessions-'));
  mkdirSync(dir, { recursive: true });
  for (const r of records) writeFileSync(join(dir, `${(r as { pid: number }).pid}.json`), JSON.stringify(r));
  for (const k of opts.keys ?? []) {
    writeFileSync(join(dir, `${k.pid}.${keyHashForPipe(k.pipe)}.key`), JSON.stringify({ peerToken: k.token ?? TOKEN }));
  }
  const alive = new Set(opts.alive ?? records.map((r) => (r as { pid: number }).pid));
  return {
    dir,
    deps: {
      sessionsDir: dir,
      isPidAlive: (pid) => alive.has(pid),
      processStartTime: async (pid) => (opts.startTimes && pid in opts.startTimes ? opts.startTimes[pid]! : '1000'),
      pidDomain: DOMAIN,
    },
  };
}

const record = (over: Record<string, unknown>) => ({
  pid: 4242,
  sessionId: 'sess-1',
  messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-none',
  procStart: '1000',
  pidDomain: DOMAIN,
  status: 'idle',
  ...over,
});

const request = (sessionId = 'sess-1', envelope = 'hello "room" `x` $HOME ✓\nline 2'): SubmitRequest => ({
  target: { harness: 'claude', sessionId },
  envelope,
  messageId: 'm1',
  recipient: 'claude',
  attempt: 1,
});

const adapter = (deps: ClaudeRegistryDeps, over: Partial<{ settleMs: number; max: number }> = {}) =>
  new ClaudeAdapter({ registry: deps, maxEnvelopeChars: over.max ?? 1000, timeoutMs: 3000, settleMs: over.settleMs ?? 150, from: 'the-room' });

const results: SubmitResult[] = [];
async function submit(a: ClaudeAdapter, r: SubmitRequest): Promise<SubmitResult> {
  const out = await a.submit(r);
  results.push(out);
  assert.equal(isSubmitResult(out), true, JSON.stringify(out));
  return out;
}

test('delivers the exact auth and user frames and reports pipe-write evidence', async () => {
  const pipe = await fakePipe('accept');
  const f = fixture([record({ messagingSocketPath: pipe.path })], { keys: [{ pid: 4242, pipe: pipe.path }] });
  const out = await submit(adapter(f.deps), request());
  assert.deepEqual(out, { status: 'submitted', evidence: { kind: 'claude-pipe-write', pid: 4242 } });
  assert.equal(pipe.lines.length, 2);
  assert.deepEqual(JSON.parse(pipe.lines[0]!), { type: 'auth', token: TOKEN });
  const user = JSON.parse(pipe.lines[1]!) as Record<string, unknown>;
  assert.deepEqual(user['message'], { content: request().envelope });
  assert.equal(user['type'], 'user');
  assert.equal(user['priority'], 'next');
  assert.equal(user['from'], 'the-room');
  assert.match(String(user['msg_id']), /^[0-9a-f-]{36}$/);
});

test('no registry record for the session → unavailable offline', async () => {
  const f = fixture([record({ sessionId: 'someone-else' })]);
  assert.deepEqual(await submit(adapter(f.deps), request()), {
    status: 'unavailable',
    reason: 'offline',
    detail: 'no running Claude session has this id',
  });
});

test('record exists but its process exited → unavailable offline', async () => {
  const f = fixture([record({})], { alive: [] });
  const out = await submit(adapter(f.deps), request());
  assert.equal(out.status, 'unavailable');
  assert.equal(out.status === 'unavailable' && out.reason, 'offline');
});

test('pid reused by another process (start time mismatch) → rebind_needed', async () => {
  const f = fixture([record({})], { startTimes: { 4242: '9999' } });
  const out = await submit(adapter(f.deps), request());
  assert.equal(out.status === 'unavailable' && out.reason, 'rebind_needed');
});

test('several live processes claim the session → rebind_needed', async () => {
  const f = fixture([record({ pid: 1 }), record({ pid: 2 })]);
  const out = await submit(adapter(f.deps), request());
  assert.equal(out.status === 'unavailable' && out.reason, 'rebind_needed');
});

test('unknown start time: submit proceeds (pipe is session-bound) but probe says unknown, not online', async () => {
  const pipe = await fakePipe('accept');
  const f = fixture([record({ messagingSocketPath: pipe.path })], { startTimes: { 4242: null }, keys: [{ pid: 4242, pipe: pipe.path }] });
  assert.equal((await submit(adapter(f.deps), request())).status, 'submitted');
  const p = await adapter(f.deps).probe({ harness: 'claude', sessionId: 'sess-1' });
  assert.equal(p.liveness, 'unknown');
  assert.match(p.detail ?? '', /could not be verified/);
});

test('msg_id is stable per (message, recipient) and differs across deliveries', async () => {
  const pipe = await fakePipe('accept');
  const f = fixture([record({ messagingSocketPath: pipe.path })], { keys: [{ pid: 4242, pipe: pipe.path }] });
  const a = adapter(f.deps);
  await submit(a, request());
  await submit(a, request()); // same messageId + recipient (a retry)
  await submit(a, { ...request(), recipient: 'other' });
  const ids = pipe.lines.filter((_, i) => i % 2 === 1).map((l) => (JSON.parse(l) as { msg_id: string }).msg_id);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], ids[2]);
  assert.match(ids[0]!, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('an unreadable registry is an error (failed / unknown), not "offline"', async () => {
  const f = fixture([]);
  const deps = { ...f.deps, sessionsDir: join(f.dir, 'not-a-dir.json') };
  writeFileSync(deps.sessionsDir, 'x'); // readdir on a file → ENOTDIR, not ENOENT
  const out = await submit(adapter(deps), request());
  assert.equal(out.status, 'failed');
  assert.equal((await adapter(deps).probe({ harness: 'claude', sessionId: 'sess-1' })).liveness, 'unknown');
});

test('missing or malformed messaging key → failed (nothing sent)', async () => {
  const pipe = await fakePipe('accept');
  const f = fixture([record({ messagingSocketPath: pipe.path })]);
  assert.equal((await submit(adapter(f.deps), request())).status, 'failed');
  const g = fixture([record({ messagingSocketPath: pipe.path })], { keys: [{ pid: 4242, pipe: pipe.path, token: 'short' }] });
  assert.equal((await submit(adapter(g.deps), request())).status, 'failed');
  assert.equal(pipe.lines.length, 0);
});

test('pipe not listening → failed (definitely not delivered)', async () => {
  const path = `\\\\.\\pipe\\vp-test-missing-${randomUUID()}`;
  const f = fixture([record({ messagingSocketPath: path })], { keys: [{ pid: 4242, pipe: path }] });
  const out = await submit(adapter(f.deps), request());
  assert.equal(out.status, 'failed');
  assert.match(out.status === 'failed' ? out.error.message : '', /before the message was written/);
});

test('receiver closes right after the message → uncertain (may have been read)', async () => {
  const pipe = await fakePipe('closeAfterMessage');
  const f = fixture([record({ messagingSocketPath: pipe.path })], { keys: [{ pid: 4242, pipe: pipe.path }] });
  const out = await submit(adapter(f.deps, { settleMs: 1000 }), request());
  assert.equal(out.status, 'uncertain');
  assert.match(out.status === 'uncertain' ? out.error.hint ?? '' : '', /already have been delivered/);
});

test('oversized envelope and wrong harness are refused without contacting the session', async () => {
  const f = fixture([]);
  const big = await submit(adapter(f.deps, { max: 10 }), request('sess-1', 'x'.repeat(11)));
  assert.equal(big.status === 'failed' && big.error.code, 'message_too_large');
  const wrong = await submit(adapter(f.deps), { ...request(), target: { harness: 'codex', sessionId: 't' } });
  assert.equal(wrong.status === 'failed' && wrong.error.code, 'bad_request');
});

test('probe reports liveness and activity from the registry', async () => {
  const busy = fixture([record({ status: 'busy' })]);
  assert.deepEqual(await adapter(busy.deps).probe({ harness: 'claude', sessionId: 'sess-1' }), { liveness: 'online', activity: 'busy' });
  const gone = fixture([]);
  assert.equal((await adapter(gone.deps).probe({ harness: 'claude', sessionId: 'sess-1' })).liveness, 'offline');
  assert.equal(activityOf({ status: 'waiting', waitingFor: 'permission prompt' }), 'waiting_permission');
  assert.equal(activityOf({ status: 'waiting', waitingFor: 'something new' }), 'unknown');
  assert.equal(activityOf({ status: null, waitingFor: null }), 'unknown');
  assert.equal(activityOf({ status: 'shell', waitingFor: null }), 'idle', 'a job session back at its prompt between turns');
  assert.equal(activityOf({ status: 'something-new', waitingFor: null }), 'unknown', 'unrecognized statuses stay unknown');
});

test('registry ignores records that are not addressable sessions', async () => {
  const f = fixture([
    { ...record({ pid: 10, messagingSocketPath: 'C:\\not\\a\\pipe' }) },
    { ...record({ pid: 11, pidDomain: 'other:host' }) },
    { ...record({ pid: 12, spare: true }) },
    { ...record({ pid: 13, parkedJobId: 'job' }) },
  ]);
  writeFileSync(join(f.dir, '14.json'), JSON.stringify(record({ pid: 99 }))); // pid/file-name mismatch
  writeFileSync(join(f.dir, '15.json'), '{"torn":'); // torn write from a dead process: not evidence either way
  assert.equal((await lookupSession('sess-1', f.deps)).status, 'absent');
});

test('a torn record from a LIVE process makes the lookup an error (unknown), not "offline"', async () => {
  const f = fixture([], { alive: [77] });
  writeFileSync(join(f.dir, '77.json'), '{"pid":77,"sessionId":"sess-1","mess'); // mid-rewrite
  assert.equal((await lookupSession('sess-1', f.deps)).status, 'error');
  assert.equal((await adapter(f.deps).probe({ harness: 'claude', sessionId: 'sess-1' })).liveness, 'unknown');
});

test('no secret appears in any result, error, or hint', () => {
  assert.ok(results.length >= 10);
  for (const r of results) assert.ok(!JSON.stringify(r).includes(TOKEN), JSON.stringify(r));
});
