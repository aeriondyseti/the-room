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
  /** Provider bucket id (e.g. Codex `codex`); several buckets are shown separately, never added up. */
  id: string;
  label?: string;
  windows: UsageWindow[];
}

export interface AccountUsage {
  account: {
    harness: Harness;
    /** Opaque, stable, non-reversible key (hash of the provider account id, or of the config home). Never shown. */
    key: string;
  };
  /** Plan name when the provider reports one (e.g. "pro"). */
  plan?: string | null;
  buckets: UsageBucket[];
  /** Provider's own "ordinary usage allowed" flag, kept independent of the percentages; null/absent = unknown. */
  ordinaryUsageAllowed?: boolean | null;
  status: 'ok' | 'stale' | 'unavailable';
  /** Why the reading is stale/unavailable (shown verbatim, sanitized). */
  reason?: string;
  /** Where it came from (e.g. "codex app-server account/rateLimits/read"). */
  source: string;
  /** When we asked, and when the provider's data was observed (may differ for cached sources). */
  fetchedAt: string | null;
  observedAt: string | null;
}

/**
 * A read-only source of account usage for one harness. Implementations must never read credentials or auth files,
 * never start or configure a harness, and never throw: failures come back as `status: 'unavailable'` with a reason.
 */
export interface AccountUsageProvider {
  harness: Harness;
  read(): Promise<AccountUsage>;
}
