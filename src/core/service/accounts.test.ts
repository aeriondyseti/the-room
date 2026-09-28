import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountUsage, AccountUsageProvider } from '../../contracts/account.js';
import type { RoomEvent } from '../../contracts/ipc.js';
import { AccountMonitor } from './accounts.js';
import { CLAUDE_TAP_HINT, claudeAccountUsageProvider, claudeTapPath, tapRecordFrom, windowFor } from '../../adapters/claude/rate-limits.js';

const T0 = new Date('2026-09-28T10:00:00Z');
const ok = (pct: number): AccountUsage => ({
  account: { harness: 'codex', scope: 'account', key: 'k', sourceKey: 's' },
  buckets: [{ id: 'codex', windows: [{ kind: 'primary', durationMinutes: 10_080, usedPercent: pct, resetsAt: null }] }],
  status: 'ok', source: 'test', checkedAt: T0.toISOString(), observedAt: T0.toISOString(),
});
const fail = (reason: string): AccountUsage => ({ ...ok(0), buckets: [], status: 'unavailable', reason, observedAt: null });

function monitor(samples: AccountUsage[], now: () => Date = () => T0) {
  const events: RoomEvent[] = [];
  let i = 0;
  const provider: AccountUsageProvider = { harness: 'codex', id: 'codex:s', sample: async () => samples[Math.min(i++, samples.length - 1)]! };
  const m = new AccountMonitor({ providers: [provider], publish: (e) => events.push(e), intervalMs: 60_000, staleAfterMs: 15 * 60_000, now });
  return { m, events };
}

test('a failure after a good reading keeps the values, marked stale with the reason; unchanged readings publish nothing', async () => {
  const { m, events } = monitor([ok(16), ok(16), fail('daemon not running')]);
  await m.refresh();
  await m.refresh();
  assert.equal(events.length, 1, 'no event for an unchanged reading');
  await m.refresh();
  const [a] = m.snapshot();
  assert.equal(a!.status, 'stale');
  assert.equal(a!.reason, 'daemon not running');
  assert.equal(a!.buckets[0]!.windows[0]!.usedPercent, 16, 'last good values kept, never zeroed');
});

test('an account switch never shows the previous account\'s numbers, even as stale', async () => {
  const switched: AccountUsage = { ...fail('the new account reports no usable windows'), account: { harness: 'codex', scope: 'account', key: 'NEW', sourceKey: 's' } };
  const { m } = monitor([ok(16), switched]);
  await m.refresh();
  await m.refresh();
  const [a] = m.snapshot();
  assert.deepEqual([a!.status, a!.account.key, a!.buckets.length], ['unavailable', 'NEW', 0]);
});

test('never succeeded → unavailable as reported; a throwing provider never blocks and becomes unavailable', async () => {
  const { m } = monitor([fail('no source')]);
  await m.refresh();
  assert.deepEqual([m.snapshot()[0]!.status, m.snapshot()[0]!.reason], ['unavailable', 'no source']);
  const events: RoomEvent[] = [];
  const boom: AccountUsageProvider = { harness: 'claude', id: 'claude:x', sample: async () => { throw new Error('bug'); } };
  const good: AccountUsageProvider = { harness: 'codex', id: 'codex:s', sample: async () => ok(5) };
  const m2 = new AccountMonitor({ providers: [boom, good], publish: (e) => events.push(e), intervalMs: 60_000, staleAfterMs: 60_000, now: () => T0 });
  await m2.refresh();
  assert.deepEqual(m2.snapshot().map((a) => [a.account.harness, a.status]), [['claude', 'unavailable'], ['codex', 'ok']]);
});

test('an old reading ages into stale (values kept, labelled with its age) and that change is PUBLISHED', async () => {
  let now = T0;
  const { m, events } = monitor([ok(40)], () => now);
  await m.refresh();
  assert.equal(events.length, 1);
  now = new Date(T0.getTime() + 20 * 60_000);
  await m.refresh(); // same raw reading, but now aged
  const last = events.at(-1);
  assert.equal(events.length, 2, 'crossing the stale threshold is news to a connected TUI');
  assert.equal(last?.type === 'account.updated' && last.account.status, 'stale');
  assert.match(m.snapshot()[0]!.reason ?? '', /20 min old/);
});

// ---- Claude statusline tap -----------------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'vp-claude-tap-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('the tap keeps only per-window numbers from the statusline input (nothing else)', () => {
  const rec = tapRecordFrom({ session_id: 's', transcript_path: 'C:/secret/path', version: '2.1.283', rate_limits: {
    five_hour: { used_percentage: 12.5, resets_at: 1790620000 }, seven_day_fable: { used_percentage: 7, resets_at: 1791000000 }, 'bad key!': { used_percentage: 1 },
  } }, T0)!;
  assert.deepEqual(Object.keys(rec.windows).sort(), ['five_hour', 'seven_day_fable']);
  assert.doesNotMatch(JSON.stringify(rec), /secret|session_id|transcript/);
  assert.equal(rec.windows.five_hour!.resetsAt, new Date(1790620000 * 1000).toISOString());
  assert.equal(tapRecordFrom({ version: 'x' }, T0), null, 'no rate_limits → nothing stored');
  assert.deepEqual([windowFor('five_hour').window.durationMinutes, windowFor('seven_day').window.durationMinutes], [300, 10_080]);
  assert.deepEqual([windowFor('seven_day_fable').bucket, windowFor('seven_day_fable').bucketLabel], ['claude-fable', 'Fable']);
  assert.equal(windowFor('mystery_window').window.durationMinutes, null, 'unknown duration stays unknown');
});

test('Claude provider: no tap → unavailable with the setup hint; a tap file → buckets; malformed → unavailable', async () => {
  const cfg = join(dir, 'claude-home');
  const provider = claudeAccountUsageProvider({ claudeConfigDir: cfg, tapDir: dir, now: () => T0 });
  const none = await provider.sample();
  assert.deepEqual([none.status, none.reason], ['unavailable', CLAUDE_TAP_HINT]);
  const rec = tapRecordFrom({ rate_limits: { five_hour: { used_percentage: 38, resets_at: 1790620000 }, seven_day: { used_percentage: 71, resets_at: 1791000000 }, seven_day_fable: { used_percentage: 22, resets_at: 1791000000 } } }, T0)!;
  writeFileSync(claudeTapPath(cfg, dir), JSON.stringify(rec));
  const got = await provider.sample();
  assert.equal(got.status, 'ok');
  assert.equal(got.account.scope, 'profile', 'a config profile, not a verified account');
  assert.deepEqual(got.buckets.map((b) => [b.id, b.windows.map((w) => w.usedPercent)]), [['claude', [38, 71]], ['claude-fable', [22]]]);
  writeFileSync(claudeTapPath(cfg, dir), '{not json');
  assert.equal((await provider.sample()).status, 'unavailable');
});

test('TD-0023: stop() abandons a hung provider after the grace period; nothing is published afterwards', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const events: RoomEvent[] = [];
  const provider: AccountUsageProvider = { harness: 'codex', id: 'codex:s', sample: async () => { await gate; return ok(16); } };
  const m = new AccountMonitor({ providers: [provider], publish: (e) => events.push(e), intervalMs: 60_000, staleAfterMs: 15 * 60_000, stopGraceMs: 30, now: () => T0 });
  void m.refresh();
  const t0 = Date.now();
  await m.stop();
  assert.ok(Date.now() - t0 < 1_000, 'shutdown does not wait out a slow daemon read');
  release();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual([events.length, m.snapshot().length], [0, 0], 'the abandoned pass publishes and records nothing');
});