import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bucketsFromUsageResponse, claudeCombinedProvider, claudeUsageApiProvider, type UsageFetch } from './usage-api.js';
import { claudeAccountUsageProvider, claudeTapPath, tapRecordFrom } from './rate-limits.js';

const root = mkdtempSync(join(tmpdir(), 'vp-usage-api-'));
after(() => rmSync(root, { recursive: true, force: true }));
const T0 = new Date('2026-09-28T15:30:00Z');
const TOKEN = 'sk-ant-oat01-SECRETSECRETSECRETSECRET';
let n = 0;
function home(creds?: unknown): string {
  const dir = join(root, `h${n++}`);
  mkdirSync(dir, { recursive: true });
  if (creds !== undefined) writeFileSync(join(dir, '.credentials.json'), JSON.stringify(creds));
  return dir;
}
const RESPONSE = {
  five_hour: { utilization: 6, resets_at: '2026-09-28T18:19:59.672Z' },
  seven_day: { utilization: 21, resets_at: '2026-10-04T08:59:59.673Z' },
  seven_day_sonnet: null,
  limits: [
    { kind: 'session', percent: 0, resets_at: null }, // unscoped placeholder: ignored
    { kind: 'weekly_scoped', percent: 22, resets_at: '2026-10-04T08:59:59.673Z', scope: { model: { display_name: 'Fable' } } },
  ],
};

test('maps 5h + weekly into the main bucket and each model-scoped weekly limit (Fable) into its own bucket', () => {
  const b = bucketsFromUsageResponse(RESPONSE, T0.toISOString())!;
  assert.deepEqual(b.map((x) => [x.id, x.label ?? null, x.windows.map((w) => [w.durationMinutes, w.usedPercent])]), [
    ['claude', null, [[300, 6], [10_080, 21]]],
    ['claude-fable', 'Fable', [[10_080, 22]]],
  ]);
  const missing = bucketsFromUsageResponse({ seven_day: { utilization: 40 } }, T0.toISOString())!;
  const five = missing[0]!.windows[0]!;
  assert.deepEqual([five.usedPercent, typeof five.reason], [null, 'string'], 'a missing window is null with a reason, never 0');
  assert.equal(bucketsFromUsageResponse('nope', T0.toISOString()), null);
});

test('the token is sent only to the fetcher, never appears in any output; results are profile-scoped', async () => {
  let seen: string | null = null;
  const fetch: UsageFetch = async (token) => {
    seen = token;
    return { status: 200, body: JSON.stringify(RESPONSE) };
  };
  const p = claudeUsageApiProvider({ claudeConfigDir: home({ claudeAiOauth: { accessToken: TOKEN, refreshToken: 'r', expiresAt: T0.getTime() + 3_600_000 } }), fetch, now: () => T0 });
  const a = await p.sample();
  assert.equal(seen, TOKEN);
  assert.equal(a.status, 'ok');
  assert.equal(a.account.scope, 'profile');
  assert.doesNotMatch(JSON.stringify(a), /SECRET|refresh/i, 'no token material in the result');
});

test('honest unavailability: no credentials, expired token, refused, rate-limited, unreachable, garbage — each with a reason', async () => {
  const ok: UsageFetch = async () => ({ status: 200, body: JSON.stringify(RESPONSE) });
  const cases: Array<[string, string, UsageFetch, RegExp]> = [
    ['no creds', home(), ok, /no Claude login credentials/],
    ['expired', home({ claudeAiOauth: { accessToken: TOKEN, expiresAt: T0.getTime() - 1 } }), ok, /expired/],
    ['401', home({ claudeAiOauth: { accessToken: TOKEN } }), async () => ({ status: 401, body: '' }), /refused the login/],
    ['429', home({ claudeAiOauth: { accessToken: TOKEN } }), async () => ({ status: 429, body: '' }), /rate-limiting/],
    ['down', home({ claudeAiOauth: { accessToken: TOKEN } }), async () => { throw new Error(`boom ${TOKEN}`); }, /could not be reached/],
    ['garbage', home({ claudeAiOauth: { accessToken: TOKEN } }), async () => ({ status: 200, body: '<html>' }), /unreadable/],
  ];
  for (const [name, dir, fetch, reason] of cases) {
    const a = await claudeUsageApiProvider({ claudeConfigDir: dir, fetch, now: () => T0 }).sample();
    assert.equal(a.status, 'unavailable', name);
    assert.match(a.reason ?? '', reason, name);
    assert.doesNotMatch(JSON.stringify(a), /SECRET/, `${name}: no token in the reason`);
  }
});

test('combined provider: the endpoint when it works; otherwise the statusline tap, saying why', async () => {
  const dir = home({ claudeAiOauth: { accessToken: TOKEN } });
  const tapDir = join(root, 'taps');
  const rec = tapRecordFrom({ rate_limits: { five_hour: { used_percentage: 6, resets_at: 1790620000 }, seven_day: { used_percentage: 21, resets_at: 1791000000 } } }, T0)!;
  mkdirSync(tapDir, { recursive: true });
  writeFileSync(claudeTapPath(dir, tapDir), JSON.stringify(rec));
  const tap = claudeAccountUsageProvider({ claudeConfigDir: dir, tapDir, now: () => T0 });
  const up = claudeCombinedProvider(claudeUsageApiProvider({ claudeConfigDir: dir, fetch: async () => ({ status: 200, body: JSON.stringify(RESPONSE) }), now: () => T0 }), tap);
  assert.equal((await up.sample()).buckets.length, 2, 'endpoint (with Fable)');
  const down = claudeCombinedProvider(claudeUsageApiProvider({ claudeConfigDir: dir, fetch: async () => ({ status: 503, body: '' }), now: () => T0 }), tap);
  const fb = await down.sample();
  assert.deepEqual([fb.status, fb.buckets.length, fb.fallback], ['ok', 1, true], 'never worked: the tap stands in, flagged');
  assert.match(fb.reason ?? '', /usage endpoint unavailable \(.*HTTP 503.*\); showing statusline data/);

  // Once the endpoint has worked, a later failure is returned as-is (the monitor keeps the Fable reading as stale).
  let status = 200;
  const flaky = claudeCombinedProvider(claudeUsageApiProvider({ claudeConfigDir: dir, fetch: async () => ({ status, body: JSON.stringify(RESPONSE) }), now: () => T0 }), tap);
  assert.equal((await flaky.sample()).buckets.length, 2);
  status = 429;
  const after = await flaky.sample();
  assert.deepEqual([after.status, after.fallback ?? false], ['unavailable', false], 'no swap to the smaller tap shape');
});

test('limits fallbacks: session → 5h and weekly_all → weekly when the top-level buckets are absent (placeholders ignored)', () => {
  const b = bucketsFromUsageResponse({ limits: [
    { kind: 'session', percent: 0, resets_at: null }, // placeholder
    { kind: 'session', percent: 9, resets_at: '2026-09-28T18:00:00Z' },
    { kind: 'weekly_all', percent: 33, resets_at: '2026-10-04T09:00:00Z' },
  ] }, T0.toISOString())!;
  assert.deepEqual(b[0]!.windows.map((w) => [w.durationMinutes, w.usedPercent]), [[300, 9], [10_080, 33]]);
});
