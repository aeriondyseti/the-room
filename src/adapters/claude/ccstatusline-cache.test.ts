import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountUsage, AccountUsageProvider } from '../../contracts/account.js';
import { bucketsFromCcstatusline, ccstatuslineCacheProvider, firstAvailable } from './ccstatusline-cache.js';
import { claudeUsageApiProvider, type UsageFetch } from './usage-api.js';

const dir = mkdtempSync(join(tmpdir(), 'vp-ccsl-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const T0 = new Date('2026-09-28T15:40:00Z');
// Shape observed live in ~/.cache/ccstatusline/usage.json (2.2.30), token hash included (never read by us).
const CACHE = { sessionUsage: 7, sessionResetAt: '2026-09-28T18:19:59.672Z', weeklyUsage: 21, weeklyResetAt: '2026-10-04T08:59:59.673Z',
  extraUsageEnabled: false, weeklySonnetUsage: 0, weeklyOpusUsage: 0, fableUsage: 22, fableResetAt: '2026-10-04T08:59:59.673Z', tokenHash: 'abc123' };

test('maps ccstatusline cache → 5h + weekly + Fable weekly; zero-without-reset placeholders (Sonnet/Opus) are skipped', () => {
  const b = bucketsFromCcstatusline(CACHE, T0.toISOString());
  assert.deepEqual(b.map((x) => [x.id, x.label ?? null, x.windows.map((w) => [w.durationMinutes, w.usedPercent])]), [
    ['claude', null, [[300, 7], [10_080, 21]]],
    ['claude-fable', 'Fable', [[10_080, 22]]],
  ]);
});

test('provider: reads the cache (observedAt = file mtime); missing/garbage/error → unavailable with a reason; never exposes the token hash', async () => {
  const path = join(dir, 'usage.json');
  const p = ccstatuslineCacheProvider({ profileKey: 'k', path, now: () => T0 });
  assert.match((await p.sample()).reason ?? '', /no ccstatusline usage cache/);
  writeFileSync(path, JSON.stringify(CACHE));
  const ok = await p.sample();
  assert.equal(ok.status, 'ok');
  assert.equal(ok.source, 'ccstatusline cache');
  assert.doesNotMatch(JSON.stringify(ok), /abc123|tokenHash/);
  writeFileSync(path, '{not json');
  assert.match((await p.sample()).reason ?? '', /unreadable/);
  writeFileSync(path, JSON.stringify({ error: 'rate-limited' }));
  assert.match((await p.sample()).reason ?? '', /ccstatusline reported a usage error \(rate-limited\)/);
});

test('firstAvailable: cheapest working source wins; only the statusline tap is flagged as a reduced fallback', async () => {
  const src = (source: string, status: AccountUsage['status']): AccountUsageProvider => ({ harness: 'claude', id: source, sample: async () => ({
    account: { harness: 'claude', scope: 'profile', key: 'k', sourceKey: 'k' }, buckets: [], status, source, checkedAt: null, observedAt: null, ...(status !== 'ok' ? { reason: `${source} down` } : {}) }) });
  assert.equal((await firstAvailable('x', [src('ccstatusline cache', 'ok'), src('api', 'ok')]).sample()).source, 'ccstatusline cache');
  const viaApi = await firstAvailable('x', [src('ccstatusline cache', 'unavailable'), src('claude api', 'ok')]).sample();
  assert.deepEqual([viaApi.source, viaApi.fallback ?? false], ['claude api', false]);
  const viaTap = await firstAvailable('x', [src('ccstatusline cache', 'unavailable'), src('claude statusline tap', 'ok')]).sample();
  assert.equal(viaTap.fallback, true);
  const none = await firstAvailable('x', [src('ccstatusline cache', 'unavailable'), src('claude statusline tap', 'unavailable')]).sample();
  assert.deepEqual([none.status, none.reason], ['unavailable', 'ccstatusline cache down'], 'the first reason is kept');
});

test('usage endpoint throttle: one call per interval (shared cache file); 429 backs off per Retry-After; errors retried after errorRetryMs', async () => {
  const home = join(dir, 'claude');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }));
  let calls = 0;
  let status = 200;
  const fetch: UsageFetch = async () => {
    calls++;
    return status === 429 ? { status, body: '', retryAfterSec: 120 } : { status, body: JSON.stringify({ five_hour: { utilization: 5 }, seven_day: { utilization: 20 } }) };
  };
  let now = T0.getTime();
  const cachePath = join(dir, 'throttle-cache.json');
  const make = () => claudeUsageApiProvider({ claudeConfigDir: home, fetch, now: () => new Date(now), throttle: { cachePath, minIntervalMs: 300_000, rateLimitBackoffMs: 300_000, errorRetryMs: 60_000 } });
  const p = make();
  assert.equal((await p.sample()).status, 'ok');
  now += 60_000;
  assert.equal((await p.sample()).status, 'ok');
  assert.equal((await make().sample()).status, 'ok', 'another service instance reuses the shared cache');
  assert.equal(calls, 1, 'within the interval: no new calls, from this or another instance');
  now += 300_000;
  status = 429;
  const limited = await p.sample();
  assert.match(limited.reason ?? '', /rate-limiting; next try after/);
  assert.equal(calls, 2);
  now += 60_000; // still inside Retry-After (120s)
  await p.sample();
  assert.equal(calls, 2, 'backing off: no call');
  now += 90_000; // past Retry-After
  status = 500;
  assert.match((await p.sample()).reason ?? '', /HTTP 500/);
  assert.equal(calls, 3);
  now += 30_000;
  await p.sample();
  assert.equal(calls, 3, 'errors are reused for errorRetryMs');
});
