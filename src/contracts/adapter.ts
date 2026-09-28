// Adapter contract: the only way the dispatcher touches a harness (invariants 1, 2, 8).
import type {
  Activity,
  RuntimeContext,
  ErrorInfo,
  Harness,
  Liveness,
  MessageId,
  SubmitEvidence,
  TargetSnapshot,
  UnavailableReason,
} from './domain.js';

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
  liveness: Liveness;
  activity: Activity;
  detail?: string;
}

export interface DeliveryAdapter {
  readonly harness: Harness;
  /** Stable native configuration copied into SQLite before attempting submission. */
  readonly runtimeContext?: RuntimeContext;
  /** Maximum envelope length (characters) this transport accepts; the core uses the reference fallback above it. */
  readonly maxEnvelopeChars: number;
  submit(request: SubmitRequest): Promise<SubmitResult>;
  /** Cheap, read-only liveness check. Must never message or modify the session. */
  probe(target: TargetSnapshot): Promise<LivenessProbe>;
}

export const SUBMIT_STATUSES = ['submitted', 'unavailable', 'failed', 'uncertain'] as const;

/** Runtime guard for results coming from adapters (defends the ledger from malformed adapter output). */
export function isSubmitResult(value: unknown): value is SubmitResult {
  if (!isRecord(value)) return false;
  switch (value['status']) {
    case 'submitted':
      return isSubmitEvidence(value['evidence']);
    case 'unavailable':
      return (value['reason'] === 'offline' || value['reason'] === 'rebind_needed') && typeof value['detail'] === 'string';
    case 'failed':
    case 'uncertain':
      return isErrorInfo(value['error']);
    default:
      return false;
  }
}

export function isSubmitEvidence(value: unknown): value is SubmitEvidence {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'codex-queue') return value['nativeId'] === null || typeof value['nativeId'] === 'string';
  if (value['kind'] === 'claude-pipe-write') return Number.isInteger(value['pid']) && (value['pid'] as number) > 0;
  return false;
}

export function isErrorInfo(value: unknown): value is ErrorInfo {
  return (
    isRecord(value) &&
    typeof value['code'] === 'string' &&
    value['code'] !== '' &&
    typeof value['message'] === 'string' &&
    (value['hint'] === undefined || typeof value['hint'] === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
