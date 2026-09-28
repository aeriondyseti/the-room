// Domain contract: the shapes every module (core, adapters, IPC, CLI, MCP, TUI) agrees on.
// Changes here are coordinated between agents (CLAUDE.md "Contracts are shared").

export const HARNESSES = ['claude', 'codex'] as const;
export type Harness = (typeof HARNESSES)[number];

export function isHarness(value: unknown): value is Harness {
  return typeof value === 'string' && (HARNESSES as readonly string[]).includes(value);
}

/** Reserved participant name for the human directing the room. Agents address it as `@human`. */
export const HUMAN = 'human';
/** Reserved sender name for messages the service itself authors (e.g. recovery notices). */
export const SYSTEM = 'system';
export const RESERVED_NAMES: readonly string[] = [HUMAN, SYSTEM, 'all'];

/** Participant names: lowercase, start with a letter, 1–32 chars of [a-z0-9_-]. */
const PARTICIPANT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

export function isValidParticipantName(name: string): boolean {
  return PARTICIPANT_NAME.test(name) && !RESERVED_NAMES.includes(name);
}

/** A room message id, assigned by the service. Opaque to clients; sortable by creation. */
export type MessageId = string;

/** Minimal registry entry, exactly as stored in `session.toml` (invariant 7). */
export interface ParticipantRegistration {
  name: string;
  harness: Harness;
  /** Claude sessionId or Codex thread id. */
  sessionId: string;
}

/** The native session a delivery was addressed to, frozen when the delivery is created (invariant 5). */
export interface TargetSnapshot {
  harness: Harness;
  sessionId: string;
}

/** How a caller's identity was established. */
export type IdentitySource =
  | 'codex-mcp-meta' // MCP call params._meta.threadId (Codex)
  | 'claude-mcp-registry' // MCP server's parent pid -> ~/.claude/sessions (Claude)
  | 'codex-env' // CLI: CODEX_THREAD_ID
  | 'claude-ancestry' // CLI: ancestor process -> ~/.claude/sessions
  | 'declared' // explicit --as fallback when detection is unavailable
  | 'tui' // the human's TUI
  | 'service'; // service-authored messages

export interface IdentityEvidence {
  /** `verified` = native identity matched the registry; `declared` = name accepted without native proof. */
  mode: 'verified' | 'declared' | 'human' | 'system';
  source: IdentitySource;
}

export type SenderKind = 'human' | 'agent' | 'system';

export interface Sender {
  name: string;
  kind: SenderKind;
  identity: IdentityEvidence;
}

export type MessageKind =
  | 'chat'
  /** The single stop request created by /pause; exempt from the hold it creates. */
  | 'stop_request'
  /** Service-authored notices (never delivered as directives). */
  | 'system';

export interface RoomMessage {
  id: MessageId;
  /** Monotonic room sequence number; clients page and resume by it. */
  seq: number;
  /** ISO-8601 creation time. */
  createdAt: string;
  from: Sender;
  /** Resolved recipient names, snapshotted at send time (never rewritten later). */
  to: string[];
  /** Whether the sender addressed everyone (`all` / default human broadcast) or named recipients. */
  addressing: 'broadcast' | 'direct';
  replyTo: MessageId | null;
  kind: MessageKind;
  body: string;
  /** Caller-supplied idempotency key (scoped to room + sender), if any. */
  clientMessageId: string | null;
}

/**
 * Per-recipient delivery lifecycle (proposal "Delivery states"):
 * queued -> submitted -> replied, with failed / uncertain outcomes. `held` is independent.
 */
export const DELIVERY_STATES = ['queued', 'submitted', 'replied', 'failed', 'uncertain'] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

/** States from which the dispatcher will not act again without an explicit human retry. */
export function isSettledDeliveryState(state: DeliveryState): boolean {
  return state === 'submitted' || state === 'replied' || state === 'failed' || state === 'uncertain';
}

/** Evidence recorded when an adapter reports submission. Never includes secrets (invariant 6). */
export type SubmitEvidence =
  | { kind: 'codex-queue'; nativeId: string | null }
  | { kind: 'claude-pipe-write'; pid: number };

/** Why a recipient could not be attempted right now; the delivery stays queued (not an attempt failure). */
export type UnavailableReason = 'offline' | 'rebind_needed';

export interface ErrorInfo {
  code: string;
  message: string;
  /** What the reader should do next (agents and humans both read these). */
  hint?: string;
}

/** Allowlisted native context for reconciliation; never includes credentials or environment dumps. */
export interface RuntimeContext {
  harness: 'codex';
  executable: string | null;
  home: string;
}

export interface DeliveryAttempt {
  runtimeContext?: RuntimeContext;
  /** 1-based attempt number; attempts are never overwritten (history is retained). */
  n: number;
  startedAt: string;
  finishedAt: string | null;
  outcome: 'submitted' | 'failed' | 'uncertain' | 'in_flight';
  evidence: SubmitEvidence | null;
  error: ErrorInfo | null;
}

export interface Delivery {
  messageId: MessageId;
  recipient: string;
  target: TargetSnapshot;
  state: DeliveryState;
  held: boolean;
  /** Set while the recipient is unreachable and the delivery waits (state stays `queued`). */
  waiting: UnavailableReason | null;
  /** When `replied`, the message that replied. */
  repliedBy: MessageId | null;
  /** Set when the room couldn't fit the full body in this harness's envelope and sent a reference. */
  referenced: boolean;
  attempts: DeliveryAttempt[];
  updatedAt: string;
}

export type Liveness = 'online' | 'offline' | 'rebind_needed' | 'unknown';
export type Activity = 'idle' | 'busy' | 'waiting_permission' | 'unknown';

export interface UsageSnapshot {
  source: 'claude-transcript' | 'codex-token-count';
  status: 'ok' | 'stale' | 'unavailable';
  /** When the underlying record was observed (null when unavailable). */
  observedAt: string | null;
  /** Cumulative token counters, when the source reports them. Never inferred. */
  cumulative: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  /** Current context occupancy, only when the source supports it; percent only with a known limit. */
  context: { usedTokens: number; limitTokens: number | null; percent: number | null } | null;
  reason?: string;
}

export interface ParticipantState extends ParticipantRegistration {
  liveness: Liveness;
  livenessCheckedAt: string | null;
  activity: Activity;
  /** Deliveries to this participant not yet settled (queued, including held/waiting). */
  pending: number;
  usage: UsageSnapshot | null;
}

export interface RoomState {
  paused: boolean;
  pausedAt: string | null;
  /** The stop request created by the most recent pause, if any. */
  stopRequestId: MessageId | null;
}

/** A message together with its per-recipient deliveries, as returned by send/read. */
export interface MessageWithDeliveries {
  message: RoomMessage;
  deliveries: Delivery[];
}
