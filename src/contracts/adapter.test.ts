import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSubmitResult, type DeliveryAdapter, type SubmitResult } from './adapter.js';

test('isSubmitResult accepts each well-formed outcome', () => {
  const ok: SubmitResult[] = [
    { status: 'submitted', evidence: { kind: 'codex-queue', nativeId: 'q1' } },
    { status: 'submitted', evidence: { kind: 'claude-pipe-write', pid: 42 } },
    { status: 'unavailable', reason: 'offline', detail: 'no live session' },
    { status: 'unavailable', reason: 'rebind_needed', detail: 'pid reused' },
    { status: 'failed', error: { code: 'internal', message: 'connect refused' } },
    { status: 'uncertain', error: { code: 'internal', message: 'pipe closed after write' } },
  ];
  for (const r of ok) assert.equal(isSubmitResult(r), true, JSON.stringify(r));
});

test('isSubmitResult rejects malformed adapter output', () => {
  for (const bad of [null, {}, { status: 'submitted' }, { status: 'unavailable', reason: 'gone', detail: '' }, { status: 'failed' }, { status: 'done' }]) {
    assert.equal(isSubmitResult(bad), false, JSON.stringify(bad));
  }
});

test('a fake adapter satisfies the DeliveryAdapter contract', async () => {
  const fake: DeliveryAdapter = {
    harness: 'codex',
    maxEnvelopeChars: 100,
    submit: async () => ({ status: 'submitted', evidence: { kind: 'codex-queue', nativeId: null } }),
    probe: async () => ({ liveness: 'unknown', activity: 'unknown' }),
  };
  const r = await fake.submit({ target: { harness: 'codex', sessionId: 't' }, envelope: 'e', messageId: 'm', recipient: 'astra', attempt: 1 });
  assert.equal(isSubmitResult(r), true);
});
