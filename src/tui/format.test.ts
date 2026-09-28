import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN } from '../contracts/domain.js';
import { colorFor, conversationLines, deliveryMark, fitLine, lineText, messageLines, wrapText } from './format.js';
import { FakeRoomSource } from './fake-source.js';

test('wrapText wraps on words, keeps blank lines, hard-splits long words', () => {
  assert.deepEqual(wrapText('the quick brown fox', 9), ['the quick', 'brown fox']);
  assert.deepEqual(wrapText('a\n\nb', 10), ['a', ' ', 'b']);
  assert.deepEqual(wrapText('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrapText('x\r\ny', 5), ['x', 'y']);
  for (const line of wrapText('lorem ipsum dolor sit amet consectetur adipiscing', 12)) assert.ok(line.length <= 12, line);
});

test('delivery marks: held and waiting explain a queued delivery; every state has a distinct glyph', () => {
  assert.equal(deliveryMark({ state: 'queued', held: true, waiting: null }).label, 'held');
  assert.equal(deliveryMark({ state: 'queued', held: false, waiting: 'offline' }).label, 'offline');
  assert.equal(deliveryMark({ state: 'queued', held: false, waiting: 'rebind_needed' }).label, 'rebind needed');
  const glyphs = (['queued', 'submitted', 'replied', 'failed', 'uncertain'] as const).map((s) => deliveryMark({ state: s, held: false, waiting: null }).glyph);
  assert.equal(new Set(glyphs).size, glyphs.length);
});

test('participant colors are stable and the human is always yellow', () => {
  assert.equal(colorFor('astra'), colorFor('astra'));
  assert.equal(colorFor(HUMAN), 'yellow');
});

test('fitLine never exceeds the width and marks truncation', () => {
  const line = fitLine([{ text: 'hello ' }, { text: 'wonderful world' }], 10);
  assert.equal(lineText(line).length, 10);
  assert.ok(lineText(line).endsWith('…'));
});

test('message lines: header names, broadcast wording, reply ref, body within width, delivery row', () => {
  const src = new FakeRoomSource({
    participants: [
      { name: 'astra', harness: 'codex', sessionId: 'a', liveness: 'online', livenessCheckedAt: null, activity: 'idle', pending: 0, usage: null },
    ],
  });
  const first = src.post(HUMAN, 'all', 'hello team', { states: { astra: 'replied' } });
  const reply = src.post('astra', [HUMAN], 'x '.repeat(60).trim(), { replyTo: first.message.id });
  const ctx = { width: 40, humanName: 'Kevin', seqById: new Map([[first.message.id, 1], [reply.message.id, 2]]) };
  const a = messageLines(first, ctx).map(lineText);
  assert.match(a[0]!, /Kevin → everyone/);
  assert.match(a.at(-1)!, /✓ astra/);
  const b = messageLines(reply, ctx).map(lineText);
  assert.match(b[0]!, /astra → Kevin {2}↩ #1 {2}#2/);
  for (const l of b) assert.ok(l.length <= 40, `too wide: ${l}`);
  const all = conversationLines([first, reply], ctx).map(lineText);
  assert.ok(all.includes(' '), 'blank separator between messages');
});

test('stop requests and declared identities are visibly marked', () => {
  const src = new FakeRoomSource({ participants: [] });
  const stop = src.post(HUMAN, 'all', 'Please stop.', { kind: 'stop_request' });
  assert.match(lineText(messageLines(stop, { width: 80, humanName: 'Kevin', seqById: new Map() })[0]!), /STOP REQUEST/);
  const declared = { ...stop, message: { ...stop.message, kind: 'chat' as const, from: { name: 'bob', kind: 'agent' as const, identity: { mode: 'declared' as const, source: 'declared' as const } } } };
  assert.match(lineText(messageLines(declared, { width: 80, humanName: 'Kevin', seqById: new Map() })[0]!), /bob \(declared\)/);
});
