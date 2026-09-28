// Claude plan usage (6.6). Claude Code exposes plan limits only to the user's statusline command
// (`rate_limits.<window>.used_percentage / resets_at`, 2.1.80+); no hook, cache or CLI carries them. So this is
// opt-in: the user wraps their statusline with `room statusline-tap`, which saves just those numbers to a tap file,
// and this provider reads that file. Read-only; never reads credentials; a profile, not a verified account.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AccountUsage, AccountUsageProvider, UsageBucket, UsageWindow } from '../../contracts/account.js';

/** What the tap stores: only per-window numbers and when they were seen. */
export interface ClaudeTapRecord {
  version: 1;
  observedAt: string;
  claudeVersion: string | null;
  windows: Record<string, { usedPercent: number | null; resetsAt: string | null }>;
}

export function claudeProfileKey(claudeConfigDir: string): string {
  return createHash('sha256').update(`claude:${claudeConfigDir.toLowerCase()}`).digest('hex').slice(0, 16);
}

/** Tap file for one Claude profile (outside Claude's own directory: we never write harness state). */
export function claudeTapPath(claudeConfigDir: string, baseDir: string = join(homedir(), '.vibe-pairing')): string {
  return join(baseDir, `claude-rate-limits-${claudeProfileKey(claudeConfigDir)}.json`);
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Extract the tap record from a statusline input object (anything else in it is ignored and never stored). */
export function tapRecordFrom(input: unknown, now: Date): ClaudeTapRecord | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as { rate_limits?: unknown; version?: unknown };
  if (!i.rate_limits || typeof i.rate_limits !== 'object') return null;
  const windows: ClaudeTapRecord['windows'] = {};
  for (const [key, w] of Object.entries(i.rate_limits as Record<string, unknown>)) {
    if (!/^[a-z0-9_]{1,40}$/i.test(key) || !w || typeof w !== 'object') continue;
    const v = w as { used_percentage?: unknown; resets_at?: unknown };
    const resets = num(v.resets_at);
    windows[key] = { usedPercent: num(v.used_percentage), resetsAt: resets === null ? null : new Date(resets * 1000).toISOString() };
  }
  if (Object.keys(windows).length === 0) return null;
  return { version: 1, observedAt: now.toISOString(), claudeVersion: typeof i.version === 'string' ? i.version.slice(0, 40) : null, windows };
}

export async function writeTapRecord(path: string, record: ClaudeTapRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(record));
  await rename(tmp, path);
}

/** `five_hour` → 5h; `seven_day` → weekly; `seven_day_<model>` → weekly in its own bucket; others by key. */
export function windowFor(key: string): { bucket: string; bucketLabel?: string; window: Omit<UsageWindow, 'usedPercent' | 'resetsAt'> } {
  if (key === 'five_hour') return { bucket: 'claude', window: { kind: key, durationMinutes: 300 } };
  if (key === 'seven_day') return { bucket: 'claude', window: { kind: key, durationMinutes: 10_080 } };
  const m = /^seven_day_(.+)$/.exec(key);
  if (m) {
    const model = m[1]!.replace(/_/g, ' ');
    return { bucket: `claude-${m[1]}`, bucketLabel: model.charAt(0).toUpperCase() + model.slice(1), window: { kind: key, durationMinutes: 10_080 } };
  }
  return { bucket: 'claude', window: { kind: key, durationMinutes: null } };
}

export function accountUsageFromTap(record: ClaudeTapRecord, profileKey: string, checkedAt: Date): AccountUsage {
  const buckets = new Map<string, UsageBucket>();
  for (const [key, w] of Object.entries(record.windows)) {
    const f = windowFor(key);
    const b = buckets.get(f.bucket) ?? { id: f.bucket, ...(f.bucketLabel ? { label: f.bucketLabel } : {}), windows: [] };
    b.windows.push({ ...f.window, usedPercent: w.usedPercent, resetsAt: w.resetsAt });
    buckets.set(f.bucket, b);
  }
  return {
    account: { harness: 'claude', scope: 'profile', key: profileKey, sourceKey: profileKey },
    buckets: [...buckets.values()], status: 'ok', source: 'claude statusline tap', checkedAt: checkedAt.toISOString(), observedAt: record.observedAt,
  };
}

export const CLAUDE_TAP_HINT = "Claude Code only shows plan usage to your statusline command; wrap it with `room statusline-tap` to show it here (README: Plan usage)";

export function claudeAccountUsageProvider(opts: { claudeConfigDir: string; tapDir?: string; now?: () => Date }): AccountUsageProvider {
  const key = claudeProfileKey(opts.claudeConfigDir);
  const path = claudeTapPath(opts.claudeConfigDir, opts.tapDir);
  const now = opts.now ?? (() => new Date());
  return {
    harness: 'claude',
    id: `claude:${key}`,
    async sample(): Promise<AccountUsage> {
      const at = now();
      const empty = (reason: string): AccountUsage => ({
        account: { harness: 'claude', scope: 'profile', key, sourceKey: key }, buckets: [], status: 'unavailable', reason,
        source: 'claude statusline tap', checkedAt: at.toISOString(), observedAt: null,
      });
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (e) {
        return empty((e as NodeJS.ErrnoException).code === 'ENOENT' ? CLAUDE_TAP_HINT : 'the statusline tap file could not be read');
      }
      try {
        const record = JSON.parse(text) as ClaudeTapRecord;
        if (record?.version !== 1 || typeof record.observedAt !== 'string' || !record.windows) return empty('the statusline tap file has an unknown format');
        return accountUsageFromTap(record, key, at);
      } catch {
        return empty('the statusline tap file is malformed');
      }
    },
  };
}
