import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RoomMessage } from '../../contracts/domain.js';
import { buildEnvelope } from './envelope.js';

const message = (body: string): RoomMessage =>
  ({ id: 'm-1', seq: 1, createdAt: '2026-09-28T10:00:00Z', from: { name: 'astra', kind: 'agent', identity: { mode: 'verified', source: 'codex-env' } }, to: ['claude'], addressing: 'direct', replyTo: null, kind: 'chat', body, clientMessageId: null }) as unknown as RoomMessage;

test('without a snapshot the envelope is unchanged and reports no token', () => {
  const e = buildEnvelope('/r', message('hi'), 'claude', 10_000);
  assert.equal(e.snapshot, false);
  assert.doesNotMatch(e.text, /snapshot/);
  assert.match(e.text, /Reply via room_send\(\{reply_to:"m-1",text:"\.\.\."\}\) or room reply m-1 --file <path>\./);
});

test('a full envelope carries the token, says it covers only this message, and puts it in both reply hints', () => {
  const e = buildEnvelope('/r', message('hi'), 'claude', 10_000, { snapshot: 'tok_ABC-123' });
  assert.equal(e.referenced, false);
  assert.equal(e.snapshot, true);
  assert.match(e.text, /\nsnapshot: tok_ABC-123 \(covers this message only\)\n/);
  assert.match(e.text, /room_send\(\{reply_to:"m-1",snapshot:"tok_ABC-123",text:"\.\.\."\}\)/);
  assert.match(e.text, /room reply m-1 --snapshot tok_ABC-123 --file <path>/);
  assert.match(e.text, /comes back NOT SENT/);
});

test('when the token does not fit, the full body wins and the token is reported unused', () => {
  const body = 'x'.repeat(200);
  const plain = buildEnvelope('/r', message(body), 'claude', 10_000).text.length;
  const e = buildEnvelope('/r', message(body), 'claude', plain, { snapshot: 'tok' });
  assert.equal(e.referenced, false);
  assert.equal(e.snapshot, false);
  assert.doesNotMatch(e.text, /tok/);
});

test('a referenced envelope never carries the token', () => {
  const e = buildEnvelope('/r', message('y'.repeat(5000)), 'claude', 1000, { snapshot: 'tok' });
  assert.equal(e.referenced, true);
  assert.equal(e.snapshot, false);
  assert.doesNotMatch(e.text, /snapshot: /);
  assert.match(e.text, /Referenced content: this is only a preview\. Review the whole message with room_inbox/);
  assert.match(e.text, /it is not covered, and a reply will come back NOT SENT/);
  assert.doesNotMatch(e.text, /room_read/);
});

test('malformed tokens are refused rather than embedded', () => {
  for (const bad of ['', 'a'.repeat(41), 'has space', 'quo"te', 'new\nline', 'tick`', 'ünicode']) {
    assert.throws(() => buildEnvelope('/r', message('hi'), 'claude', 10_000, { snapshot: bad }), { code: 'internal' }, JSON.stringify(bad));
  }
});
