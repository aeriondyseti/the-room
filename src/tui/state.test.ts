import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN } from '../contracts/domain.js';
import { FakeRoomSource } from './fake-source.js';
import { INITIAL_VIEW, reduceView } from './state.js';

const participant = { name: 'astra', harness: 'codex' as const, sessionId: 's', liveness: 'online' as const, livenessCheckedAt: null, activity: 'idle' as const, pending: 0, usage: null };

test('snapshot merges with live events without duplicates and keeps seq order', () => {
  const src = new FakeRoomSource({ participants: [participant] });
  const m1 = src.post(HUMAN, 'all', 'one');
  const m2 = src.post('astra', [HUMAN], 'two');
  // An event arrives before the snapshot (race on connect) — then the snapshot contains it too.
  let v = reduceView(INITIAL_VIEW, { type: 'event', event: { type: 'message.created', ...m2 } });
  v = reduceView(v, { type: 'snapshot', items: [m1, m2], participants: [participant], room: { paused: false, pausedAt: null, stopRequestId: null } });
  assert.deepEqual(v.items.map((i) => i.message.seq), [1, 2]);
  assert.equal(v.loaded, true);
  assert.equal(v.lastSeq, 2);
  v = reduceView(v, { type: 'event', event: { type: 'message.created', ...m1 } });
  assert.equal(v.items.length, 2, 'duplicate message.created ignored');
});

test('delivery, participant and room events update the view', () => {
  const src = new FakeRoomSource({ participants: [participant] });
  const m = src.post(HUMAN, 'all', 'hi', { states: { astra: 'queued' } });
  let v = reduceView(INITIAL_VIEW, { type: 'snapshot', items: [m], participants: [participant], room: { paused: false, pausedAt: null, stopRequestId: null } });
  v = reduceView(v, { type: 'event', event: { type: 'delivery.updated', delivery: { ...m.deliveries[0]!, state: 'submitted' } } });
  assert.equal(v.items[0]?.deliveries[0]?.state, 'submitted');
  v = reduceView(v, { type: 'event', event: { type: 'participant.updated', participant: { ...participant, name: 'claude', harness: 'claude' } } });
  assert.deepEqual(v.participants.map((p) => p.name), ['astra', 'claude']);
  v = reduceView(v, { type: 'event', event: { type: 'participant.removed', name: 'astra' } });
  assert.deepEqual(v.participants.map((p) => p.name), ['claude']);
  v = reduceView(v, { type: 'event', event: { type: 'room.updated', room: { paused: true, pausedAt: 'x', stopRequestId: 'm9' } } });
  assert.equal(v.room.paused, true);
  v = reduceView(v, { type: 'event', event: { type: 'service.stopping', reason: 'shutdown requested' } });
  assert.match(v.notice ?? '', /shutdown requested/);
});
