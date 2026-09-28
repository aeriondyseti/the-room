import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { HUMAN, type ParticipantState, type UsageSnapshot } from '../contracts/domain.js';
import { App } from './app.js';
import { FakeRoomSource } from './fake-source.js';
import { participantsSummary, relativeTime, usageLabel } from './format.js';
import { waitFor } from './test-utils.js';

afterEach(() => cleanup());
const plain = (s: string | undefined) => (s ?? '').replace(/\u001B\[[0-9;]*m/g, '');

const usage = (over: Partial<UsageSnapshot>): UsageSnapshot => ({
  source: 'codex-token-count', status: 'ok', observedAt: '2026-09-28T09:00:00Z', cumulative: null,
  context: { usedTokens: 100_000, limitTokens: 200_000, percent: 50 }, ...over,
});
const agent = (name: string, over: Partial<ParticipantState> = {}): ParticipantState => ({
  name, harness: 'codex', sessionId: name, liveness: 'online', livenessCheckedAt: null, activity: 'idle', pending: 0, usage: null, ...over,
});

test('usageLabel never invents numbers: n/a, absolute tokens without a limit, stale marked, hot colored', () => {
  assert.deepEqual(usageLabel(null), { text: 'usage n/a', dim: true });
  assert.equal(usageLabel(usage({ status: 'unavailable', context: null })).text, 'usage n/a');
  assert.equal(usageLabel(usage({ context: { usedTokens: 540_000, limitTokens: null, percent: null } })).text, 'ctx 540k');
  assert.equal(usageLabel(usage({ status: 'stale' })).text, 'ctx 50%?');
  assert.equal(usageLabel(usage({ context: { usedTokens: 1, limitTokens: 1, percent: 90 } })).color, 'red');
  assert.equal(usageLabel(usage({ context: { usedTokens: 1, limitTokens: 1, percent: 70 } })).color, 'yellow');
});

test('relativeTime and participant summary', () => {
  const now = Date.parse('2026-09-28T10:00:00Z');
  assert.equal(relativeTime('2026-09-28T09:59:30Z', now), '30s ago');
  assert.equal(relativeTime('2026-09-28T09:55:00Z', now), '5m ago');
  assert.equal(relativeTime(null, now), 'never');
  const parts = participantsSummary([agent('a'), agent('b', { activity: 'waiting_permission' }), agent('c', { liveness: 'rebind_needed' })]).map((p) => p.text);
  assert.deepEqual(parts, ['3 agents', '2 online', '1 needs approval', '1 rebind needed']);
});

test('six participants: the panel shows what fits and points to /who for the rest; header summarizes', async () => {
  const names = ['astra', 'claude', 'codex_reviewer', 'claude_builder', 'nova', 'orion'];
  const src = new FakeRoomSource({ participants: names.map((n, i) => agent(n, i === 3 ? { activity: 'waiting_permission' } : {})) });
  const ui = render(<App source={src} humanName="Kevin" width={100} height={16} />);
  const frame = await waitFor(() => plain(ui.lastFrame()), /6 agents · 6 online · 1 needs approval/);
  assert.match(frame, /\+\d+ more · \/who/);
  ui.stdin.write('/who');
  await new Promise((r) => setTimeout(r, 30));
  ui.stdin.write('\r');
  const who = await waitFor(() => plain(ui.lastFrame()), /Participants \(6\)/);
  for (const n of names) assert.match(who, new RegExp(n));
});

test('narrow terminals keep the participant summary in the header', async () => {
  const src = new FakeRoomSource({ participants: [agent('astra'), agent('claude', { liveness: 'offline' })] });
  const ui = render(<App source={src} humanName="Kevin" width={70} height={16} />);
  const frame = await waitFor(() => plain(ui.lastFrame()), /2 agents · 1 online/);
  assert.doesNotMatch(frame, /PARTICIPANTS/);
});

test('/detail shows an uncertain delivery with its attempt, error, and the retry command', async () => {
  const src = new FakeRoomSource({ participants: [agent('astra'), agent('claude', { harness: 'claude' })] });
  const m = src.post(HUMAN, ['astra', 'claude'], 'restart in five', { states: { astra: 'uncertain', claude: 'submitted' } });
  const t = m.message.createdAt;
  src.setDelivery(m.message.id, 'astra', {
    attempts: [{ n: 1, startedAt: t, finishedAt: t, outcome: 'uncertain', evidence: null, error: { code: 'internal', message: 'queue timed out after handover', hint: 'check before retrying' } }],
  });
  src.setDelivery(m.message.id, 'claude', {
    attempts: [{ n: 1, startedAt: t, finishedAt: t, outcome: 'submitted', evidence: { kind: 'claude-pipe-write', pid: 4242 }, error: null }],
  });
  const ui = render(<App source={src} humanName="Kevin" width={110} height={30} />);
  await waitFor(() => plain(ui.lastFrame()), /restart in five/);
  ui.stdin.write(`/detail #${m.message.seq}`);
  await new Promise((r) => setTimeout(r, 30));
  ui.stdin.write('\r');
  const detail = await waitFor(() => plain(ui.lastFrame()), /Message #1/);
  assert.match(detail, /\? astra uncertain/);
  assert.match(detail, /attempt 1 · \d\d:\d\d uncertain/);
  assert.match(detail, /queue timed out after handover — check before retrying/);
  assert.match(detail, /↑ claude sent/);
  assert.match(detail, /pipe write to pid 4242/);
  assert.match(detail, /\/retry #1 @astra to re-send \(uncertain ones may already have arrived\)/);
});

test('/detail with no argument opens the latest message; an unknown number is an inline error', async () => {
  const src = new FakeRoomSource({ participants: [agent('astra')] });
  src.post(HUMAN, 'all', 'first');
  src.post(HUMAN, 'all', 'second');
  const ui = render(<App source={src} humanName="Kevin" width={100} height={24} />);
  await waitFor(() => plain(ui.lastFrame()), /second/);
  ui.stdin.write('/detail');
  await new Promise((r) => setTimeout(r, 30));
  ui.stdin.write('\r');
  await waitFor(() => plain(ui.lastFrame()), /Message #2/);
  ui.stdin.write('\u001B');
  await waitFor(() => (/Message #2/.test(plain(ui.lastFrame())) ? '' : 'closed'), /closed/);
  ui.stdin.write('/detail #99');
  await new Promise((r) => setTimeout(r, 30));
  ui.stdin.write('\r');
  await waitFor(() => plain(ui.lastFrame()), /No message #99 in view/);
});
