// Subscription/plan usage per ACCOUNT (6.6, Kevin's weekly-usage idea). Budgets are shown once per account, never
// repeated or summed per agent. Shape agreed with Astra (room, 2026-09-28): account-scoped buckets of windows;
// read-only sources only; the account id is hashed in the service and never displayed.
import type { Harness } from './domain.js';

export interface UsageWindow {
  /** Provider's slot name (Codex: 'primary' | 'secondary'); display order only, never implies a duration. */
  kind: string;
  /** Explicit window length from the provider (e.g. 300 = 5h, 10080 = weekly); null when not reported. */
  durationMinutes: number | null;
  /** 0–100 as reported; null when unknown (shown "n/a", never 0). */
  usedPercent: number | null;
  /** When this window resets (ISO); null when not reported. */
  resetsAt: string | null;
}

export interface UsageBucket {
  /**
   * Provider bucket id (e.g. Codex `codex`); several buckets are shown separately, never added up. A provider's
   * single "mirror" of one keyed bucket is deduplicated by the provider, never counted twice.
   */
  id: string;
  label?: string;
  windows: UsageWindow[];
}

export interface AccountUsage {
  account: {
    harness: Harness;
    /**
     * 'account' when the provider reported an account id (key = hash of harness + that id); 'profile' when only the
     * configured home/profile is known (a profile is not proof of account identity, so it's labelled as such).
     */
    scope: 'account' | 'profile';
    /** Opaque, stable, non-reversible key. Never shown. */
    key: string;
    /** Non-sensitive key for the source/profile (hash of harness + config home), for de-duplicating sources. */
    sourceKey: string;
  };
  /** Plan name when the provider reports one (e.g. "pro"). */
  plan?: string | null;
  buckets: UsageBucket[];
  /**
   * Provider's own "ordinary usage allowed" flag, kept independent of the percentages; null/absent = unknown. Never
   * infer permission or recovery from percentages or reset times.
   */
  ordinaryUsageAllowed?: boolean | null;
  /**
   * ok = fresh reading; stale = the latest attempt failed (or aged out) and these are the last good values;
   * unavailable = no reading has ever succeeded (or the source isn't supported) — values are empty, never zero.
   */
  status: 'ok' | 'stale' | 'unavailable';
  /** Why the reading is stale/unavailable (shown verbatim, sanitized). */
  reason?: string;
  /** Where it came from (e.g. "codex app-server account/rateLimits/read"). */
  source: string;
  /** Last attempt, and last successful snapshot (they differ when the latest attempt failed). */
  checkedAt: string | null;
  observedAt: string | null;
}

/**
 * A read-only source of account usage for one harness. Implementations must never read credentials or auth files,
 * never start or configure a harness, and never throw: a failed sample returns `status: 'unavailable'` with a
 * reason. The service's AccountMonitor turns a failure after an earlier success into `stale` (keeping the last good
 * values), and bounds how often each source is sampled (never per participant or per render).
 */
export interface AccountUsageProvider {
  harness: Harness;
  /** Stable id for this source (e.g. 'codex:<sourceKey>'); one entry per source in the monitor. */
  id: string;
  sample(): Promise<AccountUsage>;
}
