import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, backoffSchedule, loadConfig } from './config.js';

test('TUI tunables: defaults, env overrides, and the doubling reconnect schedule', () => {
  assert.equal(DEFAULT_CONFIG.tuiHistoryLimit, 500);
  const c = loadConfig({ ROUNDTABLE_TUI_HISTORY_LIMIT: '100', ROUNDTABLE_TUI_RECONNECT_MAX_MS: '2000' });
  assert.deepEqual([c.tuiHistoryLimit, c.tuiReconnectMaxMs], [100, 2000]);
  assert.deepEqual(backoffSchedule(250, 5000), [250, 500, 1000, 2000, 4000, 5000]);
  assert.deepEqual(backoffSchedule(1000, 1000), [1000]);
  assert.throws(() => loadConfig({ ROUNDTABLE_TUI_HISTORY_LIMIT: 'lots' }), /ROUNDTABLE_TUI_HISTORY_LIMIT/);
});

test('defaults apply when no env overrides are set', () => {
  assert.deepEqual(loadConfig({}), DEFAULT_CONFIG);
  assert.equal(DEFAULT_CONFIG.codexMaxEnvelopeChars, 24_000);
});

test('env overrides numbers and strings', () => {
  const c = loadConfig({ ROUNDTABLE_CODEX_MAX_ENVELOPE_CHARS: '1000', ROUNDTABLE_HUMAN_NAME: 'K', ROUNDTABLE_ROOT: 'X:/r' });
  assert.equal(c.codexMaxEnvelopeChars, 1000);
  assert.equal(c.humanDisplayName, 'K');
  assert.equal(c.roomRoot, 'X:/r');
});

test('context limits: defaults include Kevin-provided Claude limit; env merges and validates', () => {
  assert.equal(loadConfig({}).contextLimits['claude-opus-5-5'], 1_000_000);
  const c = loadConfig({ ROUNDTABLE_CONTEXT_LIMITS: 'gpt-x=400000, claude-opus-5-5=500000' });
  assert.equal(c.contextLimits['gpt-x'], 400_000);
  assert.equal(c.contextLimits['claude-opus-5-5'], 500_000);
  assert.throws(() => loadConfig({ ROUNDTABLE_CONTEXT_LIMITS: 'bad' }), /model=tokens/);
  assert.throws(() => loadConfig({ ROUNDTABLE_CONTEXT_LIMITS: 'm=0' }), /model=tokens/);
});

test('invalid numeric overrides throw instead of being ignored', () => {
  assert.throws(() => loadConfig({ ROUNDTABLE_READ_PAGE_SIZE: 'lots' }), /positive decimal integer/);
  assert.throws(() => loadConfig({ ROUNDTABLE_READ_PAGE_SIZE: '-1' }), /positive decimal integer/);
  for (const odd of ['1e3', '0x10', ' 5', '5 ', '0']) {
    assert.throws(() => loadConfig({ ROUNDTABLE_READ_PAGE_SIZE: odd }), /positive decimal integer/, odd);
  }
  const c = loadConfig({ ROUNDTABLE_REGISTRY_LOCK_TIMEOUT_MS: '250', ROUNDTABLE_REGISTRY_LOCK_POLL_MS: '5' });
  assert.equal(c.registryLockTimeoutMs, 250);
  assert.equal(c.registryLockPollMs, 5);
  assert.equal(loadConfig({ ROUNDTABLE_KICK_PROPOSAL_TTL_MS: '2000' }).kickProposalTtlMs, 2000);
});

test('TD-0023: the shutdown grace is a tunable (ROUNDTABLE_MONITOR_STOP_GRACE_MS)', () => {
  assert.equal(loadConfig({}).monitorStopGraceMs, 500);
  assert.equal(loadConfig({ ROUNDTABLE_MONITOR_STOP_GRACE_MS: '5000' }).monitorStopGraceMs, 5000);
  assert.throws(() => loadConfig({ ROUNDTABLE_MONITOR_STOP_GRACE_MS: 'soon' }), /ROUNDTABLE_MONITOR_STOP_GRACE_MS/);
});
