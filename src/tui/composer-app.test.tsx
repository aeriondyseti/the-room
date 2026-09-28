import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { HUMAN, type ParticipantState } from '../contracts/domain.js';
import { RoomError } from '../contracts/errors.js';
import type { Params } from '../contracts/ipc.js';
import { App } from './app.js';
import { FakeRoomSource } from './fake-source.js';
import { waitFor } from './test-utils.js';

afterEach(() => cleanup());

const K = { enter: '\r', esc: '\u001B', tab: '\t', up: '\u001B[A', ctrlEnter: '\n', pageDown: '\u001B[6~' };
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const plain = (s: string | undefined) => (s ?? '').replace(/\u001B\[[0-9;]*m/g, '');

const agent = (name: string, over: Partial<ParticipantState> = {}): ParticipantState => ({
  name, harness: 'codex', sessionId: name, liveness: 'online', livenessCheckedAt: null, activity: 'idle', pending: 0, usage: null, ...over,
});

async function setup() {
  const src = new FakeRoomSource({ participants: [agent('astra'), agent('claude', { harness: 'claude' })] });
  const ui = render(<App source={src} humanName="Kevin" width={100} height={24} />);
  await tick();
  const type = async (s: string) => {
    ui.stdin.write(s);
    await tick();
  };
  const sends = () => src.requests.filter((r) => r.method === 'send').map((r) => r.params as Params<'send'>);
  return { src, ui, type, sends, frame: () => plain(ui.lastFrame()) };
}

test('typing and Enter sends to everyone; the message appears and the draft clears', async () => {
  const t = await setup();
  assert.match(t.frame(), /To: everyone/);
  await t.type('hello team');
  await t.type(K.enter);
  const [sent] = t.sends();
  assert.deepEqual({ to: sent?.to, body: sent?.body, caller: sent?.caller }, { to: null, body: 'hello team', caller: { kind: 'human' } });
  assert.ok(sent?.clientMessageId, 'every send carries a client_message_id');
  assert.match(t.frame(), /Kevin → everyone/);
  assert.match(t.frame(), /Message everyone, or @name someone/, 'draft cleared');
});

test('@name targets one agent and the To: line follows the draft', async () => {
  const t = await setup();
  await t.type('@astra please review');
  assert.match(t.frame(), /To: astra/);
  await t.type(K.enter);
  assert.deepEqual(t.sends()[0]?.to, ['astra']);
});

test('an unknown @name is flagged live, refused on Enter, and the draft is kept', async () => {
  const t = await setup();
  await t.type('@astr hi');
  assert.match(t.frame(), /To: astr \(unknown name\)/);
  await t.type(K.enter);
  assert.equal(t.sends().length, 0);
  assert.match(t.frame(), /Did you mean @astra\?/);
  assert.match(t.frame(), /@astr hi/, 'draft kept for fixing');
});

test('Tab completes names; Esc clears the draft; Ctrl+Enter adds a line', async () => {
  const t = await setup();
  await t.type('@cl');
  await t.type(K.tab);
  assert.match(t.frame(), /@claude/);
  await t.type(K.esc);
  assert.doesNotMatch(t.frame(), /@claude/);
  await t.type('line one');
  await t.type(K.ctrlEnter);
  await t.type('line two');
  await t.type(K.enter);
  assert.equal(t.sends()[0]?.body, 'line one\nline two');
});

test('↑ recalls the previous message', async () => {
  const t = await setup();
  await t.type('first message');
  await t.type(K.enter);
  await t.type(K.up);
  assert.match(t.frame(), /› first message/);
});

test('a failed send shows the error, keeps the draft, and a resend reuses the same client_message_id', async () => {
  const t = await setup();
  const real = t.src.request.bind(t.src);
  let fail = true;
  const attempts: Array<string | null | undefined> = [];
  t.src.request = (async (method: string, params: unknown) => {
    if (method === 'send') {
      attempts.push((params as Params<'send'>).clientMessageId);
      if (fail) throw new RoomError('service_unavailable', 'Request timed out');
    }
    return real(method as never, params as never);
  }) as typeof t.src.request;
  await t.type('important');
  await t.type(K.enter);
  assert.match(t.frame(), /Send outcome unknown \(Request timed out\)\. Press Enter to resend safely/);
  assert.match(t.frame(), /› important/);
  fail = false;
  await t.type(K.enter);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], attempts[1], 'same id → the room can deduplicate an ambiguous first attempt');
});

test('a send refused before it left says "Not sent"', async () => {
  const t = await setup();
  t.src.request = (async (method: string) => {
    if (method === 'send') throw new RoomError('service_unavailable', 'Not connected to the room service yet; try again in a moment.');
    throw new Error('unexpected');
  }) as typeof t.src.request;
  await t.type('hello');
  await t.type(K.enter);
  assert.match(t.frame(), /Not sent: Not connected/);
});

test('/pause and /resume call the service and explain what happened', async () => {
  const t = await setup();
  await t.type('/pause please wrap up');
  await t.type(K.enter);
  const pause = t.src.requests.find((r) => r.method === 'pause')?.params as Params<'pause'>;
  assert.deepEqual(pause, { caller: { kind: 'human' }, stopRequestBody: 'please wrap up' });
  assert.match(t.frame(), /Paused\. Stop request sent to 2 agents/);
  assert.match(t.frame(), /⏸ PAUSED/);
  assert.match(t.frame(), /STOP REQUEST/);
  await t.type('/resume');
  await t.type(K.enter);
  assert.match(t.frame(), /Resumed\./);
});

test('/retry on an uncertain delivery asks for confirmation first', async () => {
  const t = await setup();
  const item = t.src.post(HUMAN, ['astra'], 'deploy notes', { states: { astra: 'uncertain' } });
  await tick();
  await t.type(`/retry #${item.message.seq}`);
  await t.type(K.enter);
  assert.match(t.frame(), /may already have been delivered\. Press Enter again/);
  assert.equal(t.src.requests.filter((r) => r.method === 'retry').length, 0);
  await t.type(K.enter);
  assert.deepEqual(t.src.requests.find((r) => r.method === 'retry')?.params, { caller: { kind: 'human' }, messageId: item.message.id, recipient: 'astra' });
});

test('? opens help; Esc closes it', async () => {
  const t = await setup();
  await t.type('?');
  const help = await waitFor(t.frame, /Commands/);
  assert.match(help, /Keys/, 'the top of the help is visible');
  // 6.10: the help pages like /detail, so a longer command list never falls off a short terminal.
  assert.match(help, /↓ \d+ more lines? · PgDn/);
  await t.type(K.pageDown);
  assert.match(await waitFor(t.frame, /\/pause \[message\]/), /\/pause \[message\]/);
  await t.type(K.esc);
  await waitFor(t.frame, /Message everyone/);
  assert.doesNotMatch(t.frame(), /Commands/);
});

test('typing / lists commands (from the shared catalogue), filters as you type, and hides once arguments start', async () => {
  const t = await setup();
  await t.type('/');
  const all = await waitFor(t.frame, /\/activity @name/);
  assert.match(all, /\/detail \[#N\]/);
  assert.match(all, /Tab complete · ↑\/↓ choose · Enter run/);
  await t.type('re');
  const re = await waitFor(t.frame, /\/retry #N \[@agent\]/);
  assert.match(re, /\/restart/);
  assert.match(re, /\/resume/);
  assert.doesNotMatch(re, /\/activity @name/, 'filtered by prefix');
  await t.type('try ');
  assert.doesNotMatch(t.frame(), /\/restart/, 'no suggestions once arguments start');
});

test('Tab completes the highlighted command; ↑/↓ move the highlight; history and @name Tab still work outside suggestions', async () => {
  const t = await setup();
  await t.type('/ac');
  await t.type(K.tab);
  await waitFor(t.frame, /› \/activity\s/); // completed (with a trailing space: it takes arguments)
  await t.type(K.esc);
  await waitFor(t.frame, /Message everyone/);
  await t.type('/re');
  await waitFor(t.frame, /\/retry #N/);
  await t.type('\u001B[B'); // down → /restart (catalogue order since 8.4: rename, restart, resume, retry)
  await t.type('\u001B[B'); // down → /resume
  await t.type(K.tab);
  await waitFor(t.frame, /› \/resume/);
  await t.type(K.esc);
  await waitFor(t.frame, /Message everyone/);
  await t.type('@as');
  await t.type(K.tab);
  await waitFor(t.frame, /@astra/); // @name completion unchanged
});

test('a partial name + Enter runs the highlighted no-argument command; /restart still needs its confirmation', async () => {
  const t = await setup();
  await t.type('/wh');
  await t.type(K.enter);
  await waitFor(t.frame, /Participants \(2\)/);
  await t.type(K.esc);
  await waitFor(t.frame, /Message everyone/);
  await t.type('/rest');
  await t.type(K.enter);
  await waitFor(t.frame, /Restart the room service\?/); // confirmation first
  assert.equal(t.src.requests.filter((r) => r.method === 'shutdown').length, 0);
  await t.type(K.enter);
  await waitFor(t.frame, /Room service stopped; reconnecting/);
  assert.equal(t.src.requests.filter((r) => r.method === 'shutdown').length, 1);
});

test('/restart asks for confirmation, then gracefully shuts the service down as the human (reconnect starts the new one)', async () => {
  const t = await setup();
  const shutdowns = () => t.src.requests.filter((r) => r.method === 'shutdown');
  await t.type('/restart');
  await t.type(K.enter);
  assert.equal(shutdowns().length, 0, 'the first Enter only asks');
  assert.match(t.frame(), /Restart the room service\?/);
  await t.type(K.enter);
  await waitFor(t.frame, /Room service stopped; reconnecting/);
  assert.equal(shutdowns().length, 1);
  assert.deepEqual(shutdowns()[0]!.params, { caller: { kind: 'human' } });

  // Editing the draft cancels a pending confirmation.
  await t.type('/restart');
  await t.type(K.enter);
  await t.type(' ');
  await t.type(K.enter);
  assert.equal(shutdowns().length, 1, 'an edited draft needs a fresh confirmation');
});
