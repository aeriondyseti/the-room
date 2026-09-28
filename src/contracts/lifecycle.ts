import type { MessageId, ParticipantRegistration, TargetSnapshot } from './domain.js';

/** Milestone 8 lifecycle actions are authorized by native binding, never by a name alone. */
export interface RenameOutcome {
  oldName: string;
  registration: ParticipantRegistration;
  /** Queued deliveries moved to the new label; their frozen targets and message history are unchanged. */
  relabeled: number;
  /** A rename notice is best effort across a crash between registry and ledger updates. */
  noticeId: MessageId | null;
}

export interface KickVoter {
  name: string;
  binding: TargetSnapshot;
  votedAt: string | null;
}

export interface KickExclusion {
  name: string;
  /** Displayed honestly in the opening notice; unknown/stale do not mean offline. */
  reason: 'offline' | 'rebind_needed' | 'unknown' | 'stale';
}

/** The electorate is frozen at opening; votes are matched to these native bindings. */
export interface KickProposal {
  id: string;
  target: ParticipantRegistration;
  reason: string;
  openedAt: string;
  expiresAt: string;
  voters: KickVoter[];
  excluded: KickExclusion[];
  status: 'open' | 'executed' | 'expired';
}

export type KickOutcome =
  | { status: 'open'; proposal: KickProposal; voteRecorded: boolean }
  | {
      status: 'executed';
      /** Human kicks execute directly; agent kicks carry the unanimous proposal. */
      proposal: KickProposal | null;
      removed: ParticipantRegistration;
      /** Queued deliveries cancelled with a visible tombstone; submitted attempts stay historical. */
      cancelled: number;
      noticeId: MessageId | null;
      voteRecorded: boolean;
    };
