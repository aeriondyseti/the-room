// Claude plan usage from ccstatusline's own cache (Kevin, 2026-09-28: "piggyback on ccstatusline's values so that the
// usage endpoint only needs to get called once"). ccstatusline fetches Anthropic's usage endpoint (throttled) and
// writes the parsed numbers to ~/.cache/ccstatusline/usage.json with a token HASH (never the token). Reading that file
// costs zero endpoint calls and touches no credentials. Read-only; we never write it.
//
// Attribution (Astra's reviews): the cache is one GLOBAL file written by whichever ccstatusline ran last, so which login
// it reflects is NOT verified. It is used only for the default Claude profile (no custom CLAUDE_CONFIG_DIR), labelled
// as an unverified shared source, and gets its own opaque identity derived from the cache's token hash (scope 'profile': a
// token hash is not a verified account id, and it rotates with the token). sourceKey stays the profile key so the top
// bar keeps one Claude row whichever source is serving it. Freshness comes from the
// file mtime (ccstatusline refreshes it only while a Claude statusline renders).
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AccountUsage, AccountUsageProvider, UsageBucket, UsageWindow } from '../../contracts/account.js';

export const CCSTATUSLINE_CACHE = join(homedir(), '.cache', 'ccstatusline', 'usage.json');
export const CCSTATUSLINE_SOURCE = 'shared ccstatusline cache (login unverified)';

/** True when `claudeConfigDir` is the default profile ccstatusline reads (~/.claude). */
export function isDefaultClaudeProfile(claudeConfigDir: string, home: string = homedir()): boolean {
  const a = resolve(claudeConfigDir), b = resolve(home, '.claude');
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const pct = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null);
const iso = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);

/** ccstatusline's cached fields → buckets: main (5h + weekly) and model-scoped weeklies. */
export function bucketsFromCcstatusline(cache: Record<string, unknown>, observedAt: string): UsageBucket[] {
  const w = (kind: string, minutes: number, usage: unknown, reset: unknown): UsageWindow => {
    const usedPercent = pct(usage);
    return { kind, durationMinutes: minutes, usedPercent, resetsAt: iso(reset), observedAt,
      ...(usedPercent === null ? { reason: `ccstatusline has no ${minutes === 300 ? '5h' : 'weekly'} value` } : {}) };
  };
  const buckets: UsageBucket[] = [{ id: 'claude', windows: [w('five_hour', 300, cache.sessionUsage, cache.sessionResetAt), w('seven_day', 10_080, cache.weeklyUsage, cache.weeklyResetAt)] }];
  // Fable comes from ccstatusline's scoped-limit parser, which already filters placeholders, so any number is a
  // reading (0% included). Sonnet/Opus come from buckets where ccstatusline maps a null bucket to 0, so a 0 without a
  // reset time is a placeholder, not a reading.
  const models = [['Fable', 'fableUsage', 'fableResetAt', false], ['Sonnet', 'weeklySonnetUsage', 'weeklySonnetResetAt', true], ['Opus', 'weeklyOpusUsage', 'weeklyOpusResetAt', true]] as const;
  for (const [label, usage, reset, zeroIsPlaceholder] of models) {
    const value = pct(cache[usage]);
    if (value === null || (zeroIsPlaceholder && value === 0 && !iso(cache[reset]))) continue;
    buckets.push({ id: `claude-${label.toLowerCase()}`, label, windows: [{ kind: `weekly_${label.toLowerCase()}`, durationMinutes: 10_080, usedPercent: value, resetsAt: iso(cache[reset]), observedAt }] });
  }
  return buckets;
}

/** Opaque account key from ccstatusline's token hash (re-hashed: the hash itself is never exposed). */
export function ccstatuslineAccountKey(tokenHash: string): string {
  return `ccstatusline-${createHash('sha256').update(`ccstatusline:${tokenHash}`).digest('hex').slice(0, 12)}`;
}

export function ccstatuslineCacheProvider(opts: { profileKey: string; path?: string; now?: () => Date }): AccountUsageProvider {
  const path = opts.path ?? CCSTATUSLINE_CACHE;
  const now = opts.now ?? (() => new Date());
  const profileKey = opts.profileKey;
  return {
    harness: 'claude',
    id: `claude:${profileKey}`,
    async sample(): Promise<AccountUsage> {
      const checkedAt = now().toISOString();
      // No token hash seen (read failure, or a cache without one) = no identity: key = sourceKey (the profile), which the
      // AccountMonitor treats as "unidentified" — never stamped with a previously seen login.
      let key = profileKey;
      const base = () => ({ account: { harness: 'claude' as const, scope: 'profile' as const, key, sourceKey: profileKey }, source: CCSTATUSLINE_SOURCE, checkedAt });
      const unavailable = (reason: string): AccountUsage => ({ ...base(), buckets: [], status: 'unavailable', reason, observedAt: null });
      try {
        let text: string;
        let mtime: Date;
        try {
          [text, mtime] = await Promise.all([readFile(path, 'utf8'), stat(path).then((s) => s.mtime)]);
        } catch {
          return unavailable('no ccstatusline usage cache (is ccstatusline your Claude statusline?)');
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return unavailable('the ccstatusline usage cache is unreadable');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return unavailable('the ccstatusline usage cache has an unexpected shape');
        const cache = parsed as Record<string, unknown>;
        if (typeof cache.tokenHash === 'string' && cache.tokenHash) key = ccstatuslineAccountKey(cache.tokenHash);
        // Fixed text: never echo the cache's own error string.
        if (cache.error !== undefined && cache.error !== null && cache.error !== '') return unavailable('ccstatusline reported a usage fetch error');
        const observedAt = mtime.toISOString();
        const buckets = bucketsFromCcstatusline(cache, observedAt);
        if (!buckets.some((b) => b.windows.some((x) => x.usedPercent !== null))) return unavailable('the ccstatusline usage cache has no values yet');
        return { ...base(), buckets, status: 'ok', observedAt };
      } catch {
        return unavailable('the ccstatusline usage cache could not be read');
      }
    },
  };
}

/**
 * Source selection with freshness (Astra's review): the first FRESH ok reading wins. If every ok reading is older than
 * `freshMs`, the first ok one is returned anyway (the AccountMonitor ages it into `stale`, keeping e.g. Fable visible
 * and labelled) — so an old ccstatusline cache never blocks a fresher opted-in source. When all fail, the first
 * failure's reason is kept. The statusline tap (no model limits) is flagged as a reduced fallback whenever it stands in
 * for a fuller source that was tried first — failed, or ok but old.
 */
export function firstAvailable(id: string, providers: readonly AccountUsageProvider[], opts: { freshMs: number; now?: () => Date }): AccountUsageProvider {
  const now = opts.now ?? (() => new Date());
  // Model-scoped limits (e.g. Fable) seen from a fuller source. The tap can't report them and its login can't be matched
  // to the cache's, so when it stands in they are shown explicitly as unavailable — never as retained old values.
  const knownModels = new Map<string, string | undefined>();
  const TAP = 'claude statusline tap';
  return {
    harness: 'claude',
    id,
    async sample(): Promise<AccountUsage> {
      let firstFailure: AccountUsage | null = null;
      let firstOk: AccountUsage | null = null;
      const mark = (a: AccountUsage): AccountUsage => {
        const replaced = firstOk && firstOk !== a ? { source: firstOk.source, reason: `last reading ${firstOk.observedAt ?? 'unknown'} is old` } : firstFailure;
        if (a.source !== TAP || !replaced) return a;
        const missing = [...knownModels].filter(([bid]) => !a.buckets.some((b) => b.id === bid)).map(([bid, label]): UsageBucket => ({ id: bid, ...(label ? { label } : {}),
          windows: [{ kind: 'weekly_scoped', durationMinutes: 10_080, usedPercent: null, resetsAt: null, reason: 'the statusline tap does not report model-specific limits' }] }));
        return { ...a, buckets: [...a.buckets, ...missing], fallback: true, reason: `${replaced.source}: ${replaced.reason ?? 'unavailable'}` };
      };
      for (const p of providers) {
        const a = await p.sample();
        if (a.status === 'ok' && a.source !== TAP) for (const b of a.buckets) if (b.id !== 'claude') knownModels.set(b.id, b.label);
        if (a.status !== 'ok') {
          firstFailure ??= a;
          continue;
        }
        const age = a.observedAt ? now().getTime() - Date.parse(a.observedAt) : Infinity;
        if (age <= opts.freshMs) return mark(a);
        firstOk ??= a;
      }
      return firstOk ? mark(firstOk) : firstFailure!;
    },
  };
}
