import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { HUMAN, type ParticipantState } from '../contracts/domain.js';
import { App } from './app.js';
import { FakeRoomSource } from './fake-source.js';
import { waitFor } from './test-utils.js';

afterEach(() => cleanup());

const KEYS = { pageUp: '\u001B[5~', pageDown: '\u001B[6~', end: '\u001B[F' };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const plain = (s: string | undefined) => (s ?? '').replace(/\u001B\[[0-9;]*m/g, '');

const agent = (name: string, over: Partial<ParticipantState> = {}): ParticipantState => ({
  name, harness: 'codex', sessionId: name, liveness: 'online', livenessCheckedAt: null, activity: 'idle', pending: 0, usage: null, ...over,
});

function room(messages = 0) {
  const src = new FakeRoomSource({ participants: [agent('astra'), agent('claude', { harness: 'claude', activity: 'busy' })] });
  for (let i = 1; i <= messages; i++) src.post(i % 2 ? HUMAN : 'astra', i % 2 ? 'all' : [HUMAN], `message number ${i}`);
  return src;
}

test('renders the conversation, participants and connection from the room snapshot', async () => {
  const src = room(3);
  const ui = render(<App source={src} humanName="Kevin" width={100} height={20} />);
  await tick();
  const frame = plain(ui.lastFrame());
  assert.match(frame, /vibe-pairing/);
  assert.match(frame, /● connected/);
  assert.match(frame, /PARTICIPANTS/);
  assert.match(frame, /claude\s*│/);
  assert.match(frame, /busy/);
  assert.match(frame, /Kevin → everyone/);
  assert.match(frame, /message number 3/);
  assert.deepEqual(src.requests.map((r) => r.method).slice(0, 3), ['subscribe', 'who', 'read']);
});

test('empty room shows guidance instead of a blank pane', async () => {
  const ui = render(<App source={room(0)} humanName="Kevin" width={100} height={20} />);
  await tick();
  assert.match(plain(ui.lastFrame()), /The room is quiet/);
});

test('scrolling up holds the viewport and counts new messages; End returns to live', async () => {
  const src = room(20);
  const ui = render(<App source={src} humanName="Kevin" width={80} height={14} />);
  await tick();
  assert.match(plain(ui.lastFrame()), /message number 20/);
  ui.stdin.write(KEYS.pageUp);
  await tick();
  const scrolled = plain(ui.lastFrame());
  assert.doesNotMatch(scrolled, /message number 20/);
  assert.match(scrolled, /↑ scrolled/);

  src.post('astra', [HUMAN], 'brand new while scrolled');
  const held = await waitFor(() => plain(ui.lastFrame()), /1 new below/);
  assert.doesNotMatch(held, /brand new while scrolled/, 'viewport did not jump');

  ui.stdin.write(KEYS.end);
  const live = await waitFor(() => plain(ui.lastFrame()), /● live/);
  assert.match(live, /brand new while scrolled/);
});

test('following live shows new messages immediately', async () => {
  const src = room(2);
  const ui = render(<App source={src} humanName="Kevin" width={80} height={14} />);
  await tick();
  src.post('claude', [HUMAN], 'fresh message');
  await tick();
  assert.match(plain(ui.lastFrame()), /fresh message/);
});

test('reconnect: banner while down, then state is refreshed (who + read) on reconnect', async () => {
  const src = room(1);
  const ui = render(<App source={src} humanName="Kevin" width={100} height={16} />);
  await tick();
  src.setStatus({ state: 'reconnecting', detail: 'pipe closed' });
  await tick();
  const down = plain(ui.lastFrame());
  assert.match(down, /Reconnecting to the room service \(pipe closed\)/);
  assert.match(down, /◐ reconnecting/);

  // A message lands while we're disconnected (no live event reaches us)…
  const before = src.requests.length;
  src.setStatus({ state: 'connected' });
  await tick(60);
  const methods = src.requests.slice(before).map((r) => r.method);
  assert.deepEqual(methods.slice(0, 3), ['subscribe', 'who', 'read'], 'refreshes after reconnect');
  const up = plain(ui.lastFrame());
  assert.doesNotMatch(up, /Reconnecting/);
  assert.match(up, /● connected/);
});

test('events that arrive while a snapshot loads are re-applied on top of it (no rollback)', async () => {
  const src = room(1);
  const first = (await src.request('read', { limit: 1 })).items[0]!;
  // Deliver an update from inside the `who` request, i.e. after subscribe but before the snapshot applies.
  const realRequest = src.request.bind(src);
  let injected = false;
  src.request = (async (method: string, params: unknown) => {
    const result = await realRequest(method as never, params as never);
    if (method === 'who' && !injected) {
      injected = true;
      src.setDelivery(first.message.id, 'astra', { state: 'replied' });
    }
    return result;
  }) as typeof src.request;
  const ui = render(<App source={src} humanName="Kevin" width={100} height={16} />);
  await tick(60);
  assert.match(plain(ui.lastFrame()), /✓ astra/, 'the newer replied state survives the snapshot');
});

test('a failed load says so and retries on r', async () => {
  const src = room(1);
  const realRequest = src.request.bind(src);
  let fail = true;
  src.request = (async (method: string, params: unknown) => {
    if (fail && method === 'read') throw new Error('database is locked');
    return realRequest(method as never, params as never);
  }) as typeof src.request;
  const ui = render(<App source={src} humanName="Kevin" width={100} height={16} />);
  await tick(60);
  assert.match(plain(ui.lastFrame()), /Couldn't load the room\.[\s\S]*Press r to try again/);
  fail = false;
  ui.stdin.write('r');
  await tick(60);
  assert.match(plain(ui.lastFrame()), /message number 1/);
});

test('while disconnected the participant panel is marked stale', async () => {
  const src = room(1);
  const ui = render(<App source={src} humanName="Kevin" width={100} height={16} />);
  await tick();
  src.setStatus({ state: 'disconnected' });
  await tick();
  const frame = plain(ui.lastFrame());
  assert.match(frame, /PARTICIPANTS · stale/);
  assert.match(frame, /last known: busy/);
});

test('after a reconnect, delivery states of messages already on screen are refreshed', async () => {
  const src = room(0);
  const m = src.post(HUMAN, ['astra'], 'deploy the fix', { states: { astra: 'queued' } });
  const ui = render(<App source={src} humanName="Kevin" width={100} height={16} />);
  await waitFor(() => plain(ui.lastFrame()), /◌ astra/);
  src.setStatus({ state: 'reconnecting', detail: 'service restarted' });
  src.setDelivery(m.message.id, 'astra', { state: 'failed' }, { silent: true }); // missed while away
  src.setStatus({ state: 'connected' });
  const frame = await waitFor(() => plain(ui.lastFrame()), /✗ astra failed/);
  assert.doesNotMatch(frame, /◌ astra/);
});

test('narrow terminals hide the participant panel instead of squeezing it', async () => {
  const ui = render(<App source={room(2)} humanName="Kevin" width={60} height={14} />);
  await tick();
  assert.doesNotMatch(plain(ui.lastFrame()), /PARTICIPANTS/);
});
