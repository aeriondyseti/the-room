import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, loadConfig } from './config.js';

test('defaults apply when no env overrides are set', () => {
  assert.deepEqual(loadConfig({}), DEFAULT_CONFIG);
  assert.equal(DEFAULT_CONFIG.codexMaxEnvelopeChars, 24_000);
});

test('env overrides numbers and strings', () => {
  const c = loadConfig({ ROOM_CODEX_MAX_ENVELOPE_CHARS: '1000', ROOM_HUMAN_NAME: 'K', ROOM_ROOT: 'X:/r' });
  assert.equal(c.codexMaxEnvelopeChars, 1000);
  assert.equal(c.humanDisplayName, 'K');
  assert.equal(c.roomRoot, 'X:/r');
});

test('invalid numeric overrides throw instead of being ignored', () => {
  assert.throws(() => loadConfig({ ROOM_READ_PAGE_SIZE: 'lots' }), /positive integer/);
  assert.throws(() => loadConfig({ ROOM_READ_PAGE_SIZE: '-1' }), /positive integer/);
});
