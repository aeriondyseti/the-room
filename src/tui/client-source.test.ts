import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RoomEvent } from '../contracts/ipc.js';
import { ClientRoomSource, type RoomConnection } from './client-source.js';
import type { ConnectionStatus } from './source.js';

class FakeConnection implements RoomConnection {
  events = new Set<(e: RoomEvent) => void>();
  drops = new Set<(reason: Error) => void>();
  closed = false;
  async request(): Promise<never> {
    return { ok: true } as never;
  }
  onEvent(l: (e: RoomEvent) => void) {
    this.events.add(l);
    return () => this.events.delete(l);
  }
  onDisconnect(l: (reason: Error) => void) {
    this.drops.add(l);
    return () => this.drops.delete(l);
  }
  close() {
    this.closed = true;
  }
  drop(message: string) {
    for (const l of this.drops) l(new Error(message));
  }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('connects, forwards events, and reconnects after a disconnect', async () => {
  const conns: FakeConnection[] = [];
  const src = new ClientRoomSource({ roomRoot: 'X:/room', backoffMs: [5], connect: async () => { const c = new FakeConnection(); conns.push(c); return c; } });
  const statuses: ConnectionStatus[] = [];
  src.onStatus((s) => statuses.push(s));
  const events: RoomEvent[] = [];
  src.onEvent((e) => events.push(e));
  src.start();
  await tick();
  assert.equal(src.status().state, 'connected');
  for (const l of conns[0]!.events) l({ type: 'service.stopping', reason: 'x' });
  assert.equal(events.length, 1);

  conns[0]!.drop('pipe closed');
  assert.deepEqual(src.status(), { state: 'reconnecting', detail: 'pipe closed' });
  await assert.rejects(src.request('who', {}), /Not connected/);
  await tick(40);
  assert.equal(conns.length, 2);
  assert.equal(src.status().state, 'connected');
  assert.deepEqual(statuses.map((s) => s.state), ['connected', 'reconnecting', 'connected']);
  src.close();
  assert.equal(conns[1]!.closed, true);
});

test('repeated connect failures become "disconnected" but keep retrying', async () => {
  let attempts = 0;
  const src = new ClientRoomSource({
    roomRoot: 'X:/room',
    backoffMs: [2],
    failuresBeforeDisconnected: 2,
    connect: async () => {
      attempts++;
      if (attempts < 4) throw new Error('ENOENT');
      return new FakeConnection();
    },
  });
  const states: string[] = [];
  src.onStatus((s) => states.push(s.state));
  src.start();
  await tick(60);
  assert.deepEqual(states, ['reconnecting', 'disconnected', 'disconnected', 'connected']);
  src.close();
});
