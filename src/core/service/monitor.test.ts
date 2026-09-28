import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeliveryAdapter } from '../../contracts/adapter.js';
import type { ParticipantState, UsageSnapshot } from '../../contracts/domain.js';
import type { RoomEvent } from '../../contracts/ipc.js';
import { cachedStartTime } from '../../adapters/claude/registry.js';
import { RoomClient } from '../../ipc/client.js';
import { startServer } from '../../ipc/server.js';
import { ParticipantMonitor, type MonitorDeps } from './monitor.js';

const usageOk: UsageSnapshot = { source: 'codex-token-count', status: 'ok', observedAt: '2026-09-28T10:00:00Z', cumulative: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 }, context: { usedTokens: 100, limitTokens: 400, percent: 25 } };
const base = (over: Partial<ParticipantState> = {}): ParticipantState => ({ name: 'astra', harness: 'codex', sessionId: 't1', liveness: 'unknown', livenessCheckedAt: null, activity: 'unknown', pending: 0, usage: null, ...over });
const adapter = (probe: DeliveryAdapter['probe']): DeliveryAdapter => ({ harness: 'codex', maxEnvelopeChars: 1000, submit: async () => ({ status: 'failed', error: { code: 'internal', message: 'x' } }), probe });

function harness(over: Partial<MonitorDeps> = {}) {
  const saved: ParticipantState[] = [];
  const published: ParticipantState[] = [];
  let cursors: unknown[] = [];
  let current = base();
  const deps: MonitorDeps = {
    participants: async () => [current],
    adapters: [adapter(async () => ({ liveness: 'online', activity: 'busy' }))],
    observer: { snapshot: async () => usageOk, exportCursors: () => [{ harness: 'codex', sessionId: 't1', path: 'p', offset: 9, counters: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, context: null, lastAt: null, lastMessageId: null }], restoreCursors: () => {} },
    save: (s) => {
      saved.push(s);
      current = s;
    },
    publish: (s) => published.push(s),
    loadCursors: () => [],
    saveCursors: (c) => {
      cursors = c;
    },
    intervalMs: 60_000,
    ...over,
  };
  return { deps, saved, published, cursors: () => cursors };
}

test('refresh probes liveness/activity, reads usage, and publishes only real changes', async () => {
  const h = harness();
  const m = new ParticipantMonitor(h.deps);
  await m.refresh();
  assert.equal(h.published.length, 1);
  assert.deepEqual({ l: h.published[0]!.liveness, a: h.published[0]!.activity, u: h.published[0]!.usage?.context?.percent }, { l: 'online', a: 'busy', u: 25 });
  assert.ok(h.published[0]!.livenessCheckedAt);
  assert.equal(h.cursors().length, 1, 'observer cursors persisted');
  await m.refresh();
  assert.equal(h.published.length, 1, 'no change → no event (re-check timestamps alone are not news)');
});

test('failures degrade honestly: probe error → unknown, usage error → unavailable with reason', async () => {
  const h = harness({
    adapters: [adapter(async () => { throw new Error('boom'); })],
    observer: { snapshot: async () => { throw new Error('disk gone'); }, exportCursors: () => [], restoreCursors: () => {} },
  });
  await new ParticipantMonitor(h.deps).refresh();
  const s = h.published[0]!;
  assert.equal(s.liveness, 'unknown');
  assert.equal(s.usage?.status, 'unavailable');
  assert.match(s.usage?.reason ?? '', /disk gone/);
  assert.equal(s.usage?.context, null, 'never a fabricated zero');
});

test('a rebind or pending change during a slow probe is never overwritten by the stale snapshot', async () => {
  let state = base({ pending: 0 });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const published: ParticipantState[] = [];
  const m = new ParticipantMonitor({
    ...harness().deps,
    participants: async () => [state],
    adapters: [adapter(async () => { await gate; return { liveness: 'online', activity: 'busy' }; })],
    save: (s) => { state = s; },
    publish: (s) => published.push(s),
  });
  const run = m.refresh();
  state = { ...state, pending: 3 }; // a delivery was queued while the probe was running
  release();
  await run;
  assert.equal(published[0]?.pending, 3, 'observed fields merged onto the CURRENT state');
  assert.equal(published[0]?.liveness, 'online');

  let rebound = base();
  let release2!: () => void;
  const gate2 = new Promise<void>((r) => { release2 = r; });
  const published2: ParticipantState[] = [];
  const m2 = new ParticipantMonitor({
    ...harness().deps,
    participants: async () => [rebound],
    adapters: [adapter(async () => { await gate2; return { liveness: 'offline', activity: 'unknown' }; })],
    publish: (s) => published2.push(s),
  });
  const run2 = m2.refresh();
  rebound = base({ sessionId: 'new-thread' }); // rejoined under a new session meanwhile
  release2();
  await run2;
  assert.equal(published2.length, 0, 'the old binding\'s observation is dropped');
});

test('background errors are contained (refresh never rejects)', async () => {
  const m = new ParticipantMonitor({ ...harness().deps, save: () => { throw new Error('database is locked'); } });
  await assert.doesNotReject(m.refresh());
  assert.match(m.lastError?.message ?? '', /database is locked/);
});

test('cursors are restored on construction; corrupt cursors never block', () => {
  let restored: unknown = null;
  const h = harness({ loadCursors: () => [{ x: 1 }] as never, observer: { snapshot: async () => usageOk, exportCursors: () => [], restoreCursors: (c) => { restored = c; } } });
  new ParticipantMonitor(h.deps);
  assert.deepEqual(restored, [{ x: 1 }]);
  const bad = harness({ loadCursors: () => { throw new Error('corrupt'); } });
  assert.doesNotThrow(() => new ParticipantMonitor(bad.deps));
});

test('cachedStartTime caches successes for the TTL and never caches failures', async () => {
  let calls = 0;
  let value: string | null = '111';
  let t = 0;
  const f = cachedStartTime(async () => { calls++; return value; }, 1000, () => t);
  assert.equal(await f(5), '111');
  assert.equal(await f(5), '111');
  assert.equal(calls, 1);
  t = 1500;
  value = null;
  assert.equal(await f(5), null);
  assert.equal(await f(5), null);
  assert.equal(calls, 3, 'null results are re-queried');
});

// ---- integration: the real service with the monitor enabled -------------------------------------------------

const repo = mkdtempSync(join(tmpdir(), 'vp-monitor-'));
execFileSync('git', ['init', '-q', repo]);
after(() => rmSync(repo, { recursive: true, force: true }));

test('integration: after join, who and live events carry observed liveness, activity and usage', { timeout: 20_000 }, async () => {
  const running = await startServer(repo, {
    adapters: [adapter(async () => ({ liveness: 'online', activity: 'idle' }))],
    monitor: { observer: { snapshot: async () => usageOk, exportCursors: () => [], restoreCursors: () => {} }, intervalMs: 60_000 },
  });
  const client = await RoomClient.connect(repo, { client: 'tui', autoStart: false });
  try {
    const events: RoomEvent[] = [];
    client.onEvent((e) => events.push(e));
    await client.request('subscribe', {});
    await client.request('join', { name: 'astra', native: { harness: 'codex', sessionId: '01a0e605-aaaa-7000-8000-000000000001', source: 'codex-env' } });
    const deadline = Date.now() + 5000;
    let who = await client.request('who', {});
    while (who.participants[0]?.liveness !== 'online' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      who = await client.request('who', {});
    }
    assert.equal(who.participants[0]?.liveness, 'online');
    assert.equal(who.participants[0]?.activity, 'idle');
    assert.equal(who.participants[0]?.usage?.context?.percent, 25);
    assert.ok(events.some((e) => e.type === 'participant.updated' && e.participant.liveness === 'online'), 'TUI sees it live');
  } finally {
    client.close();
    await running.close();
  }
});
