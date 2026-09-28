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
  assert.throws(() => loadConfig({ ROOM_READ_PAGE_SIZE: 'lots' }), /positive decimal integer/);
  assert.throws(() => loadConfig({ ROOM_READ_PAGE_SIZE: '-1' }), /positive decimal integer/);
  for (const odd of ['1e3', '0x10', ' 5', '5 ', '0']) {
    assert.throws(() => loadConfig({ ROOM_READ_PAGE_SIZE: odd }), /positive decimal integer/, odd);
  }
  const c = loadConfig({ ROOM_REGISTRY_LOCK_TIMEOUT_MS: '250', ROOM_REGISTRY_LOCK_POLL_MS: '5' });
  assert.equal(c.registryLockTimeoutMs, 250);
  assert.equal(c.registryLockPollMs, 5);
});
