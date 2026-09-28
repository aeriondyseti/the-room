// Claude plan usage from ccstatusline's own cache (Kevin, 2026-09-28: "piggyback on ccstatusline's values so the
// usage endpoint only needs to get called once"). ccstatusline already fetches Anthropic's usage endpoint (throttled,
// 180s cache) and writes the parsed numbers to ~/.cache/ccstatusline/usage.json; it stores a token HASH, never the
// token. Reading that file costs zero endpoint calls and touches no credentials. Read-only; we never write it.
// Freshness comes from the file's mtime (ccstatusline refreshes it only while a Claude statusline is rendering), so the
// AccountMonitor ages an old file into `stale`.
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AccountUsage, AccountUsageProvider, UsageBucket, UsageWindow } from '../../contracts/account.js';

export const CCSTATUSLINE_CACHE = join(homedir(), '.cache', 'ccstatusline', 'usage.json');

const pct = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null);
const iso = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);

/** ccstatusline's cached fields → buckets: main (5h + weekly) and model-scoped weeklies (Fable, Sonnet, Opus). */
export function bucketsFromCcstatusline(cache: Record<string, unknown>, observedAt: string): UsageBucket[] {
  const w = (kind: string, minutes: number, usage: unknown, reset: unknown): UsageWindow => {
    const usedPercent = pct(usage);
    return { kind, durationMinutes: minutes, usedPercent, resetsAt: iso(reset), observedAt,
      ...(usedPercent === null ? { reason: `ccstatusline has no ${minutes === 300 ? '5h' : 'weekly'} value` } : {}) };
  };
  const buckets: UsageBucket[] = [{ id: 'claude', windows: [w('five_hour', 300, cache.sessionUsage, cache.sessionResetAt), w('seven_day', 10_080, cache.weeklyUsage, cache.weeklyResetAt)] }];
  // Model-scoped weeklies: shown when ccstatusline has a value (Sonnet/Opus often report 0 with no reset: a
  // placeholder, not a reading, so those are only shown when they carry a reset time).
  for (const [label, usage, reset] of [['Fable', 'fableUsage', 'fableResetAt'], ['Sonnet', 'weeklySonnetUsage', 'weeklySonnetResetAt'], ['Opus', 'weeklyOpusUsage', 'weeklyOpusResetAt']] as const) {
    const value = pct(cache[usage]);
    if (value === null || (value === 0 && !iso(cache[reset]))) continue;
    buckets.push({ id: `claude-${label.toLowerCase()}`, label, windows: [{ kind: `weekly_${label.toLowerCase()}`, durationMinutes: 10_080, usedPercent: value, resetsAt: iso(cache[reset]), observedAt }] });
  }
  return buckets;
}

export function ccstatuslineCacheProvider(opts: { profileKey: string; path?: string; now?: () => Date }): AccountUsageProvider {
  const path = opts.path ?? CCSTATUSLINE_CACHE;
  const now = opts.now ?? (() => new Date());
  const key = opts.profileKey;
  return {
    harness: 'claude',
    id: `claude:${key}`,
    async sample(): Promise<AccountUsage> {
      const checkedAt = now().toISOString();
      const base = { account: { harness: 'claude' as const, scope: 'profile' as const, key, sourceKey: key }, source: 'ccstatusline cache', checkedAt };
      const unavailable = (reason: string): AccountUsage => ({ ...base, buckets: [], status: 'unavailable', reason, observedAt: null });
      let text: string;
      let mtime: Date;
      try {
        [text, mtime] = await Promise.all([readFile(path, 'utf8'), stat(path).then((s) => s.mtime)]);
      } catch {
        return unavailable('no ccstatusline usage cache (is ccstatusline your Claude statusline?)');
      }
      let cache: Record<string, unknown>;
      try {
        cache = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return unavailable('the ccstatusline usage cache is unreadable');
      }
      if (typeof cache.error === 'string' && cache.error) return unavailable(`ccstatusline reported a usage error (${cache.error.slice(0, 60)})`);
      const observedAt = mtime.toISOString();
      const buckets = bucketsFromCcstatusline(cache, observedAt);
      if (!buckets.some((b) => b.windows.some((x) => x.usedPercent !== null))) return unavailable('the ccstatusline usage cache has no values yet');
      return { ...base, buckets, status: 'ok', observedAt };
    },
  };
}

/** First source that has a reading wins; the reason of the first failure is kept when all fail. */
export function firstAvailable(id: string, providers: readonly AccountUsageProvider[]): AccountUsageProvider {
  return {
    harness: 'claude',
    id,
    async sample(): Promise<AccountUsage> {
      let first: AccountUsage | null = null;
      for (const p of providers) {
        const a = await p.sample();
        // Only the statusline tap lacks model-specific limits, so only it is flagged as a (reduced) fallback.
        if (a.status === 'ok') return first && a.source === 'claude statusline tap' ? { ...a, fallback: true, reason: `${first.source}: ${first.reason ?? 'unavailable'}` } : a;
        first ??= a;
      }
      return first!;
    },
  };
}
