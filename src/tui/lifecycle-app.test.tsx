// M8 (8.4): the human's /rename and /kick in the TUI, against the fake room source.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import type { ParticipantState } from '../contracts/domain.js';
import type { Params } from '../contracts/ipc.js';
import { App } from './app.js';
import { FakeRoomSource } from './fake-source.js';
import { activityLabel } from './topbar.js';

afterEach(() => cleanup());

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const plain = (s: string | undefined) => (s ?? '').replace(/\u001B\[[0-9;]*m/g, '');
const agent = (name: string, over: Partial<ParticipantState> = {}): ParticipantState => ({ name, harness: 'codex', sessionId: name, liveness: 'online', livenessCheckedAt: null, activity: 'idle', pending: 0, usage: null, ...over });

async function setup() {
  const src = new FakeRoomSource({ participants: [agent('astra'), agent('ghost', { liveness: 'offline', pending: 3 })] });
  const calls: Array<{ method: string; params: unknown }> = [];
  const real = src.request.bind(src);
  src.request = (async (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === 'rename') return { oldName: (params as Params<'rename'>).oldName, registration: { name: (params as Params<'rename'>).newName, harness: 'codex', sessionId: 'astra' }, relabeled: 1, noticeId: 'm-n' };
    if (method === 'kick') return { status: 'executed', proposal: null, removed: { name: (params as Params<'kick'>).name, harness: 'codex', sessionId: 'ghost' }, cancelled: 3, noticeId: 'm-n', vote: 'human' };
    return real(method as never, params as never);
  }) as typeof src.request;
  const ui = render(<App source={src} humanName="Kevin" width={100} height={24} />);
  await tick();
  const type = async (s: string) => {
    ui.stdin.write(s);
    await tick();
  };
  return { src, calls, type, frame: () => plain(ui.lastFrame()) };
}

test('/rename @old @new asks the service as the human and confirms', async () => {
  const t = await setup();
  await t.type('/rename @astra luna');
  await t.type('\r');
  await tick();
  const call = t.calls.find((c) => c.method === 'rename');
  assert.ok(call, 'rename requested');
  assert.deepEqual(call.params, { caller: { kind: 'human' }, oldName: 'astra', newName: 'luna' });
  assert.match(t.frame(), /Renamed "astra" to "luna"/);
});

test('/rename with one name is a usage error, nothing sent', async () => {
  const t = await setup();
  await t.type('/rename luna');
  await t.type('\r');
  await tick();
  assert.equal(t.calls.some((c) => c.method === 'rename'), false);
  assert.match(t.frame(), /Usage: \/rename @old @new/);
});

test('/kick @agent reason removes at once as the human and confirms', async () => {
  const t = await setup();
  await t.type('/kick @ghost thread is gone');
  await t.type('\r');
  await tick();
  const call = t.calls.find((c) => c.method === 'kick');
  assert.ok(call, 'kick requested');
  assert.deepEqual(call.params, { caller: { kind: 'human' }, name: 'ghost', reason: 'thread is gone' });
  assert.match(t.frame(), /Removed "ghost" from the room \(by the human\)/);
});

test('/kick without a reason is a usage error, nothing sent', async () => {
  const t = await setup();
  await t.type('/kick ghost');
  await t.type('\r');
  await tick();
  assert.equal(t.calls.some((c) => c.method === 'kick'), false);
  assert.match(t.frame(), /Usage: \/kick @agent reason/);
});

test('an offline agent with queued deliveries is flagged for attention; without them it stays quiet', () => {
  assert.deepEqual(activityLabel(agent('ghost', { liveness: 'offline', pending: 3 })), { text: 'offline · 3 queued', color: 'yellow' });
  assert.deepEqual(activityLabel(agent('gone', { liveness: 'offline', pending: 0 })), { text: 'offline' });
});
