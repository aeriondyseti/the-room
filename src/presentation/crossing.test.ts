import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GuardedSendOutcome, InboxReviewPage } from '../contracts/crossing.js';
import type { MessageWithDeliveries } from '../contracts/domain.js';
import { guardedSendText, inboxItemText, inboxPageText, withdrawText } from './crossing.js';

const msg = (seq: number): MessageWithDeliveries =>
  ({
    message: { id: `m${seq}`, seq, createdAt: '2026-09-28T10:00:00Z', from: { name: 'astra', kind: 'agent', identity: { mode: 'verified', source: 'codex-mcp-meta' } }, to: ['claude'], addressing: 'direct', replyTo: null, kind: 'chat', body: `body ${seq}`, clientMessageId: null },
    deliveries: [],
  }) as unknown as MessageWithDeliveries;

const page = (over: Partial<InboxReviewPage> = {}): InboxReviewPage => ({ items: [{ kind: 'full_message', value: msg(7) }], snapshot: 'snap-1', hasMore: false, nextCursor: null, remaining: 0, ...over });

const sent = (over: Partial<Extract<GuardedSendOutcome, { status: 'sent' }>>): GuardedSendOutcome => ({
  status: 'sent',
  result: { ...msg(9), deduplicated: false },
  attemptId: 'att-1',
  guard: 'current',
  newSinceSnapshot: 0,
  ...over,
});

test('inbox page lists uncovered messages with ids and the snapshot', () => {
  const t = inboxPageText(page());
  assert.match(t, /not covered yet \(1 item\(s\), oldest first\)/);
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
  assert.match(t, /roundtable_inbox cursor=cur-2 snapshot=snap-1/);
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
  assert.match(t, /finish reading with roundtable_inbox/);
  assert.match(t, /revises_attempt_id=att-5/);
  assert.doesNotMatch(t, /send again with snapshot=/);
});

test('CLI surface: every hint names a shell command, never an MCP call', () => {
  const t = guardedSendText({ status: 'not_sent', reason: 'snapshot_stale', attemptId: 'att-6', inbox: page({ snapshot: 's2' }), guidance: '' }, 'cli');
  assert.match(t, /send again with --snapshot s2 --revises att-6/);
  const more = inboxPageText(page({ hasMore: true, nextCursor: 'c9', remaining: 1 }), 'cli');
  assert.match(more, /roundtable inbox --cursor c9 --snapshot snap-1/);
  const urgent = guardedSendText(sent({ guard: 'urgent', newSinceSnapshot: 1 }), 'cli');
  for (const text of [t, more, urgent]) assert.doesNotMatch(text, /roundtable_inbox|revises_attempt_id|cursor=/);
});

test('withdraw: a full withdraw says so', () => {
  const t = withdrawText({ messageId: 'm9', recipients: [{ recipient: 'astra', disposition: 'withdrawn' }, { recipient: 'bob', disposition: 'already_withdrawn' }] }, 9);
  assert.match(t, /^Withdrew #9 for every recipient \(1 already withdrawn earlier\)\./);
});

test('withdraw: a partial broadcast is never shown as wholly withdrawn', () => {
  const t = withdrawText({ messageId: 'm9', recipients: [{ recipient: 'astra', disposition: 'withdrawn' }, { recipient: 'bob', disposition: 'submitted' }] });
  assert.match(t, /^Withdrew m9 for 1 of 2 recipients only\./);
  assert.match(t, /- bob: NOT withdrawn: .*too late to recall/);
});

test('withdraw: nothing cancelled, including the human and in-flight cases', () => {
  const t = withdrawText({ messageId: 'm9', recipients: [{ recipient: 'human', disposition: 'already_visible' }, { recipient: 'astra', disposition: 'already_submitting' }, { recipient: 'bob', disposition: 'uncertain' }] });
  assert.match(t, /^Could not withdraw m9 for any remaining recipient\./);
  assert.match(t, /- human: NOT withdrawn: the human sees/);
  assert.match(t, /- astra: NOT withdrawn: delivery was already in progress/);
  assert.match(t, /- bob: NOT withdrawn: it may already have been delivered/);
});

test('withdraw: no recipients is stated, not called a success', () => {
  assert.match(withdrawText({ messageId: 'm9', recipients: [] }), /No recipients of m9 were affected/);
});

test('a message part is labelled and never presented as the whole message', () => {
  const { body: _body, ...meta } = msg(8).message;
  const part = (i: number) => inboxItemText({ kind: 'message_part', message: meta, bodyDigest: 'd', text: `chunk ${i}`, partIndex: i, partCount: 3 });
  assert.match(part(1), /#8 .*\nid: m8\n\[part 1\/3; the rest follows on the next page, and the message is not covered until every part is read\]\nchunk 1$/);
  assert.match(part(3), /\[part 3\/3; last part\]\nchunk 3$/);
});
test('withdraw: repeating a withdraw says nothing changed rather than "Withdrew"', () => {
  const t = withdrawText({ messageId: 'm9', recipients: [{ recipient: 'astra', disposition: 'already_withdrawn' }, { recipient: 'bob', disposition: 'already_withdrawn' }] }, 9);
  assert.match(t, /^#9 was already withdrawn for every recipient; nothing changed\./);
  assert.doesNotMatch(t, /^Withdrew/);
});

test('withdraw: a fresh full withdraw has no "earlier" note', () => {
  assert.match(withdrawText({ messageId: 'm9', recipients: [{ recipient: 'astra', disposition: 'withdrawn' }] }), /^Withdrew m9 for every recipient\.$/m);
});
test('withdraw of selected recipients scopes every claim to them', () => {
  const t = withdrawText({ messageId: 'm', recipients: [{ recipient: 'a', disposition: 'withdrawn' }] }, 4, true);
  assert.match(t, /^Withdrew #4 for every requested recipient\./);
  assert.doesNotMatch(t, /for every recipient\./);
  assert.match(t, /Only the recipients you named were asked; the message's other recipients are unchanged\./);
  const again = withdrawText({ messageId: 'm', recipients: [{ recipient: 'a', disposition: 'already_withdrawn' }] }, 4, true);
  assert.match(again, /^#4 was already withdrawn for every requested recipient; nothing changed\./);
  const some = withdrawText({ messageId: 'm', recipients: [{ recipient: 'a', disposition: 'withdrawn' }, { recipient: 'b', disposition: 'submitted' }] }, 4, true);
  assert.match(some, /^Withdrew #4 for 1 of 2 requested recipients only\./);
});