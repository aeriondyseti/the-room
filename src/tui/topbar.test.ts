import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountUsage } from '../contracts/account.js';
import type { ParticipantState } from '../contracts/domain.js';
import { lineCols, lineText } from './format.js';
import { accountLines, accountSegments, participantLines, resetHint } from './topbar.js';
import { PALETTE } from './bars.js';

const agent = (name: string, over: Partial<ParticipantState> = {}): ParticipantState => ({
  name, harness: 'codex', sessionId: name, liveness: 'online', livenessCheckedAt: null, activity: 'idle', pending: 0, usage: null, ...over,
});
const NOW = Date.parse('2026-09-28T10:00:00Z');
const acct = (over: Partial<AccountUsage> = {}): AccountUsage => ({
  account: { harness: 'claude', scope: 'profile', key: 'k', sourceKey: 'k' },
  buckets: [{ id: 'claude', windows: [
    { kind: 'five_hour', durationMinutes: 300, usedPercent: 38, resetsAt: '2026-09-28T12:12:00Z' },
    { kind: 'seven_day', durationMinutes: 10_080, usedPercent: 90, resetsAt: '2026-10-01T09:00:00Z' },
  ] }],
  status: 'ok', source: 's', checkedAt: null, observedAt: null, ...over,
});

test('participant chips wrap within the width, at most maxLines, with an honest "+N more"', () => {
  const many = ['astra', 'claude', 'fx_one', 'fx_two', 'fx_three', 'fx_four', 'fx_five'].map((n) => agent(n));
  const lines = participantLines(many, { width: 60, stale: false, mono: false, maxLines: 2 });
  assert.equal(lines.length, 2);
  for (const l of lines) assert.ok(lineCols(l) <= 60, lineText(l));
  const text = lines.map(lineText).join('\n');
  const shown = (text.match(/[●○◌⚠] /g) ?? []).length;
  const more = Number(/\+(\d+) more · \/who/.exec(text)?.[1]);
  assert.equal(shown + more, many.length, 'every participant is either shown or counted');
  assert.match(participantLines([], { width: 60, stale: false, mono: false, maxLines: 2 }).map(lineText).join(''), /No agents yet/);
  const stale = participantLines([agent('astra', { activity: 'busy' })], { width: 60, stale: true, mono: false, maxLines: 2 }).map(lineText).join('');
  assert.match(stale, /◌ astra last known: busy/, 'disconnected: greyed "last known", no liveness claim');
});

test('accounts show pinned 5h + weekly, other buckets as their own weekly, n/a never 0, and reset hints', () => {
  const a = acct({ buckets: [...acct().buckets, { id: 'claude-fable', label: 'Fable', windows: [{ kind: 'seven_day_fable', durationMinutes: 10_080, usedPercent: 22, resetsAt: null }] }] });
  const text = lineText(accountSegments(a, { mono: false, now: NOW }));
  assert.match(text, /^Claude {2}5h ▓▓▓▓░{6} 38\.0% ↻2h12m {2}weekly ▓{9}░ 90\.0%! ↻\w{3} \d\d:\d\d {2}Fable weekly ▓▓░{8} 22\.0%$/);
  const noShort = lineText(accountSegments(acct({ buckets: [{ id: 'codex', windows: [{ kind: 'primary', durationMinutes: 10_080, usedPercent: 16, resetsAt: null }] }], account: { harness: 'codex', scope: 'account', key: 'c', sourceKey: 'c' } }), { mono: false, now: NOW }));
  assert.match(noShort, /Codex {2}5h n\/a {2}weekly ▓▓░{8} 16\.0%/, 'a missing pinned window is n/a with no bar, never an empty 0% bar');
  const nullPct = lineText(accountSegments(acct({ buckets: [{ id: 'claude', windows: [{ kind: 'five_hour', durationMinutes: 300, usedPercent: null, resetsAt: null }] }] }), { mono: false, now: NOW }));
  assert.match(nullPct, /5h n\/a/);
});

test('stale readings keep values but are labelled; unavailable says why; monochrome marks high usage with "!"', () => {
  assert.match(lineText(accountSegments(acct({ status: 'stale', reason: 'daemon down' }), { mono: false, now: NOW })), /\(stale\)$/);
  const un = lineText(accountSegments(acct({ status: 'unavailable', reason: 'wrap your statusline', buckets: [] }), { mono: false, now: NOW }));
  assert.equal(un, 'Claude usage unavailable — wrap your statusline');
  const colour = accountSegments(acct(), { mono: false, now: NOW });
  const high = colour.find((s) => s.text === '90.0%!');
  assert.deepEqual([high?.color, high?.bold], [PALETTE.weekly, true], 'a high reading keeps its group colour and gains a bold \"!\"');
  assert.equal(colour.find((s) => s.text === '38.0%')?.color, PALETTE.fiveHour);
  assert.match(lineText(accountSegments(acct(), { mono: true, now: NOW })), /weekly ▓{9}░ 90\.0%!/);
});

test('disconnected → "(last known)" and no warning colour; a tap fallback is labelled; main bucket chosen by id, not position', () => {
  const dis = accountSegments(acct(), { mono: false, now: NOW, disconnected: true });
  assert.match(lineText(dis), /\(last known\)$/);
  const last = dis.find((s) => s.text.startsWith('90.0%'));
  assert.deepEqual([last?.text, last?.color, last?.dim], ['90.0%', undefined, true], 'last-known values: dim, no colour, no warning');
  assert.match(lineText(accountSegments(acct({ fallback: true }), { mono: false, now: NOW })), /\(via statusline, no model limits\)/);
  assert.match(lineText(accountSegments(acct({ source: 'shared ccstatusline cache (login unverified)' }), { mono: false, now: NOW })), /\(ccstatusline, login unverified\)/);
  const reordered = acct({ buckets: [{ id: 'claude-fable', label: 'Fable', windows: [{ kind: 'x', durationMinutes: 10_080, usedPercent: 5, resetsAt: null }] }, ...acct().buckets] });
  assert.match(lineText(accountSegments(reordered, { mono: false, now: NOW })), /^Claude {2}5h \S+ 38\.0%.* {2}Fable weekly \S+ 5\.0%$/);
});

test('accounts share one line when they fit, else one line each (never wider than the terminal)', () => {
  const two = [acct(), acct({ account: { harness: 'codex', scope: 'account', key: 'c', sourceKey: 'c' } })];
  assert.equal(accountLines(two, { width: 200, mono: false, now: NOW }).length, 1);
  const narrow = accountLines(two, { width: 50, mono: false, now: NOW });
  for (const l of narrow) assert.ok(lineCols(l) <= 50, lineText(l));
  const text = narrow.map(lineText);
  assert.deepEqual(text.filter((l) => /^(Claude|Codex)/.test(l)).map((l) => l.split(' ')[0]), ['Claude', 'Codex'], 'each account starts its own line; the rest are continuations');
  assert.ok(text.every((l) => !l.includes('…')), 'whole metrics wrap; nothing is cut');
  assert.equal(text.join('\n').match(/38\.0%/g)?.length, 2);
  const tiny = accountLines(two, { width: 22, mono: false, now: NOW }).map(lineText);
  assert.ok(tiny.every((l) => !l.includes('▓') && !l.includes('░')), 'too narrow for a whole bar: labelled numbers instead');
  assert.ok(tiny.some((l) => /weekly 90\.0%!/.test(l)));
  assert.deepEqual(accountLines([], { width: 80, mono: false }), []);
  assert.equal(resetHint(null), null);
  assert.equal(resetHint('2026-09-28T10:45:00Z', NOW), '0h45m');
});
