import './force-color.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import type { ActivityItem } from '../contracts/activity.js';
import type { ParticipantState } from '../contracts/domain.js';
import { App } from './app.js';
import { activityLines, visibleItems } from './activity.js';
import { FakeRoomSource } from './fake-source.js';
import { waitFor } from './test-utils.js';

afterEach(() => cleanup());
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const plain = (s: string | undefined) => (s ?? '').replace(/\u001B\[[0-9;]*m/g, '');
const K = { enter: '\r', esc: '\u001B', up: '\u001B[A' };
const agent = (name: string): ParticipantState => ({ name, harness: 'claude', sessionId: `${name}-s`, liveness: 'online', livenessCheckedAt: null, activity: 'idle', pending: 0, usage: null });
const stream = { participant: 'astra', harness: 'claude' as const, sessionId: 'astra-s', generation: 1 };
const T = '2026-09-28T10:00:00.000Z';
let seq = 0;
const item = (over: Partial<ActivityItem>): ActivityItem => ({ stream, seq: ++seq, at: T, kind: 'tool_call', summary: 'x', detailTruncated: false, ...over });

async function open(src: FakeRoomSource, name = 'astra') {
  const ui = render(<App source={src} humanName="Kevin" width={110} height={26} />);
  await tick();
  ui.stdin.write(`/activity @${name}`);
  await tick();
  ui.stdin.write(K.enter);
  await tick(80);
  return { ui, frame: () => plain(ui.lastFrame()), type: async (s: string) => { ui.stdin.write(s); await tick(60); } };
}

test('/activity @name shows tool calls, results and messages with glyphs; Esc returns to the room', async () => {
  seq = 0;
  const src = new FakeRoomSource({ participants: [agent('astra')] });
  src.setActivity('astra', [
    item({ kind: 'message', role: 'user', summary: 'please run the tests' }),
    item({ kind: 'tool_call', tool: 'Bash', callId: 'c1', summary: 'npm test', detail: 'npm test' }),
    item({ kind: 'tool_result', callId: 'c1', isError: true, summary: 'error: 2 failing', detail: '2 failing\nsee log' }),
  ]);
  const t = await open(src);
  const f = await waitFor(t.frame, /Activity · astra/);
  assert.match(f, /› please run the tests/);
  assert.match(f, /▸ Bash npm test/);
  assert.match(f, /✗ error: 2 failing/);
  assert.match(f, /live/);
  await t.type(K.esc);
  await waitFor(t.frame, /Message everyone/);
  assert.doesNotMatch(t.frame(), /Activity · astra/);
});

test('new activity appears live; Enter expands the selected item with its detail; f filters to errors', async () => {
  seq = 0;
  const src = new FakeRoomSource({ participants: [agent('astra')] });
  src.setActivity('astra', [item({ kind: 'tool_call', tool: 'Bash', summary: 'ls', detail: 'ls -la' })]);
  const t = await open(src);
  await waitFor(t.frame, /▸ Bash ls/);
  src.appendActivity('astra', [item({ kind: 'tool_result', summary: 'boom', isError: true, detail: 'stack trace here', detailTruncated: true })]);
  await waitFor(t.frame, /✗ boom/);
  await t.type(K.enter); // expands the newest (selected) item
  const expanded = await waitFor(t.frame, /stack trace here/);
  assert.match(expanded, /truncated \(detail cap reached\)/);
  await t.type('f');
  await t.type('f'); // all → tools → errors
  const errorsOnly = await waitFor(t.frame, /filter: errors/);
  assert.doesNotMatch(errorsOnly, /▸ Bash ls/);
  assert.match(errorsOnly, /✗ boom/);
});

test('honest coverage: unavailable and partial are labelled; evicted history says so; unknown names are rejected', async () => {
  seq = 0;
  const src = new FakeRoomSource({ participants: [agent('astra'), agent('codexy')] });
  src.setActivity('codexy', [], { coverage: 'unavailable', reason: "activity for codex sessions isn't supported yet" });
  src.setActivity('astra', [item({ summary: 'recent' })], { coverage: 'partial', reason: '2 malformed lines', olderEvicted: true });
  const a = await open(src, 'codexy');
  const fa = await waitFor(a.frame, /Unavailable: activity for codex sessions isn't supported yet/);
  assert.match(fa, /No activity to show/);
  assert.doesNotMatch(fa, /No activity observed yet/, 'never an empty "no activity" when coverage is unavailable');
  cleanup();
  const b = await open(src, 'astra');
  const fb = await waitFor(b.frame, /Partial coverage: 2 malformed lines/);
  assert.match(fb, /earlier activity isn't retained/);
  cleanup();
  const c = await open(src, 'nobody');
  assert.match(await waitFor(c.frame, /No participant named "nobody"/), /\/who lists them/);
});

test('result status: explicit success ✓, explicit error ✗, unknown stays a neutral ◂ (never implied success)', () => {
  seq = 0;
  const rows = activityLines([
    item({ kind: 'tool_result', isError: false, summary: 'ok' }),
    item({ kind: 'tool_result', isError: true, summary: 'bad' }),
    item({ kind: 'tool_result', summary: 'unknown' }),
  ], { width: 80, selected: -1, expanded: new Set() }).lines;
  const glyph = (i: number) => rows[i]!.find((s) => /^[✓✗◂]$/.test(s.text));
  assert.deepEqual([glyph(0)?.text, glyph(1)?.text, glyph(2)?.text], ['✓', '✗', '◂']);
  assert.equal(glyph(2)?.color, undefined, 'no success colour for an unknown outcome');
});

test('large histories stay responsive: 1000 items build a bounded line model quickly', () => {
  seq = 0;
  const many = Array.from({ length: 1000 }, (_, i) => item({ summary: `step ${i}`, detail: 'x'.repeat(4000) }));
  const start = performance.now();
  const { lines, starts } = activityLines(visibleItems(many, 'all'), { width: 100, selected: 999, expanded: new Set([many[999]!.seq]) });
  const ms = performance.now() - start;
  assert.equal(starts.length, 1000);
  assert.ok(lines.length > 1000, 'the expanded item adds its wrapped detail');
  assert.ok(ms < 1000, `line model for 1000 items took ${ms.toFixed(0)}ms`);
});
