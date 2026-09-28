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

test('six participants: the top bar shows what fits and points to /who for the rest; header summarizes', async () => {
  const names = ['astra', 'claude', 'codex_reviewer', 'claude_builder', 'nova', 'orion'];
  const src = new FakeRoomSource({ participants: names.map((n, i) => agent(n, i === 3 ? { activity: 'waiting_permission' } : {})) });
  const ui = render(<App source={src} humanName="Kevin" width={70} height={16} />);
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
  assert.match(detail, /queue timed out after handover/);
  assert.match(detail, /→ check before retrying/);
  assert.match(detail, /↑ claude sent/);
  assert.match(detail, /pipe write to pid 4242/);
  assert.match(detail, /\/retry #1 @astra to re-send \(uncertain ones may already have arrived\)/);
});

test('/detail on a big broadcast in a short pane scrolls instead of clipping; actionable lines come first', async () => {
  const names = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
  const src = new FakeRoomSource({ participants: names.map((n) => agent(n)) });
  const states = Object.fromEntries(names.map((n, i) => [n, i === 5 ? 'failed' : 'submitted'])) as Record<string, 'failed' | 'submitted'>;
  const m = src.post(HUMAN, 'all', 'big broadcast', { states });
  for (const n of names) {
    src.setDelivery(m.message.id, n, {
      attempts: [{ n: 1, startedAt: m.message.createdAt, finishedAt: m.message.createdAt, outcome: n === 'a6' ? 'failed' : 'submitted', evidence: n === 'a6' ? null : { kind: 'codex-queue', nativeId: 'q-' + n }, error: n === 'a6' ? { code: 'internal', message: 'codex queue exited with code 1 because the thread was archived by its owner', hint: 'rejoin the agent, then /retry' } : null }],
    });
  }
  const ui = render(<App source={src} humanName="Kevin" width={70} height={18} />); // +2 rows for the top bar
  await waitFor(() => plain(ui.lastFrame()), /big broadcast/);
  ui.stdin.write('/detail');
  await new Promise((r) => setTimeout(r, 30));
  ui.stdin.write('\r');
  const top = await waitFor(() => plain(ui.lastFrame()), /Message #1/);
  assert.match(top, /\/retry #1 @a6 to re-send/, 'retry hint at the top');
  assert.match(top, /✗ a6 failed/, 'failed recipient listed first');
  assert.match(top, /↓ \d+ more lines · PgDn/, 'overflow is announced, not silently clipped');
  ui.stdin.write('\u001B[6~'); // PgDn
  const lower = await waitFor(() => plain(ui.lastFrame()), /↑ a1 sent/);
  assert.doesNotMatch(lower, /Message #1 ·/, 'scrolled');
  for (let i = 0; i < 5; i++) ui.stdin.write('\u001B[6~');
  const bottom = await waitFor(() => plain(ui.lastFrame()), /↑ a5 sent/);
  assert.doesNotMatch(bottom, /more lines · PgDn/, 'nothing left below at the end');
});

test('/detail wraps long errors instead of cutting them', async () => {
  const src = new FakeRoomSource({ participants: [agent('astra')] });
  const m = src.post(HUMAN, ['astra'], 'x', { states: { astra: 'failed' } });
  src.setDelivery(m.message.id, 'astra', {
    attempts: [{ n: 1, startedAt: m.message.createdAt, finishedAt: null, outcome: 'failed', evidence: null, error: { code: 'internal', message: 'the Codex queue command failed because the executable could not be found on PATH or at the room override location', hint: 'set ROOM_CODEX_EXECUTABLE or install Codex' } }],
  });
  const ui = render(<App source={src} humanName="Kevin" width={60} height={30} />);
  await waitFor(() => plain(ui.lastFrame()), /Kevin → astra/);
  ui.stdin.write('/detail');
  await new Promise((r) => setTimeout(r, 30));
  ui.stdin.write('\r');
  const frame = await waitFor(() => plain(ui.lastFrame()), /override location/);
  assert.match(frame, /could not be found on PATH/, 'the whole error is visible, wrapped over lines');
  assert.match(frame, /→ set ROOM_CODEX_EXECUTABLE or install Codex/);
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
