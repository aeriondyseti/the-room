import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KickOutcome, KickProposal, RenameOutcome } from '../contracts/lifecycle.js';
import { kickText, renameText } from './lifecycle.js';

const reg = (name: string) => ({ name, harness: 'codex' as const, sessionId: '00000000-0000-4000-8000-000000000001' });
const rename = (over: Partial<RenameOutcome> = {}): RenameOutcome => ({ oldName: 'claude', registration: reg('fable'), relabeled: 2, noticeId: 'm-n', ...over });
const proposal = (over: Partial<KickProposal> = {}): KickProposal => ({
  id: 'k1', target: reg('astra2'), reason: 'thread is gone', openedAt: '2026-09-28T22:00:00Z', expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
  voters: [{ name: 'fable', binding: { harness: 'claude', sessionId: 'x' }, votedAt: '2026-09-28T22:00:00Z' }, { name: 'astra', binding: { harness: 'codex', sessionId: 'y' }, votedAt: null }],
  excluded: [{ name: 'opus', reason: 'unknown' }], status: 'open', ...over,
});

test('a self-rename tells the agent its new name and that it got no notice', () => {
  const t = renameText(rename(), true);
  assert.match(t, /You are now "fable" \(was "claude"; same session\)/);
  assert.match(t, /2 queued deliveries relabelled to the new name \(same session; nothing was resent\)/);
  assert.match(t, /you were not sent one, so your snapshot stays current/);
});

test('a human rename names both and says the renamed agent was told', () => {
  const t = renameText(rename({ relabeled: 0, noticeId: 'm-n' }), false);
  assert.match(t, /^Renamed "claude" to "fable"/);
  assert.match(t, /No queued deliveries needed relabelling/);
  assert.match(t, /the renamed one included/);
  assert.match(renameText(rename({ noticeId: null }), false), /No room notice was posted/);
});

test('an open proposal shows the vote disposition, the frozen roster, exclusions and the expiry', () => {
  const t = kickText({ status: 'open', proposal: proposal(), vote: 'recorded' });
  assert.match(t, /^Your vote to remove "astra2" is recorded\./);
  assert.match(t, /Voters \(fixed when it opened\): fable, astra\./);
  assert.match(t, /Voted: fable\. Still needed: astra\./);
  assert.match(t, /Not voting \(not qualified when it opened, not presumed offline\): opus \(unknown\)/);
  assert.match(t, /executes when every remaining voter calls room_kick for "astra2"; otherwise it expires in about 9 minutes/);
  assert.match(kickText({ status: 'open', proposal: proposal(), vote: 'recorded' }, 'cli'), /calls room kick for/);
});

test('non-counting votes say nothing changed, honestly', () => {
  assert.match(kickText({ status: 'open', proposal: proposal(), vote: 'already_recorded' }), /already recorded; nothing changed/);
  assert.match(kickText({ status: 'open', proposal: proposal(), vote: 'not_a_voter' }), /not a voter on this proposal .* nothing changed/);
  assert.match(kickText({ status: 'open', proposal: proposal(), vote: 'target' }), /You are the target .* no vote/);
});

test('an executed removal states who, why, what was cancelled, and that the session is untouched', () => {
  const byConsent: KickOutcome = { status: 'executed', proposal: proposal({ status: 'executed' }), removed: reg('astra2'), cancelled: 6, noticeId: 'm-n', vote: 'recorded' };
  const t = kickText(byConsent);
  assert.match(t, /^Removed "astra2" from the room \(by unanimous consent\)\./);
  assert.match(t, /Reason: thread is gone\. Voters: fable, astra\./);
  assert.match(t, /6 queued deliveries to it cancelled with a "kicked" tombstone \(nothing redirected\)/);
  assert.match(t, /Its session was not touched; it can rejoin/);
  const byHuman: KickOutcome = { status: 'executed', proposal: null, removed: reg('astra2'), cancelled: 0, noticeId: null, vote: 'human' };
  const h = kickText(byHuman);
  assert.match(h, /\(by the human\)/);
  assert.match(h, /No queued deliveries had to be cancelled/);
  assert.match(h, /No room notice was posted/);
});
