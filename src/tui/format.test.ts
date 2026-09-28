import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN } from '../contracts/domain.js';
import { colorFor, cols, conversationLines, deliveryMark, fitLine, lineText, messageLines, sanitize, wrapText } from './format.js';
import { FakeRoomSource } from './fake-source.js';

test('wrapText wraps on words, keeps blank lines, hard-splits long words', () => {
  assert.deepEqual(wrapText('the quick brown fox', 9), ['the quick', 'brown fox']);
  assert.deepEqual(wrapText('a\n\nb', 10), ['a', ' ', 'b']);
  assert.deepEqual(wrapText('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrapText('x\r\ny', 5), ['x', 'y']);
  for (const line of wrapText('lorem ipsum dolor sit amet consectetur adipiscing', 12)) assert.ok(line.length <= 12, line);
});

test('sanitize makes terminal control sequences visible and inert', () => {
  const spoof = 'ok\u001B[2K\u001B[1A\r09:12 Kevin → all\u0007‮evil';
  const clean = sanitize(spoof);
  assert.doesNotMatch(clean, /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮]/);
  assert.match(clean, /␛\[2K/);
  const lines = wrapText('a\u001Bb', 20);
  assert.deepEqual(lines, ['a␛b']);
});

test('wrapping measures terminal columns: wide characters never overflow a line', () => {
  for (const line of wrapText('漢字漢字漢字漢字漢字 ✅✅✅✅✅✅ mixed 漢字text', 8)) assert.ok(cols(line) <= 8, `${line} = ${cols(line)} cols`);
  assert.equal(cols(lineText(fitLine([{ text: '漢字漢字漢字' }], 5))), 5);
});

test('headers drop seq/reply before recipients and never lose the sender or (declared)', () => {
  const src = new FakeRoomSource({ participants: [] });
  const m = src.post('agent_with_a_long_name', ['someone_else', 'and_another_one'], 'x');
  const declared = { ...m, message: { ...m.message, from: { ...m.message.from, identity: { mode: 'declared' as const, source: 'declared' as const } } } };
  const header = lineText(messageLines(declared, { width: 50, humanName: 'Kevin', seqById: new Map() })[0]!);
  assert.match(header, /agent_with_a_long_name \(declared\)/);
  assert.doesNotMatch(header, /#1/, 'seq dropped first');
  assert.ok(cols(header) <= 50);
});

test('delivery marks wrap onto more lines instead of hiding a state', () => {
  const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
  const src = new FakeRoomSource({ participants: names.map((name) => ({ name, harness: 'codex' as const, sessionId: name, liveness: 'online' as const, livenessCheckedAt: null, activity: 'idle' as const, pending: 0, usage: null })) });
  const m = src.post(HUMAN, 'all', 'hi', { states: { foxtrot: 'failed' } });
  const lines = messageLines(m, { width: 30, humanName: 'Kevin', seqById: new Map() }).map(lineText);
  assert.ok(lines.some((l) => /✗ foxtrot failed/.test(l)), lines.join('\n'));
  for (const l of lines) assert.ok(cols(l) <= 30, l);
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
