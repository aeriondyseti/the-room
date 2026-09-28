import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountUsage, AccountUsageProvider } from '../../contracts/account.js';
import { bucketsFromCcstatusline, CCSTATUSLINE_SOURCE, ccstatuslineAccountKey, ccstatuslineCacheProvider, firstAvailable, isDefaultClaudeProfile } from './ccstatusline-cache.js';
import { claudeUsageApiProvider, type UsageFetch } from './usage-api.js';

const dir = mkdtempSync(join(tmpdir(), 'vp-ccsl-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const T0 = new Date('2026-09-28T15:40:00Z');
// Shape observed live in ~/.cache/ccstatusline/usage.json (2.2.30), token hash included (never read by us).
const CACHE = { sessionUsage: 7, sessionResetAt: '2026-09-28T18:19:59.672Z', weeklyUsage: 21, weeklyResetAt: '2026-10-04T08:59:59.673Z',
  extraUsageEnabled: false, weeklySonnetUsage: 0, weeklyOpusUsage: 0, fableUsage: 22, fableResetAt: '2026-10-04T08:59:59.673Z', tokenHash: 'abc123' };

test('maps ccstatusline cache → 5h + weekly + Fable; Fable 0% is a real reading; Sonnet/Opus 0 without reset are placeholders', () => {
  const b = bucketsFromCcstatusline(CACHE, T0.toISOString());
  assert.deepEqual(b.map((x) => [x.id, x.windows.map((w) => [w.durationMinutes, w.usedPercent])]), [
    ['claude', [[300, 7], [10_080, 21]]],
    ['claude-fable', [[10_080, 22]]],
  ]);
  const zeroFable = bucketsFromCcstatusline({ ...CACHE, fableUsage: 0, fableResetAt: undefined }, T0.toISOString());
  assert.deepEqual(zeroFable.find((x) => x.id === 'claude-fable')?.windows[0]?.usedPercent, 0);
});

test('provider: reads the cache (observedAt = mtime); never throws on null/array/primitive JSON; fixed error text; no token hash exposed', async () => {
  const path = join(dir, 'usage.json');
  const p = ccstatuslineCacheProvider({ profileKey: 'k', path, now: () => T0 });
  assert.match((await p.sample()).reason ?? '', /no ccstatusline usage cache/);
  writeFileSync(path, JSON.stringify(CACHE));
  const ok = await p.sample();
  assert.deepEqual([ok.status, ok.source], ['ok', CCSTATUSLINE_SOURCE]);
  assert.doesNotMatch(JSON.stringify(ok), /abc123|tokenHash/);
  assert.doesNotMatch(CCSTATUSLINE_SOURCE, /default/, 'never claims to be the default login');
  assert.deepEqual([ok.account.scope, ok.account.key, ok.account.sourceKey], ['profile', ccstatuslineAccountKey('abc123'), 'k'], 'opaque login identity; stable per-profile row key');
  assert.notEqual(ccstatuslineAccountKey('abc123'), ccstatuslineAccountKey('other'));
  for (const bad of ['null', '[1,2]', '42', '"x"']) {
    writeFileSync(path, bad);
    const r = await p.sample();
    assert.deepEqual([r.status, r.reason], ['unavailable', 'the ccstatusline usage cache has an unexpected shape'], bad);
  }
  writeFileSync(path, JSON.stringify({ error: 'secret-ish upstream text' }));
  const err = await p.sample();
  assert.equal(err.reason, 'ccstatusline reported a usage fetch error');
  assert.equal(err.account.key, ccstatuslineAccountKey('abc123'), 'a failure is attributed to the login last seen, not a guessed one');
  assert.doesNotMatch(JSON.stringify(err), /secret-ish/, 'never echoes the cache error string');
});

test('the global ccstatusline cache is only for the default Claude profile', () => {
  const home = join(dir, 'home');
  assert.equal(isDefaultClaudeProfile(join(home, '.claude'), home), true);
  assert.equal(isDefaultClaudeProfile(join(home, 'other-claude'), home), false);
});

test('firstAvailable: first FRESH ok wins; an old ok never blocks a fresher source; all-stale keeps the first ok; tap flagged only as fallback', async () => {
  const src = (source: string, status: AccountUsage['status'], observedAt: string | null = T0.toISOString()): AccountUsageProvider => ({ harness: 'claude', id: source, sample: async () => ({
    account: { harness: 'claude', scope: 'profile', key: 'k', sourceKey: 'k' }, buckets: [], status, source, checkedAt: null, observedAt, ...(status !== 'ok' ? { reason: `${source} down` } : {}) }) });
  const fresh = { freshMs: 10 * 60_000, now: () => T0 };
  const old = new Date(T0.getTime() - 60 * 60_000).toISOString();
  assert.equal((await firstAvailable('x', [src('cache', 'ok'), src('api', 'ok')], fresh).sample()).source, 'cache');
  assert.equal((await firstAvailable('x', [src('cache', 'ok', old), src('api', 'ok')], fresh).sample()).source, 'api', 'stale cache does not block the fresher endpoint');
  assert.equal((await firstAvailable('x', [src('cache', 'ok', old), src('api', 'unavailable')], fresh).sample()).source, 'cache', 'nothing fresher: keep the stale reading (the monitor labels it)');
  const viaTap = await firstAvailable('x', [src('cache', 'unavailable'), src('claude statusline tap', 'ok')], fresh).sample();
  assert.equal(viaTap.fallback, true);
  const oldCacheFreshTap = await firstAvailable('x', [src('cache', 'ok', old), src('claude statusline tap', 'ok')], fresh).sample();
  assert.deepEqual([oldCacheFreshTap.source, oldCacheFreshTap.fallback], ['claude statusline tap', true], 'a fresh tap replacing an old FULL cache is still a reduced fallback');
  assert.match(oldCacheFreshTap.reason ?? '', /^cache: last reading .* is old$/);
  const none = await firstAvailable('x', [src('cache', 'unavailable'), src('claude statusline tap', 'unavailable')], fresh).sample();
  assert.deepEqual([none.status, none.reason], ['unavailable', 'cache down']);
});

test('usage endpoint: throttled per interval, single-flight in-process, one reservation across instances; 429 honours Retry-After; errors reused', async () => {
  const home = join(dir, 'claude');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }));
  let calls = 0;
  let status = 200;
  let release: (() => void) | null = null;
  const fetch: UsageFetch = async () => {
    calls++;
    if (release === null) await new Promise<void>((r) => { release = r; setTimeout(r, 20); });
    return status === 429 ? { status, body: '', retryAfterSec: 120 } : { status, body: JSON.stringify({ five_hour: { utilization: 5 }, seven_day: { utilization: 20 } }) };
  };
  let now = T0.getTime();
  const cachePath = join(dir, 'throttle-cache.json');
  const make = () => claudeUsageApiProvider({ claudeConfigDir: home, fetch, now: () => new Date(now), throttle: { cachePath, minIntervalMs: 300_000, rateLimitBackoffMs: 300_000, errorRetryMs: 60_000 } });
  const p = make();
  const [a, b] = await Promise.all([p.sample(), p.sample()]);
  assert.deepEqual([a.status, b.status, calls], ['ok', 'ok', 1], 'concurrent samples share one call');
  now += 60_000;
  assert.equal((await make().sample()).status, 'ok', 'another instance reuses the shared cache');
  assert.equal(calls, 1);
  // A held reservation from another process makes this one serve the cache instead of calling.
  now += 300_000;
  writeFileSync(`${cachePath}.lock`, String(now));
  assert.equal((await make().sample()).status, 'ok');
  assert.equal(calls, 1, 'reservation held elsewhere: no call');
  rmSync(`${cachePath}.lock`);
  status = 429;
  assert.match((await p.sample()).reason ?? '', /rate-limiting; next try after/);
  assert.equal(calls, 2);
  now += 60_000;
  await p.sample();
  assert.equal(calls, 2, 'inside Retry-After: no call');
  now += 90_000;
  status = 500;
  assert.match((await p.sample()).reason ?? '', /HTTP 500/);
  now += 30_000;
  await p.sample();
  assert.equal(calls, 3, 'errors are reused for errorRetryMs');
});

test('usage endpoint reservation: an empty (mid-write) lock is held while recent; old ones are taken over; release never removes a lock another service took over', async () => {
  const home = join(dir, 'claude-lock');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }));
  const cachePath = join(dir, 'lock-cache.json');
  const lock = `${cachePath}.lock`;
  let calls = 0;
  let during: (() => void) | null = null;
  const fetch: UsageFetch = async () => {
    calls++;
    during?.();
    return { status: 200, body: JSON.stringify({ five_hour: { utilization: 5 }, seven_day: { utilization: 20 } }) };
  };
  const make = () => claudeUsageApiProvider({ claudeConfigDir: home, fetch, now: () => T0, throttle: { cachePath, minIntervalMs: 300_000, rateLimitBackoffMs: 300_000, errorRetryMs: 60_000, lockMs: 30_000 } });
  writeFileSync(lock, ''); // another service created the lock but hasn't written it yet
  assert.equal((await make().sample()).status, 'unavailable');
  assert.equal(calls, 0, 'an empty lock with a recent mtime is held, not read as abandoned');
  const past = new Date(Date.now() - 120_000);
  utimesSync(lock, past, past);
  // Another service takes the lock over while our fetch runs: our release must leave its lock alone.
  during = () => writeFileSync(lock, JSON.stringify({ at: T0.getTime(), nonce: 'someone-else' }));
  assert.equal((await make().sample()).status, 'ok');
  assert.equal(calls, 1, 'an abandoned empty lock is taken over');
  assert.match(readFileSync(lock, 'utf8'), /someone-else/, 'release only unlinks our own nonce');
  rmSync(lock);
  during = null;
  const p = make();
  await p.sample();
  assert.equal(calls, 1, 'cache reused');
});