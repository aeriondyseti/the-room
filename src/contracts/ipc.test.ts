import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FrameDecoder,
  FrameError,
  MAX_FRAME_BYTES,
  METHODS,
  PROTOCOL_VERSION,
  encodeFrame,
  isMethod,
  parseFrame,
  type RequestFrame,
} from './ipc.js';

const req: RequestFrame<'send'> = {
  v: PROTOCOL_VERSION,
  type: 'request',
  id: 'r1',
  method: 'send',
  params: { caller: { kind: 'human' }, to: null, body: 'multi\nline "quotes" `ticks` $HOME ✓' },
};

test('encode/parse round-trips a request with awkward text exactly', () => {
  const line = encodeFrame(req);
  assert.ok(line.endsWith('\n'));
  assert.equal(line.indexOf('\n'), line.length - 1, 'embedded newlines are escaped');
  assert.deepEqual(parseFrame(line.trimEnd()), req);
});

test('decoder reassembles frames split across chunks and keeps partials', () => {
  const a = encodeFrame(req);
  const b = encodeFrame({ v: 1, type: 'event', event: { type: 'service.stopping', reason: 'test' } });
  const joined = a + b;
  const d = new FrameDecoder();
  const out = [...d.push(joined.slice(0, 7)), ...d.push(joined.slice(7, a.length + 3))];
  assert.equal(out.length, 1);
  assert.equal(d.hasPartial, true);
  const rest = d.push(joined.slice(a.length + 3));
  assert.equal(rest.length, 1);
  assert.equal(rest[0]?.type, 'event');
  assert.equal(d.hasPartial, false);
});

test('decoder rejects malformed and oversized frames loudly', () => {
  assert.throws(() => new FrameDecoder().push('not json\n'), FrameError);
  assert.throws(() => parseFrame(JSON.stringify({ v: 2, type: 'event', event: { type: 'x' } })), /protocol version/);
  assert.throws(() => parseFrame(JSON.stringify({ v: 1, type: 'request', id: 'x', method: 'nope', params: {} })), /malformed request/);
  assert.throws(() => parseFrame(JSON.stringify({ v: 1, type: 'response', id: 'x', ok: false })), /malformed error/);
  assert.throws(() => parseFrame(JSON.stringify({ v: 1, type: 'bogus' })), /unknown frame type/);
  assert.throws(() => new FrameDecoder().push('x'.repeat(MAX_FRAME_BYTES + 1)), /exceeds/);
});

test('frame errors are classified and keep frames decoded before the bad line', () => {
  const good = encodeFrame(req);
  try {
    new FrameDecoder().push(good + 'garbage\n' + good);
    assert.fail('expected FrameError');
  } catch (err) {
    assert.ok(err instanceof FrameError);
    assert.equal(err.kind, 'malformed');
    assert.equal(err.frames.length, 1, 'the valid frame before the bad line is preserved');
  }
  const kindOf = (line: string) => {
    try {
      parseFrame(line);
      return 'ok';
    } catch (err) {
      return err instanceof FrameError ? err.kind : 'other';
    }
  };
  assert.equal(kindOf(JSON.stringify({ v: 9, type: 'event', event: { type: 'x' } })), 'unsupported_version');
  assert.equal(kindOf(JSON.stringify({ v: 1, type: 'response', id: 'x', ok: true })), 'malformed', 'success needs result');
  assert.equal(kindOf(JSON.stringify({ v: 1, type: 'response', id: 'x', ok: true, result: null })), 'ok');
  assert.equal(kindOf('[1,2]'), 'malformed');
});

test('unsupported_version errors carry the request id for a correlated response', () => {
  try {
    parseFrame(JSON.stringify({ v: 2, type: 'request', id: 'req-7', method: 'hello', params: {} }));
    assert.fail('expected FrameError');
  } catch (err) {
    assert.ok(err instanceof FrameError);
    assert.equal(err.kind, 'unsupported_version');
    assert.equal(err.requestId, 'req-7');
  }
});

test('method list matches the request map and guards unknown methods', () => {
  assert.equal(new Set(METHODS).size, METHODS.length);
  assert.equal(isMethod('send'), true);
  assert.equal(isMethod('__proto__'), false);
});
