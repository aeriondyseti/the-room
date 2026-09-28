// M7 contract draft: no runtime behavior or IPC method changes until cross-reviewed.
import type { MessageWithDeliveries } from './domain.js';

/** Opaque service-issued coverage evidence, bound to room + native sender binding.
 * Never proves comprehension. Never silently replaced with a newer shared token.
 */
export type InboxSnapshot = string;

export interface InboxReviewPage {
  items: MessageWithDeliveries[];
  /** Covers only content actually returned, cumulatively with supplied valid coverage.
   * An envelope token covers its own message, not every earlier native submission.
   */
  snapshot: InboxSnapshot;
  hasMore: boolean;
  /** Opaque continuation bound to this review; not a raw global room sequence. */
  nextCursor: string | null;
  /** New addressed items still not covered by this snapshot. */
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
