// Activity observation contract (task 6.1): each agent's tool calls, results and messages, read-only from its
// transcript. Presentation data only: nothing here may feed delivery, identity, liveness or bindings.
// Shape agreed with Astra (room, 2026-09-28): binding-scoped streams, bounded retained window, honest coverage.
import type { Harness } from './domain.js';

export type ActivityKind = 'tool_call' | 'tool_result' | 'message' | 'turn_start' | 'turn_end';

/**
 * One observed transcript source for one native binding. A new session id, a replaced/rotated file, or a new
 * source file for the same session gets a new `generation`, so cursors from an old stream are recognisably stale.
 */
export interface ActivityStreamId {
  participant: string;
  harness: Harness;
  sessionId: string;
  generation: number;
}

export interface ActivityItem {
  stream: ActivityStreamId;
  /** Monotonic within the stream (never reused, even across restarts: persisted with the byte cursor). */
  seq: number;
  /** The record's own timestamp; null when the record has none (never fabricated). */
  at: string | null;
  kind: ActivityKind;
  turnId?: string;
  /** Only for `message`; hidden reasoning is never exposed as message content. */
  role?: 'user' | 'assistant' | 'system';
  /** Tool name for tool_call/tool_result (MCP tools as `server.tool`). */
  tool?: string;
  /** Pairs a tool_result with its tool_call. */
  callId?: string;
  isError?: boolean;
  /** One line, terminal-sanitized, ≤ ACTIVITY_SUMMARY_COLS columns. */
  summary: string;
  /** Bounded body (arguments / output), terminal-sanitized and with known sensitive fields redacted. */
  detail?: string;
  /** True when `detail` was cut to the configured cap (always labelled in the UI). */
  detailTruncated: boolean;
}

export type ActivityCoverage = 'full' | 'partial' | 'unavailable';

export interface ActivityPage {
  stream: ActivityStreamId | null;
  items: ActivityItem[];
  /** Oldest seq still retained for this stream (older items were evicted from the bounded window). */
  earliestSeq: number | null;
  lastSeq: number | null;
  /** More items exist in the requested direction within the retained window. */
  hasMore: boolean;
  /** True when the requested range reaches before `earliestSeq`: older history is unavailable, not empty. */
  olderEvicted: boolean;
  /** The caller's cursor belongs to an older stream (rebind/rotation): drop local state and re-read. */
  reset: boolean;
  coverage: ActivityCoverage;
  /** Why coverage isn't full (unreadable source, unknown format, N skipped/oversized records…). */
  reason?: string;
  /** When the source was last read, and whether unread bytes remain (so catching up isn't shown as complete). */
  checkedAt: string | null;
  backlog: boolean;
}

/** `activity` request: exactly one of afterSeq/beforeSeq (neither = the newest page). */
export interface ActivityRequest {
  participant: string;
  /** Stream the caller's cursor belongs to; a mismatch yields `reset: true`. */
  stream?: ActivityStreamId | null;
  afterSeq?: number | null;
  beforeSeq?: number | null;
  limit?: number;
}

export const ACTIVITY_SUMMARY_COLS = 200;

// ---- per-harness parsers (pure) ----------------------------------------------------------------------------

/** What a parser sees: one decoded JSON record plus where it came from (stable identity for dedup). */
export interface ActivityRecordInput {
  value: unknown;
  /** Byte offset of the record's line in the source file (identity within a generation). */
  offset: number;
}

/**
 * Parser verdict for one record:
 * - `items`: 0+ activity items (seq/stream are assigned by the reader, not the parser);
 * - `ignored`: a recognised record with nothing to show (housekeeping, token counts, reasoning) — not a failure;
 * - `unknown`: an unrecognised record type — counts toward `partial` coverage with a reason.
 */
export type ActivityParseResult =
  | { kind: 'items'; items: Array<Omit<ActivityItem, 'stream' | 'seq'>> }
  | { kind: 'ignored' }
  | { kind: 'unknown'; reason: string };

export interface ActivityParser {
  harness: Harness;
  parse(record: ActivityRecordInput, limits: { detailBytes: number }): ActivityParseResult;
}
