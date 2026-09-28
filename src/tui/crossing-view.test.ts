// M7 (7.4): crossing-guard marks in the TUI — URGENT, ⤫ (sent over uncovered messages), revised/unguarded, and the
// per-agent "N not covered" count with the snapshot time it summarizes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MessageCrossingInfo } from '../contracts/crossing.js';
import { HUMAN, type MessageWithDeliveries, type ParticipantState } from '../contracts/domain.js';
import { DELIVERY_LEGEND, lineText, messageLines } from './format.js';
import { FakeRoomSource } from './fake-source.js';
import { sidePanelLines } from './sidepanel.js';
import { inboxCell, participantChip } from './topbar.js';
import { agentGrid } from './topgrid.js';

const src = new FakeRoomSource({ participants: [] });
const ctx = (width: number) => ({ width, humanName: 'Kevin', seqById: new Map<string, number>() });
const crossing = (over: Partial<MessageCrossingInfo>): MessageCrossingInfo => ({ attemptId: 'a1', guard: 'current', urgent: null, newSinceSnapshot: 0, revisesAttemptId: null, ...over });
const withCrossing = (c: MessageCrossingInfo | undefined, body = 'deploy is blocked'): MessageWithDeliveries => {
  const m = src.post('astra', ['claude'], body);
  return { ...m, message: { ...m.message, crossing: c } } as MessageWithDeliveries;
};
const text = (item: MessageWithDeliveries, width = 100) => messageLines(item, ctx(width)).map(lineText);

test('an urgent send shows the URGENT badge, ⤫ with the count, and its reason', () => {
  const lines = text(withCrossing(crossing({ guard: 'urgent', urgent: { reason: 'main is red' }, newSinceSnapshot: 2 })));
  assert.match(lines[0]!, / URGENT  ⤫ astra → claude  sent over 2 not covered/);
  assert.match(lines[1]!, /why urgent: main is red/);
  assert.match(lines[2]!, /deploy is blocked/);
});

test('an unknown count is shown as unknown, never as zero', () => {
  const [head] = text(withCrossing(crossing({ guard: 'urgent', urgent: { reason: 'r' }, newSinceSnapshot: null })));
  assert.match(head!, /⤫/);
  assert.match(head!, /sent over an unknown number not covered/);
});

test('urgent over a covered inbox gets the badge but no ⤫', () => {
  const [head] = text(withCrossing(crossing({ guard: 'urgent', urgent: { reason: 'r' }, newSinceSnapshot: 0 })));
  assert.match(head!, /URGENT/);
  assert.doesNotMatch(head!, /⤫|sent over/);
});

test('narrow widths shed the detail but never URGENT or ⤫', () => {
  const [head] = text(withCrossing(crossing({ guard: 'urgent', urgent: { reason: 'r' }, newSinceSnapshot: 5, revisesAttemptId: 'a0' })), 40);
  assert.match(head!, /URGENT/);
  assert.match(head!, /⤫/);
  assert.doesNotMatch(head!, /sent over|revised/);
});

test('revised and unguarded sends are labelled quietly; an ordinary send has no marks', () => {
  assert.match(text(withCrossing(crossing({ revisesAttemptId: 'a0' })))[0]!, /revised after a blocked send/);
  assert.match(text(withCrossing(crossing({ guard: 'legacy' })))[0]!, /unguarded/);
  for (const c of [undefined, crossing({})]) {
    const [head] = text(withCrossing(c));
    assert.doesNotMatch(head!, /URGENT|⤫|revised|unguarded/);
  }
});

test('a long urgent reason wraps in full rather than being cut off', () => {
  const reason = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
  const lines = text(withCrossing(crossing({ guard: 'urgent', urgent: { reason }, newSinceSnapshot: 1 })), 40);
  const shown = lines.slice(1).join(' ');
  for (let i = 0; i < 30; i++) assert.match(shown, new RegExp(`\\bword${i}\\b`));
  assert.doesNotMatch(shown, /…/);
});

const agent = (name: string, over: Partial<ParticipantState> = {}): ParticipantState => ({
  name, harness: 'codex', sessionId: name, liveness: 'online', livenessCheckedAt: null, activity: 'idle', pending: 0,
  usage: { source: 'codex-token-count', status: 'ok', observedAt: null, cumulative: null, context: { usedTokens: 59, limitTokens: 100, percent: 59 } }, ...over,
});
const inbox = (uncovered: number) => ({ snapshot: 's', uncovered, checkedAt: '2026-09-28T10:02:00' });

test('inboxCell: a count only when something is uncovered, known, and live', () => {
  assert.equal(lineText(inboxCell(agent('a', { inbox: inbox(3) }), false)), '3 not covered');
  assert.deepEqual(inboxCell(agent('a', { inbox: inbox(0) }), false), []);
  assert.deepEqual(inboxCell(agent('a'), false), [], 'unknown is not zero, and not shown as a count');
  assert.deepEqual(inboxCell(agent('a', { inbox: null }), false), []);
  assert.deepEqual(inboxCell(agent('a', { inbox: inbox(3) }), true), [], 'not while disconnected');
});

test('the agent grid shows the count in its own aligned column', () => {
  const rows = agentGrid([agent('astra', { inbox: inbox(3) }), agent('claude')], { width: 100, stale: false, maxRows: 6 })!.map(lineText);
  const a = rows.find((r) => r.includes('astra'))!, c = rows.find((r) => r.includes('claude'))!;
  assert.match(a, /idle\s+3 not covered\s+ctx/);
  assert.equal(a.indexOf('ctx'), c.indexOf('ctx'), 'ctx column stays aligned');
});

test('the fallback chip carries the count', () => {
  assert.match(lineText(participantChip(agent('astra', { inbox: inbox(2) }), { stale: false, mono: false })), /idle · 2 not covered ctx/);
});

test('the side panel names the snapshot time, and says covered when it is', () => {
  const lines = (p: ParticipantState) => sidePanelLines([p], [], { width: 34, height: 20, stale: false, mono: false, humanName: 'Kevin' }).map(lineText);
  assert.ok(lines(agent('astra', { inbox: inbox(4) })).some((l) => /4 not covered · as of 10:02/.test(l)));
  assert.ok(lines(agent('astra', { inbox: inbox(0) })).some((l) => /inbox covered · as of 10:02/.test(l)));
  assert.ok(!lines(agent('astra')).some((l) => /inbox|not covered/.test(l)), 'no inbox info → nothing, not "covered"');
});

const delivered = (states: Array<[string, 'queued' | 'submitted' | 'withdrawn']>): MessageWithDeliveries => {
  const m = src.post('astra', states.map(([n]) => n), 'please hold');
  return { ...m, deliveries: states.map(([recipient, state]) => ({ recipient, state, held: false, waiting: null, ...(state === 'withdrawn' ? { withdrawnAt: '2026-09-28T11:05:00' } : {}) })) } as unknown as MessageWithDeliveries;
};

test('a fully withdrawn message says so, dims its body, and strikes each recipient with the time', () => {
  const lines = messageLines(delivered([['claude', 'withdrawn']]), ctx(100));
  assert.match(lineText(lines[0]!), /astra ⊘ withdrawn → claude/);
  const body = lines.find((l) => lineText(l).includes('please hold'))!;
  assert.ok(body.some((s) => s.text.includes('please hold') && s.dim));
  const marks = lines.at(-1)!;
  assert.match(lineText(marks), /⊘ claude withdrawn 11:05/);
  assert.ok(marks.some((s) => s.text === 'claude' && s.strikethrough));
});

test('a partial withdraw is never shown as whole', () => {
  const lines = messageLines(delivered([['claude', 'withdrawn'], ['bob', 'submitted']]), ctx(100));
  const head = lineText(lines[0]!);
  assert.doesNotMatch(head, /astra ⊘ withdrawn/);
  assert.match(lineText(messageLines(delivered([['claude', 'withdrawn'], ['bob', 'submitted']]), ctx(36))[0]!), /⊘ 1\/2 withdrawn/, 'kept at narrow widths');
  assert.match(head, /astra ⊘ 1\/2 withdrawn → claude, bob/);
  const body = lines.find((l) => lineText(l).includes('please hold'))!;
  assert.ok(!body.some((s) => s.dim), 'body stays normal while some recipient still got it');
  const marks = lines.at(-1)!;
  assert.ok(marks.some((s) => s.text === 'claude' && s.strikethrough));
  assert.ok(marks.some((s) => s.text === 'bob' && !s.strikethrough));
});

test('the legend explains the withdrawn mark', () => {
  assert.ok(DELIVERY_LEGEND.some((m) => m.label === 'withdrawn' && m.glyph === '⊘'));
});
test('⤫ survives a long sender name at a narrow width', () => {
  const m = src.post('a-very-long-agent-name-that-overflows', ['claude'], 'x');
  const item = { ...m, message: { ...m.message, crossing: crossing({ guard: 'urgent', urgent: { reason: 'r' }, newSinceSnapshot: 3 }) } } as MessageWithDeliveries;
  assert.match(lineText(messageLines(item, ctx(30))[0]!), /⤫/);
});

test('the side panel shows the inbox row even when the agent has a model/branch row', () => {
  const p = agent('astra', { inbox: inbox(3), workspace: { model: 'gpt-5', cwd: null, git: null } as ParticipantState['workspace'] });
  const lines = sidePanelLines([p], [], { width: 30, height: 30, stale: false, mono: false, humanName: 'Kevin' }).map(lineText);
  assert.ok(lines.some((l) => /3 not covered · as of 10:02/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /gpt-5/.test(l)));
});

test('with no inbox counts the agent grid keeps its pre-M7 spacing', () => {
  const rows = agentGrid([agent('astra'), agent('claude', { inbox: inbox(0) })], { width: 100, stale: false, maxRows: 6 })!.map(lineText);
  for (const r of rows.filter((x) => /astra|claude/.test(x))) assert.match(r, /idle {2}ctx/, 'no empty inbox column (one GAP only)');
});
test('an agent+human message whose only agent delivery is withdrawn is not "wholly withdrawn"', () => {
  const m = src.post('astra', ['claude', HUMAN], 'heads up');
  const item = { ...m, deliveries: [{ recipient: 'claude', state: 'withdrawn', held: false, waiting: null, withdrawnAt: '2026-09-28T11:05:00' }] } as unknown as MessageWithDeliveries;
  const lines = messageLines(item, ctx(100));
  const head = lineText(lines[0]!);
  assert.doesNotMatch(head, /astra ⊘ withdrawn/);
  assert.match(head, /⊘ 1\/2 withdrawn/);
  const body = lines.find((l) => lineText(l).includes('heads up'))!;
  assert.ok(!body.some((s) => s.dim), 'the human saw it, so the body is not dimmed as withdrawn');
});