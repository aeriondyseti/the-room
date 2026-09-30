// Claude plan usage from Anthropic's usage endpoint (6.6, option B). Kevin approved this explicitly (room,
// 2026-09-28) after the statusline tap proved it lacks the model-specific weekly limit (Fable). Opt-in via config.
// Safeguards (invariant 6 spirit): the OAuth access token is read fresh from `<claude config>/.credentials.json` per
// request, held only in memory, sent only in the Authorization header to this one endpoint, and never stored,
// logged, returned or shown. The refresh token is never used: an expired token just reads as unavailable until Claude
// Code refreshes it. Undocumented endpoint (as used by ccstatusline 2.2.30): shape changes degrade to unavailable.
import { request } from 'node:https';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AccountUsage, AccountUsageProvider, UsageBucket, UsageWindow } from '../../contracts/account.js';
import { claudeProfileKey } from './rate-limits.js';

export const CLAUDE_USAGE_HOST = 'api.anthropic.com';
export const CLAUDE_USAGE_PATH = '/api/oauth/usage';
const MAX_RESPONSE_BYTES = 64 * 1024;

export type UsageFetch = (token: string, timeoutMs: number) => Promise<{ status: number; body: string; retryAfterSec?: number | null }>;

/** GET the usage endpoint. Errors are fixed strings: nothing from the token, headers or response can leak. */
export const httpsUsageFetch: UsageFetch = (token, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = request(
      { host: CLAUDE_USAGE_HOST, path: CLAUDE_USAGE_PATH, method: 'GET', timeout: timeoutMs,
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'the-room', Accept: 'application/json' } },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) req.destroy(new Error('response too large'));
          else chunks.push(c);
        });
        const ra = Number(res.headers['retry-after']);
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : null }));
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

/**
 * Throttling (Kevin: the endpoint rate-limits; ccstatusline caches 180s and backs off 300s on 429). Every room service
 * for this Claude profile shares one small cache file (numbers only, never the token or raw response):
 *  - a good reading is reused for `minIntervalMs` (default 5 min) instead of calling again;
 *  - a 429 sets a back-off until Retry-After (else `rateLimitBackoffMs`, default 5 min); nothing is called meanwhile;
 *  - any other failure is reused for `errorRetryMs` (default 60s) so a broken endpoint isn't hammered;
 *  - calls are single-flight in-process, and a short-lived reservation file (created exclusively) keeps two services
 *    from calling at once. This is best-effort exclusion, not a strict guarantee: a reservation older than
 *    `lockMs` is treated as abandoned (a crashed caller) and taken over.
 */
export interface UsageThrottle {
  minIntervalMs: number;
  rateLimitBackoffMs: number;
  errorRetryMs: number;
  /** How long a reservation is honoured before it's considered abandoned. */
  lockMs?: number;
  /** Shared cache file (and `<file>.lock` reservation); memory-only when absent. */
  cachePath?: string;
}
/** Shared cache file for one Claude profile (every room service on this machine reuses it). */
export function sharedUsageCachePath(claudeConfigDir: string): string {
  return join(homedir(), '.vibe-pairing', `claude-usage-cache-${claudeProfileKey(claudeConfigDir)}.json`);
}
export const DEFAULT_USAGE_THROTTLE: UsageThrottle = { minIntervalMs: 5 * 60_000, rateLimitBackoffMs: 5 * 60_000, errorRetryMs: 60_000 };

interface UsageCache { attemptedAt: number; result: AccountUsage; backoffUntil?: number }

async function readCache(path: string): Promise<UsageCache | null> {
  try {
    const c = JSON.parse(await readFile(path, 'utf8')) as UsageCache;
    return typeof c?.attemptedAt === 'number' && c.result ? c : null;
  } catch {
    return null;
  }
}
/**
 * Take the reservation (exclusive create). The lock holds `{at, nonce}`; a lock that is empty or unreadable (a writer
 * between create and write) counts as held while its file mtime is recent. One older than `lockMs` is abandoned and
 * taken over once, only if it still holds exactly what we judged stale. Returns our nonce, or null if held elsewhere.
 */
async function reserve(lock: string, at: number, lockMs: number): Promise<string | null | 'uncoordinated'> {
  try {
    await mkdir(dirname(lock), { recursive: true });
  } catch {
    return 'uncoordinated'; // can't coordinate across processes; in-process single-flight still applies
  }
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const h = await open(lock, 'wx');
      try {
        await h.writeFile(JSON.stringify({ at, nonce }));
      } finally {
        await h.close();
      }
      return nonce;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return 'uncoordinated';
      try {
        const raw = await readFile(lock, 'utf8');
        const held = lockData(raw);
        if (held ? at - held.at < lockMs : Date.now() - (await stat(lock)).mtimeMs < lockMs) return null;
        if ((await readFile(lock, 'utf8')) !== raw) return null; // replaced meanwhile: someone else took it over
        await unlink(lock);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function lockData(raw: string): { at: number; nonce: string | null } | null {
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v === 'number' && Number.isFinite(v)) return { at: v, nonce: null };
    const o = v as { at?: unknown; nonce?: unknown } | null;
    return o && typeof o.at === 'number' && Number.isFinite(o.at) ? { at: o.at, nonce: typeof o.nonce === 'string' ? o.nonce : null } : null;
  } catch {
    return null;
  }
}

/** Release only our own reservation: never unlink a lock another service has since taken over. */
async function release(lock: string, nonce: string): Promise<void> {
  try {
    if (lockData(await readFile(lock, 'utf8'))?.nonce === nonce) await unlink(lock);
  } catch {
    // already gone, or unreadable: leave it; it is abandoned after lockMs
  }
}
async function writeCache(path: string, cache: UsageCache): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(cache));
    await rename(tmp, path);
  } catch {
    // best effort: the in-memory copy still throttles this process
  }
}

export function claudeUsageApiProvider(opts: { claudeConfigDir: string; timeoutMs?: number; fetch?: UsageFetch; now?: () => Date; throttle?: Partial<UsageThrottle> }): AccountUsageProvider {
  const key = claudeProfileKey(opts.claudeConfigDir);
  const fetchUsage = opts.fetch ?? httpsUsageFetch;
  const now = opts.now ?? (() => new Date());
  const source = `claude ${CLAUDE_USAGE_HOST}${CLAUDE_USAGE_PATH}`;
  const t: UsageThrottle = { ...DEFAULT_USAGE_THROTTLE, ...opts.throttle };
  // No path = memory-only throttling (tests); the service passes the shared ~/.vibe-pairing file (see sharedUsageCachePath).
  const cachePath = t.cachePath ?? null;
  let memory: UsageCache | null = null;
  let inFlight: Promise<AccountUsage> | null = null;
  const lockMs = t.lockMs ?? 30_000;
  const throttledSample = async (): Promise<AccountUsage> => {
    const at = now().getTime();
    const cached = (cachePath ? await readCache(cachePath) : null) ?? memory;
    const reuse = (c: UsageCache) => {
      const age = at - c.attemptedAt;
      return c.backoffUntil !== undefined ? at < c.backoffUntil : c.result.status === 'ok' ? age < t.minIntervalMs : age < t.errorRetryMs;
    };
    if (cached && reuse(cached)) return { ...cached.result, checkedAt: new Date(at).toISOString() };
    // Cross-process reservation: only the holder calls; others serve what's cached (even if expired) meanwhile.
    const lock = cachePath ? `${cachePath}.lock` : null;
    const held = lock ? await reserve(lock, at, lockMs) : 'uncoordinated';
    if (held === null) {
      return cached ? { ...cached.result, checkedAt: new Date(at).toISOString() }
        : { account: { harness: 'claude', scope: 'profile', key, sourceKey: key }, buckets: [], status: 'unavailable', reason: 'another room service is fetching Claude usage right now', source, checkedAt: new Date(at).toISOString(), observedAt: null };
    }
    try {
      // Re-read under the reservation: another service may have fetched between our first read and taking the lock.
      const latest = cachePath ? await readCache(cachePath) : null;
      if (latest && reuse(latest)) {
        memory = latest;
        return { ...latest.result, checkedAt: new Date(at).toISOString() };
      }
      const { result, backoffUntil } = await sampleNow();
      memory = { attemptedAt: at, result, ...(backoffUntil !== undefined ? { backoffUntil } : {}) };
      if (cachePath) await writeCache(cachePath, memory);
      return result;
    } finally {
      if (lock && held !== 'uncoordinated') await release(lock, held);
    }
  };  const sampleNow = async (): Promise<{ result: AccountUsage; backoffUntil?: number }> => {
      const at = now();
      const base = { account: { harness: 'claude' as const, scope: 'profile' as const, key, sourceKey: key }, source, checkedAt: at.toISOString() };
      const unavailable = (reason: string): AccountUsage => ({ ...base, buckets: [], status: 'unavailable', reason, observedAt: null });
      const cred = await readAccessToken(opts.claudeConfigDir, at.getTime());
      if ('reason' in cred) return { result: unavailable(cred.reason) };
      let res: { status: number; body: string; retryAfterSec?: number | null };
      try {
        res = await fetchUsage(cred.token, opts.timeoutMs ?? 5_000);
      } catch {
        return { result: unavailable('the Claude usage endpoint could not be reached') };
      }
      if (res.status === 401 || res.status === 403) return { result: unavailable('the Claude usage endpoint refused the login (it may need Claude Code to refresh it)') };
      if (res.status === 429) {
        const until = at.getTime() + (res.retryAfterSec ? res.retryAfterSec * 1000 : t.rateLimitBackoffMs);
        return { result: unavailable(`the Claude usage endpoint is rate-limiting; next try after ${new Date(until).toISOString().slice(11, 16)} UTC`), backoffUntil: until };
      }
      if (res.status < 200 || res.status >= 300) return { result: unavailable(`the Claude usage endpoint returned HTTP ${res.status}`) };
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.body);
      } catch {
        return { result: unavailable('the Claude usage endpoint returned an unreadable response') };
      }
      const observedAt = at.toISOString();
      const buckets = bucketsFromUsageResponse(parsed, observedAt);
      if (!buckets || !buckets.some((b) => b.windows.some((w) => w.usedPercent !== null))) return { result: unavailable('the Claude usage endpoint response had no usable limits') };
      return { result: { ...base, buckets, status: 'ok', observedAt } };
  };
  return {
    harness: 'claude',
    id: `claude:${key}`,
    sample(): Promise<AccountUsage> {
      inFlight ??= (async () => {
        try {
          return await throttledSample();
        } catch {
          return { account: { harness: 'claude', scope: 'profile', key, sourceKey: key }, buckets: [], status: 'unavailable', reason: 'the Claude usage reader failed unexpectedly', source, checkedAt: now().toISOString(), observedAt: null };
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
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
