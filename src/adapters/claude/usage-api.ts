// Claude plan usage from Anthropic's usage endpoint (6.6, option B). Kevin approved this explicitly (room,
// 2026-09-28) after the statusline tap proved it lacks the model-specific weekly limit (Fable). Opt-in via config.
// Safeguards (invariant 6 spirit): the OAuth access token is read fresh from `<claude config>/.credentials.json` per
// request, held only in memory, sent only in the Authorization header to this one endpoint, and never stored,
// logged, returned or shown. The refresh token is never used: an expired token just reads as unavailable until Claude
// Code refreshes it. Undocumented endpoint (as used by ccstatusline 2.2.30): shape changes degrade to unavailable.
import { request } from 'node:https';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccountUsage, AccountUsageProvider, UsageBucket, UsageWindow } from '../../contracts/account.js';
import { claudeProfileKey } from './rate-limits.js';

export const CLAUDE_USAGE_HOST = 'api.anthropic.com';
export const CLAUDE_USAGE_PATH = '/api/oauth/usage';
const MAX_RESPONSE_BYTES = 64 * 1024;

export type UsageFetch = (token: string, timeoutMs: number) => Promise<{ status: number; body: string }>;

/** GET the usage endpoint. Errors are fixed strings: nothing from the token, headers or response can leak. */
export const httpsUsageFetch: UsageFetch = (token, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = request(
      { host: CLAUDE_USAGE_HOST, path: CLAUDE_USAGE_PATH, method: 'GET', timeout: timeoutMs,
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'vibe-pairing', Accept: 'application/json' } },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) req.destroy(new Error('response too large'));
          else chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', () => reject(new Error('response error')));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => reject(new Error('request failed')));
    req.end();
  });

/** Only the access token, read per call; never cached, never logged. Null when absent/unreadable/expired. */
async function readAccessToken(claudeConfigDir: string, now: number): Promise<{ token: string } | { reason: string }> {
  let raw: string;
  try {
    raw = await readFile(join(claudeConfigDir, '.credentials.json'), 'utf8');
  } catch {
    return { reason: 'no Claude login credentials found (is Claude Code signed in with a subscription?)' };
  }
  try {
    const oauth = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } }).claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return { reason: 'Claude credentials have no subscription login' };
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt < now) return { reason: 'the Claude login token has expired; Claude Code refreshes it on its next request' };
    return { token: oauth.accessToken };
  } catch {
    return { reason: 'Claude credentials could not be parsed' };
  }
}

const pct = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null);
const iso = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);

/** Map the endpoint's response to buckets: main (5h + weekly) plus one bucket per model-scoped weekly limit. */
export function bucketsFromUsageResponse(body: unknown, observedAt: string): UsageBucket[] | null {
  if (!body || typeof body !== 'object') return null;
  const r = body as Record<string, unknown>;
  const win = (key: string, minutes: number): UsageWindow => {
    const b = r[key] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    const usedPercent = b ? pct(b.utilization) : null;
    return { kind: key, durationMinutes: minutes, usedPercent, resetsAt: b ? iso(b.resets_at) : null, observedAt,
      ...(usedPercent === null ? { reason: `the usage endpoint reported no ${minutes === 300 ? '5h' : 'weekly'} value` } : {}) };
  };
  const limits = Array.isArray(r.limits) ? (r.limits as Array<Record<string, unknown>>) : [];
  // Fallbacks when the top-level bucket is absent (ccstatusline): limits kind 'session' (5h) / 'weekly_all' (weekly).
  // An unscoped entry with 0% and no reset time is a placeholder, not a reading.
  const fromLimit = (kind: string, key: string, minutes: number, primary: UsageWindow): UsageWindow => {
    if (primary.usedPercent !== null) return primary;
    const l = limits.find((x) => x?.kind === kind && !(Number(x.percent ?? 0) === 0 && (x.resets_at ?? null) === null));
    const usedPercent = l ? pct(l.percent) : null;
    return usedPercent === null ? primary : { kind: key, durationMinutes: minutes, usedPercent, resetsAt: iso(l!.resets_at), observedAt };
  };
  const buckets: UsageBucket[] = [{ id: 'claude', windows: [fromLimit('session', 'five_hour', 300, win('five_hour', 300)), fromLimit('weekly_all', 'seven_day', 10_080, win('seven_day', 10_080))] }];
  const seen = new Set<string>();
  for (const l of limits) {
    if (l?.kind !== 'weekly_scoped') continue;
    const model = (l.scope as { model?: { display_name?: unknown } } | null | undefined)?.model?.display_name;
    if (typeof model !== 'string' || !model.trim()) continue; // unscoped placeholders are not a model limit
    const label = model.trim().slice(0, 40);
    const id = `claude-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    if (seen.has(id)) continue;
    seen.add(id);
    buckets.push({ id, label, windows: [{ kind: 'weekly_scoped', durationMinutes: 10_080, usedPercent: pct(l.percent), resetsAt: iso(l.resets_at), observedAt }] });
  }
  for (const [key, label] of [['seven_day_sonnet', 'Sonnet'], ['seven_day_opus', 'Opus']] as const) {
    const id = `claude-${label.toLowerCase()}`;
    const b = r[key] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    if (!b || seen.has(id) || pct(b.utilization) === null) continue;
    seen.add(id);
    buckets.push({ id, label, windows: [{ kind: key, durationMinutes: 10_080, usedPercent: pct(b.utilization), resetsAt: iso(b.resets_at), observedAt }] });
  }
  return buckets;
}

export function claudeUsageApiProvider(opts: { claudeConfigDir: string; timeoutMs?: number; fetch?: UsageFetch; now?: () => Date }): AccountUsageProvider {
  const key = claudeProfileKey(opts.claudeConfigDir);
  const fetchUsage = opts.fetch ?? httpsUsageFetch;
  const now = opts.now ?? (() => new Date());
  const source = `claude ${CLAUDE_USAGE_HOST}${CLAUDE_USAGE_PATH}`;
  return {
    harness: 'claude',
    id: `claude:${key}`,
    async sample(): Promise<AccountUsage> {
      const at = now();
      const base = { account: { harness: 'claude' as const, scope: 'profile' as const, key, sourceKey: key }, source, checkedAt: at.toISOString() };
      const unavailable = (reason: string): AccountUsage => ({ ...base, buckets: [], status: 'unavailable', reason, observedAt: null });
      const cred = await readAccessToken(opts.claudeConfigDir, at.getTime());
      if ('reason' in cred) return unavailable(cred.reason);
      let res: { status: number; body: string };
      try {
        res = await fetchUsage(cred.token, opts.timeoutMs ?? 5_000);
      } catch {
        return unavailable('the Claude usage endpoint could not be reached');
      }
      if (res.status === 401 || res.status === 403) return unavailable('the Claude usage endpoint refused the login (it may need Claude Code to refresh it)');
      if (res.status === 429) return unavailable('the Claude usage endpoint is rate-limiting; will retry');
      if (res.status < 200 || res.status >= 300) return unavailable(`the Claude usage endpoint returned HTTP ${res.status}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.body);
      } catch {
        return unavailable('the Claude usage endpoint returned an unreadable response');
      }
      const observedAt = at.toISOString();
      const buckets = bucketsFromUsageResponse(parsed, observedAt);
      if (!buckets || !buckets.some((b) => b.windows.some((w) => w.usedPercent !== null))) return unavailable('the Claude usage endpoint response had no usable limits');
      return { ...base, buckets, status: 'ok', observedAt };
    },
  };
}

/**
 * Prefer the endpoint. Once it has succeeded, a failure is returned as-is so the AccountMonitor keeps the last
 * endpoint reading (incl. model-specific limits like Fable) as labelled `stale` rather than swapping in the tap's
 * smaller shape. Only while the endpoint has never worked do we show the tap, marked as a fallback.
 */
export function claudeCombinedProvider(api: AccountUsageProvider, tap: AccountUsageProvider): AccountUsageProvider {
  let apiEverOk = false;
  return {
    harness: 'claude',
    id: api.id,
    async sample(): Promise<AccountUsage> {
      const a = await api.sample();
      if (a.status === 'ok') {
        apiEverOk = true;
        return a;
      }
      if (apiEverOk) return a;
      const t = await tap.sample();
      return t.status === 'ok' ? { ...t, fallback: true, reason: `usage endpoint unavailable (${a.reason ?? 'unknown'}); showing statusline data` } : a;
    },
  };
}
