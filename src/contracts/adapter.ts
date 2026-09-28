// Adapter contract: the only way the dispatcher touches a harness (invariants 1, 2, 8).
import type { ErrorInfo, Harness, MessageId, SubmitEvidence, TargetSnapshot, UnavailableReason } from './domain.js';

export interface SubmitRequest {
  target: TargetSnapshot;
  /** The fully rendered envelope text for this harness (already within the harness budget). */
  envelope: string;
  messageId: MessageId;
  recipient: string;
  /** 1-based attempt number (for logging/diagnostics only). */
  attempt: number;
}

/**
 * Outcome of one submission attempt. Adapters must be honest about *when* a failure happened:
 * - `unavailable`: nothing was attempted (recipient offline / binding stale); the delivery stays queued.
 * - `failed`: definitely not delivered (e.g. connect/auth failed before the message was written).
 * - `uncertain`: may have been delivered (e.g. error after the message was written); never auto-retried.
 * - `submitted`: the harness transport accepted it, with evidence of which kind.
 */
export type SubmitResult =
  | { status: 'submitted'; evidence: SubmitEvidence }
  | { status: 'unavailable'; reason: UnavailableReason; detail: string }
  | { status: 'failed'; error: ErrorInfo }
  | { status: 'uncertain'; error: ErrorInfo };

export interface LivenessProbe {
  liveness: 'online' | 'offline' | 'rebind_needed' | 'unknown';
  activity: 'idle' | 'busy' | 'waiting_permission' | 'unknown';
  detail?: string;
}

export interface DeliveryAdapter {
  readonly harness: Harness;
  /** Maximum envelope length (characters) this transport accepts; the core uses the reference fallback above it. */
  readonly maxEnvelopeChars: number;
  submit(request: SubmitRequest): Promise<SubmitResult>;
  /** Cheap, read-only liveness check. Must never message or modify the session. */
  probe(target: TargetSnapshot): Promise<LivenessProbe>;
}

export const SUBMIT_STATUSES = ['submitted', 'unavailable', 'failed', 'uncertain'] as const;

/** Runtime guard for results coming from adapters (defends the ledger from malformed adapter output). */
export function isSubmitResult(value: unknown): value is SubmitResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v['status']) {
    case 'submitted':
      return typeof v['evidence'] === 'object' && v['evidence'] !== null;
    case 'unavailable':
      return (v['reason'] === 'offline' || v['reason'] === 'rebind_needed') && typeof v['detail'] === 'string';
    case 'failed':
    case 'uncertain':
      return typeof v['error'] === 'object' && v['error'] !== null;
    default:
      return false;
  }
}
