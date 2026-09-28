// Model-facing text for the crossing guard, urgent sends and withdraw (M7, docs/CROSSING-GUARD-SPEC.md §7).
// Pure formatting over the contract shapes; MCP and CLI share it so both surfaces say the same thing.
import type { GuardedSendOutcome, InboxReviewItem, InboxReviewPage, WithdrawDisposition, WithdrawOutcome } from '../contracts/crossing.js';
import type { MessageWithDeliveries } from '../contracts/domain.js';
import { deliveryDetail } from './delivery.js';

/** One or more messages, oldest first, with their delivery states. `full` adds each message id. */
export function formatMessages(items: MessageWithDeliveries[], full: boolean): string {
  return items
    .map(({ message: m, deliveries }) => {
      const head = `#${m.seq} ${m.createdAt} ${m.from.name}${m.from.identity.mode === 'declared' ? ' (declared)' : ''} → ${m.addressing === 'broadcast' ? 'all' : m.to.join(', ')}${m.replyTo ? ` (reply to ${m.replyTo})` : ''}${m.kind === 'stop_request' ? ' [STOP REQUEST]' : ''}${full ? `\nid: ${m.id}` : ''}`;
      return `${head}\n${m.body}${deliveries.length ? '\nDelivery: ' + deliveries.map((d) => `${d.recipient} ${deliveryDetail(d)}`).join('; ') : ''}`;
    })
    .join('\n\n');
}

/** One inbox item: a whole message, or one server-sized part of an oversized one. */
export function inboxItemText(item: InboxReviewItem): string {
  if (item.kind === 'full_message') return formatMessages([item.value], true);
  const m = item.message;
  const head = `#${m.seq} ${m.createdAt} ${m.from.name}${m.from.identity.mode === 'declared' ? ' (declared)' : ''} → ${m.addressing === 'broadcast' ? 'all' : m.to.join(', ')}${m.replyTo ? ` (reply to ${m.replyTo})` : ''}\nid: ${m.id}`;
  const note =
    item.partIndex === item.partCount
      ? `[part ${item.partIndex}/${item.partCount}; last part]`
      : `[part ${item.partIndex}/${item.partCount}; the rest follows on the next page, and the message is not covered until every part is read]`;
  return `${head}\n${note}\n${item.text}`;
}

/** The line a full-body native envelope carries; its token covers that one message and nothing else. */
export function envelopeSnapshotLine(token: string): string {
  return `snapshot: ${token} (covers this message only; pass it as snapshot when you reply)`;
}

/** An inbox review page, with the exact call that continues it when it is incomplete. */
export function inboxPageText(page: InboxReviewPage): string {
  const lines: string[] = [];
  lines.push(
    page.items.length === 0
      ? 'Nothing addressed to you is outside this snapshot.'
      : `Addressed to you and not covered by your previous snapshot (${page.items.length} item(s), oldest first):`,
  );
  if (page.items.length) lines.push('', page.items.map(inboxItemText).join('\n\n'), '');
  lines.push(`snapshot: ${page.snapshot}`);
  if (page.hasMore) {
    lines.push(
      `Incomplete: ${page.remaining} more not covered yet. Continue with room_inbox cursor=${page.nextCursor ?? '(none)'} snapshot=${page.snapshot} ` +
        'before sending; only a snapshot that covers everything lets a send through.',
    );
  }
  return lines.join('\n');
}

const NOT_SENT_HEAD: Record<Extract<GuardedSendOutcome, { status: 'not_sent' }>['reason'], string> = {
  snapshot_required: 'NOT SENT: no snapshot was given. Nothing was queued.',
  snapshot_stale: 'NOT SENT: messages addressed to you arrived that your snapshot does not cover. Nothing was queued.',
  snapshot_invalid: 'NOT SENT: that snapshot is not valid for you here (another session or room, or malformed). Nothing was queued.',
};

/**
 * The crossing-guard part of a send result. For `sent` it adds only what the guard knows (the base send summary
 * stays with the caller); for `not_sent` it is the whole answer: what arrived, the fresh snapshot, and what to do.
 */
export function guardedSendText(outcome: GuardedSendOutcome): string {
  if (outcome.status === 'sent') {
    if (outcome.guard !== 'urgent') return '';
    const over =
      outcome.newSinceSnapshot === null
        ? 'an unknown number of messages (no valid snapshot was given)'
        : `${outcome.newSinceSnapshot} message(s) not covered by your snapshot`;
    return `Sent URGENT over ${over}. Read your inbox (room_inbox) before your next ordinary send.`;
  }
  const lines = [NOT_SENT_HEAD[outcome.reason]];
  if (outcome.guidance.trim()) lines.push(outcome.guidance.trim());
  lines.push('', inboxPageText(outcome.inbox), '');
  lines.push(
    outcome.inbox.hasMore
      ? `Next: finish reading with room_inbox, then send again with the final snapshot and revises_attempt_id=${outcome.attemptId}.`
      : `Next: revise your message in light of the above if needed, then send again with snapshot=${outcome.inbox.snapshot} revises_attempt_id=${outcome.attemptId}.`,
  );
  return lines.join('\n');
}

const DISPOSITION: Record<WithdrawDisposition, string> = {
  withdrawn: 'withdrawn (never handed to their session)',
  already_withdrawn: 'already withdrawn',
  already_submitting: 'NOT withdrawn: delivery was already in progress (it may still arrive or fail)',
  already_visible: 'NOT withdrawn: the human sees messages as soon as they are sent',
  submitted: 'NOT withdrawn: their session already accepted it; it is too late to recall',
  uncertain: 'NOT withdrawn: it may already have been delivered',
  replied: 'NOT withdrawn: they already replied',
};

const CANCELLED: ReadonlySet<WithdrawDisposition> = new Set(['withdrawn', 'already_withdrawn']);

/** Per-recipient withdraw results, with a headline that never overstates a partial withdraw. */
export function withdrawText(outcome: WithdrawOutcome, seq?: number): string {
  const ref = seq === undefined ? outcome.messageId : `#${seq}`;
  const done = outcome.recipients.filter((r) => CANCELLED.has(r.disposition)).length;
  const total = outcome.recipients.length;
  const head =
    total === 0
      ? `No recipients of ${ref} were affected.`
      : done === total
        ? `Withdrew ${ref} for every recipient.`
        : done === 0
          ? `Could not withdraw ${ref} for any recipient.`
          : `Withdrew ${ref} for ${done} of ${total} recipients only.`;
  return [head, ...outcome.recipients.map((r) => `- ${r.recipient}: ${DISPOSITION[r.disposition]}`)].join('\n');
}
