import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GuardedSendOutcome, InboxReviewPage } from '../contracts/crossing.js';
import type { MessageWithDeliveries } from '../contracts/domain.js';
import { envelopeSnapshotLine, guardedSendText, inboxPageText, withdrawText } from './crossing.js';

const msg = (seq: number): MessageWithDeliveries =>
  ({
    message: { id: `m${seq}`, seq, createdAt: '2026-09-28T10:00:00Z', from: { name: 'astra', kind: 'agent', identity: { mode: 'verified', source: 'codex-mcp-meta' } }, to: ['claude'], addressing: 'direct', replyTo: null, kind: 'chat', body: `body ${seq}`, clientMessageId: null },
    deliveries: [],
  }) as unknown as MessageWithDeliveries;

const page = (over: Partial<InboxReviewPage> = {}): InboxReviewPage => ({ items: [msg(7)], snapshot: 'snap-1', hasMore: false, nextCursor: null, remaining: 0, ...over });

const sent = (over: Partial<Extract<GuardedSendOutcome, { status: 'sent' }>>): GuardedSendOutcome => ({
  status: 'sent',
  result: { ...msg(9), deduplicated: false },
  attemptId: 'att-1',
  guard: 'current',
  newSinceSnapshot: 0,
  ...over,
});

test('envelope line carries the token and says it covers only that message', () => {
  const line = envelopeSnapshotLine('tok-xyz');
  assert.match(line, /tok-xyz/);
  assert.match(line, /this message only/);
});

test('inbox page lists uncovered messages with ids and the snapshot', () => {
  const t = inboxPageText(page());
  assert.match(t, /1 message\(s\) addressed to you not covered/);
  assert.match(t, /#7 .*astra → claude/);
  assert.match(t, /id: m7/);
  assert.match(t, /snapshot: snap-1/);
  assert.doesNotMatch(t, /Incomplete/);
});

test('an empty inbox page still hands out a snapshot', () => {
  const t = inboxPageText(page({ items: [] }));
  assert.match(t, /Nothing addressed to you is outside this snapshot/);
  assert.match(t, /snapshot: snap-1/);
});

test('an incomplete page gives the exact continuation and never implies coverage', () => {
  const t = inboxPageText(page({ hasMore: true, nextCursor: 'cur-2', remaining: 3 }));
  assert.match(t, /Incomplete: 3 more not covered yet/);
  assert.match(t, /room_inbox cursor=cur-2 snapshot=snap-1/);
});

test('an ordinary or human send adds no guard text', () => {
  assert.equal(guardedSendText(sent({})), '');
  assert.equal(guardedSendText(sent({ guard: 'human' })), '');
});

test('urgent send reports what it went over, and unknown rather than a made-up count', () => {
  assert.match(guardedSendText(sent({ guard: 'urgent', newSinceSnapshot: 2 })), /URGENT over 2 message\(s\) not covered/);
  const unknown = guardedSendText(sent({ guard: 'urgent', newSinceSnapshot: null }));
  assert.match(unknown, /unknown number/);
  assert.doesNotMatch(unknown, /\b0 message/);
});

test('not sent: states nothing was queued, shows the delta and the retry with lineage', () => {
  const t = guardedSendText({ status: 'not_sent', reason: 'snapshot_stale', attemptId: 'att-4', inbox: page({ snapshot: 'snap-2' }), guidance: 'Revise and retry.' });
  assert.match(t, /^NOT SENT: .*Nothing was queued\./);
  assert.match(t, /Revise and retry\./);
  assert.match(t, /#7 /);
  assert.match(t, /send again with snapshot=snap-2 revises_attempt_id=att-4/);
});

test('not sent: each reason has its own headline; blank guidance is omitted', () => {
  const heads = (['snapshot_required', 'snapshot_stale', 'snapshot_invalid'] as const).map(
    (reason) => guardedSendText({ status: 'not_sent', reason, attemptId: 'a', inbox: page(), guidance: '  ' }).split('\n'),
  );
  assert.equal(new Set(heads.map((l) => l[0])).size, 3);
  for (const lines of heads) assert.equal(lines[1], '');
});

test('not sent with an incomplete inbox asks to finish reading before resending', () => {
  const t = guardedSendText({ status: 'not_sent', reason: 'snapshot_required', attemptId: 'att-5', inbox: page({ hasMore: true, nextCursor: 'c', remaining: 9 }), guidance: '' });
  assert.match(t, /finish reading with room_inbox/);
  assert.match(t, /revises_attempt_id=att-5/);
  assert.doesNotMatch(t, /send again with snapshot=/);
});

test('withdraw: a full withdraw says so', () => {
  const t = withdrawText({ messageId: 'm9', recipients: [{ recipient: 'astra', disposition: 'withdrawn' }, { recipient: 'bob', disposition: 'already_withdrawn' }] }, 9);
  assert.match(t, /^Withdrew #9 for every recipient\./);
});

test('withdraw: a partial broadcast is never shown as wholly withdrawn', () => {
  const t = withdrawText({ messageId: 'm9', recipients: [{ recipient: 'astra', disposition: 'withdrawn' }, { recipient: 'bob', disposition: 'submitted' }] });
  assert.match(t, /^Withdrew m9 for 1 of 2 recipients only\./);
  assert.match(t, /- bob: NOT withdrawn: .*too late to recall/);
});

test('withdraw: nothing cancelled, including the human and in-flight cases', () => {
  const t = withdrawText({ messageId: 'm9', recipients: [{ recipient: 'human', disposition: 'already_visible' }, { recipient: 'astra', disposition: 'already_submitting' }, { recipient: 'bob', disposition: 'uncertain' }] });
  assert.match(t, /^Could not withdraw m9 for any recipient\./);
  assert.match(t, /- human: NOT withdrawn: the human sees/);
  assert.match(t, /- astra: NOT withdrawn: delivery was already in progress/);
  assert.match(t, /- bob: NOT withdrawn: it may already have been delivered/);
});

test('withdraw: no recipients is stated, not called a success', () => {
  assert.match(withdrawText({ messageId: 'm9', recipients: [] }), /No recipients of m9 were affected/);
});
