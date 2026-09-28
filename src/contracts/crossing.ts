// M7 contract draft: no runtime behavior or IPC method changes until cross-reviewed.
import type { MessageWithDeliveries, RoomMessage } from './domain.js';
import type { Caller } from './ipc.js';

/** Opaque service-issued coverage evidence, bound to room + native sender binding.
 * Never proves comprehension. Never silently replaced with a newer shared token.
 * Short (at most 40 ASCII characters), backed by persisted server state. A send
 * does not consume it; it remains current unless new addressed content appears.
 */
export type InboxSnapshot = string;

/** Additive persisted display/audit metadata; absent on pre-M7 messages. */
export interface MessageCrossingInfo {
  attemptId: string;
  guard: 'current' | 'urgent' | 'human' | 'legacy';
  urgent: { reason: string } | null;
  newSinceSnapshot: number | null;
  revisesAttemptId: string | null;
}

/** Presentation only. This is not an implicit token for subsequent sends. */
export interface ParticipantInboxInfo {
  snapshot: InboxSnapshot;
  uncovered: number;
  checkedAt: string;
}

export interface InboxRequest {
  caller: Caller;
  /** Deliberately exempt existing history without reading it. Mutually exclusive
   * with snapshot/cursor. Never inferred from missing-token requests.
   */
  baseline?: { reason: string };
  snapshot?: InboxSnapshot;
  /** Server-issued continuation; bind to the supplied snapshot and native identity. */
  cursor?: string;
  /** Counts returned items, including parts; a separate server byte cap also applies. */
  limit?: number;
}

export type InboxReviewItem =
  | { kind: 'full_message'; value: MessageWithDeliveries }
  | {
      kind: 'message_part';
      /** Metadata is repeated for attribution; body lives only in text below. */
      message: Omit<RoomMessage, 'body'>;
      /** Digest of the immutable whole body, not a client-supplied read claim. */
      bodyDigest: string;
      text: string;
      /** One-based index. Every part is required before this message is covered. */
      partIndex: number;
      partCount: number;
    };

export interface InboxReviewPage {
  /** Explicit exemption, not evidence the omitted content was returned or read. */
  baseline?: { attemptId: string; exemptedCount: number; reason: string };
  /** Oldest first, only uncovered content. Cold start includes all retained
   * addressed messages whose delivery target matches this native binding,
   * regardless of transport state. No inferred read frontier from delivery/reply.
   * Rejoining the same binding does not reset that history.
   */
  items: InboxReviewItem[];
  /** Covers only content actually returned, cumulatively with supplied valid coverage.
   * An envelope token covers its own message, not every earlier native submission.
   */
  snapshot: InboxSnapshot;
  hasMore: boolean;
  /** Opaque continuation bound to this review; not a raw global room sequence. */
  nextCursor: string | null;
  /** Uncovered messages, not chunks; an incomplete message still counts as one. */
  remaining: number;
}

export interface GuardedSendOptions {
  snapshot?: InboxSnapshot;
  /** Required nonblank reason for urgent sends. Bypasses freshness only; respects
   * human pause. Priority applies only before native submission, with FIFO per lane.
   */
  urgent?: { reason: string };
  /** Explicit lineage for a revised send, not inferred from text or time. */
  revisesAttemptId?: string;
}

export interface GuardedSendRequest extends GuardedSendOptions {
  caller: Caller;
  to: string[] | null;
  body: string;
  replyTo?: string | null;
  /** Committed-send dedup is checked before freshness; retry after a lost response
   * returns the original send. Changing snapshot alone is not a body conflict.
   */
  clientMessageId?: string | null;
}

export interface WithdrawRequest {
  caller: Caller;
  messageId: string;
  /** Omitted means all original recipients, never the current registry. */
  recipients?: string[];
}

export type GuardedSendOutcome =
  | {
      status: 'sent';
      result: MessageWithDeliveries & { deduplicated: boolean };
      attemptId: string;
      guard: 'current' | 'urgent' | 'human';
      /** Null when no valid snapshot was supplied, rather than inventing a count. */
      newSinceSnapshot: number | null;
    }
  | {
      status: 'not_sent';
      reason: 'snapshot_required' | 'snapshot_stale' | 'snapshot_invalid';
      attemptId: string;
      inbox: InboxReviewPage;
      guidance: string;
    };

/** Each recipient is independent: a partly delivered broadcast is never described
 * as wholly withdrawn. Cancellation preserves message history and dedup identity.
 */
export type WithdrawDisposition =
  | 'withdrawn'
  | 'already_withdrawn'
  | 'already_submitting'
  | 'already_visible'
  | 'submitted'
  | 'uncertain'
  | 'replied';

export interface WithdrawOutcome {
  messageId: string;
  recipients: Array<{
    recipient: string;
    disposition: WithdrawDisposition;
  }>;
}
