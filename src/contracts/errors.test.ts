import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_HINTS, RoomError, fromErrorInfo, isErrorCode, toErrorInfo } from './errors.js';

test('every error code has a non-empty hint', () => {
  for (const [code, hint] of Object.entries(ERROR_HINTS)) {
    assert.ok(hint.length > 10, `hint for ${code}`);
  }
});

test('RoomError carries code, default hint, and serializes to ErrorInfo', () => {
  const e = new RoomError('unknown_recipient', 'no participant "bob"');
  assert.equal(e.code, 'unknown_recipient');
  assert.equal(e.hint, ERROR_HINTS.unknown_recipient);
  assert.deepEqual(e.toInfo(), { code: 'unknown_recipient', message: 'no participant "bob"', hint: ERROR_HINTS.unknown_recipient });
  assert.equal(new RoomError('internal', 'x', 'custom').hint, 'custom');
});

test('toErrorInfo maps foreign errors to internal without leaking stacks', () => {
  const info = toErrorInfo(new TypeError('boom'));
  assert.equal(info.code, 'internal');
  assert.equal(info.message, 'boom');
  assert.ok(!JSON.stringify(info).includes('at '), 'no stack frames');
  assert.equal(toErrorInfo('plain').message, 'plain');
});

test('fromErrorInfo round-trips known codes and downgrades unknown ones', () => {
  const round = fromErrorInfo(new RoomError('dedup_conflict', 'reused').toInfo());
  assert.equal(round.code, 'dedup_conflict');
  assert.equal(fromErrorInfo({ code: 'made_up', message: 'm' }).code, 'internal');
  assert.equal(isErrorCode('not_found'), true);
  assert.equal(isErrorCode('toString'), false);
});
