// 7.6: /settings end to end in the TUI against the fake room source.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import type { ParticipantState } from '../contracts/domain.js';
import { RoomError } from '../contracts/errors.js';
import type { Params } from '../contracts/ipc.js';
import { App } from './app.js';
import { FakeRoomSource } from './fake-source.js';

afterEach(() => cleanup());

const K = { enter: '\r', esc: '\u001B', right: '\u001B[C', left: '\u001B[D', down: '\u001B[B' };
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const plain = (s: string | undefined) => (s ?? '').replace(/\u001B\[[0-9;]*m/g, '');
const agent = (name: string): ParticipantState => ({ name, harness: 'codex', sessionId: name, liveness: 'online', livenessCheckedAt: null, activity: 'idle', pending: 0, usage: null });

async function setup() {
  const src = new FakeRoomSource({ participants: [agent('astra')] });
  const ui = render(<App source={src} humanName="Kevin" width={100} height={30} />);
  await tick();
  const type = async (s: string) => {
    ui.stdin.write(s);
    await tick();
  };
  const updates = () => src.requests.filter((r) => r.method === 'settings_update').map((r) => r.params as Params<'settings_update'>);
  return { src, ui, type, updates, frame: () => plain(ui.lastFrame()) };
}
const open = async (t: Awaited<ReturnType<typeof setup>>) => {
  await t.type('/settings');
  await t.type(K.enter);
  await tick();
};

test('/settings opens the panel with the current values', async () => {
  const t = await setup();
  await open(t);
  assert.match(t.frame(), /ROOM SETTINGS/);
  assert.match(t.frame(), /Hold before delivery\s+‹ 500 ms ›\s+default/);
  assert.match(t.frame(), /Batch held messages\s+on/);
  assert.match(t.frame(), /Longest batch hold\s+2s/);
});

test('changing a value and pressing Enter saves only that key, closes, and confirms', async () => {
  const t = await setup();
  await open(t);
  await t.type(K.right);
  await t.type(K.right);
  assert.match(t.frame(), /‹ 700 ms ›\s+unsaved/);
  await t.type(K.enter);
  await tick();
  assert.deepEqual(t.updates().map((u) => u.patch), [{ deliveryHoldMs: 700 }]);
  assert.deepEqual(t.updates()[0]!.caller, { kind: 'human' });
  assert.doesNotMatch(t.frame(), /ROOM SETTINGS/);
  assert.match(t.frame(), /Settings saved; they apply to messages sent from now on/);
  await open(t);
  assert.match(t.frame(), /Hold before delivery\s+‹ 700 ms ›\s+changed · default 500 ms/);
});

test('Esc discards edits without saving', async () => {
  const t = await setup();
  await open(t);
  await t.type(K.down);
  await t.type(K.right);
  await t.type(K.esc);
  assert.equal(t.updates().length, 0);
  assert.doesNotMatch(t.frame(), /ROOM SETTINGS/);
  assert.match(t.frame(), /edits discarded/);
});

test('a refused save keeps the panel open with the reason', async () => {
  const t = await setup();
  const real = t.src.request.bind(t.src);
  t.src.request = (async (method: string, params: unknown) => {
    if (method === 'settings_update') throw new RoomError('bad_request', 'hold too long', 'Use at most 60000 ms.');
    return real(method as never, params as never);
  }) as typeof t.src.request;
  await open(t);
  await t.type(K.right);
  await t.type(K.enter);
  await tick();
  assert.match(t.frame(), /ROOM SETTINGS/);
  assert.match(t.frame(), /Not saved: hold too long — Use at most 60000 ms\./);
});

test('keys typed while the panel is open never reach the composer', async () => {
  const t = await setup();
  await open(t);
  await t.type('r');
  await t.type('hello');
  await t.type(K.esc);
  assert.doesNotMatch(t.frame(), /hello/);
});

test('Esc during an in-flight save is ignored until the save settles (no false "discarded")', async () => {
  const t = await setup();
  const real = t.src.request.bind(t.src);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  t.src.request = (async (method: string, params: unknown) => {
    if (method === 'settings_update') await gate;
    return real(method as never, params as never);
  }) as typeof t.src.request;
  await open(t);
  await t.type(K.right);
  await t.type(K.enter);
  await t.type(K.esc);
  assert.match(t.frame(), /Saving…/);
  assert.doesNotMatch(t.frame(), /discarded/);
  release();
  await tick(80);
  assert.match(t.frame(), /Settings saved/);
  assert.doesNotMatch(t.frame(), /ROOM SETTINGS/);
});

test('fixing a draft problem clears its error', async () => {
  const t = await setup();
  await open(t);
  // Push the hold above the 2s batch cap, try to save, then bring it back down.
  for (let i = 0; i < 16; i++) await t.type(K.right);
  await t.type(K.enter);
  assert.match(t.frame(), /must be at least the hold/);
  for (let i = 0; i < 16; i++) await t.type(K.left);
  assert.doesNotMatch(t.frame(), /must be at least the hold/);
});
test('with a broken settings file, Enter (no edits) saves the repair and confirms it', async () => {
  const t = await setup();
  t.src.settings = { ...t.src.settings, problem: { source: 'file', code: 'invalid_json', message: 'bad', fallback: 'defaults' } } as typeof t.src.settings;
  await open(t);
  assert.match(t.frame(), /can't be used \(invalid_json\)/);
  await t.type(K.enter);
  await tick();
  assert.deepEqual(t.updates().map((u) => u.patch), [{}]);
  assert.match(t.frame(), /Settings file repaired and saved/);
  assert.doesNotMatch(t.frame(), /ROOM SETTINGS/);
});