import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELIVERY_STATES,
  HUMAN,
  isHarness,
  isSettledDeliveryState,
  isValidParticipantName,
} from './domain.js';

test('isHarness accepts only known harnesses', () => {
  assert.equal(isHarness('claude'), true);
  assert.equal(isHarness('codex'), true);
  assert.equal(isHarness('agy'), false);
  assert.equal(isHarness(undefined), false);
});

test('participant names: lowercase slug, 1-32 chars, reserved names rejected', () => {
  for (const ok of ['astra', 'claude', 'codex_reviewer', 'claude-builder2', 'a']) {
    assert.equal(isValidParticipantName(ok), true, ok);
  }
  for (const bad of ['', 'Astra', '1agent', 'has space', 'a'.repeat(33), HUMAN, 'system', 'all', '@astra']) {
    assert.equal(isValidParticipantName(bad), false, bad);
  }
});

test('only queued is unsettled; every other state needs explicit action', () => {
  assert.deepEqual(
    DELIVERY_STATES.filter((s) => !isSettledDeliveryState(s)),
    ['queued'],
  );
});
