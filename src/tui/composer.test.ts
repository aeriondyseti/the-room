import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_HISTORY,
  addressee,
  backspace,
  completeMention,
  del,
  historyDown,
  historyPush,
  historyUp,
  insert,
  left,
  parseComposer,
  parseRetryArgs,
  right,
} from './composer.js';

const names = ['astra', 'claude', 'codex_reviewer'];

test('plain text goes to everyone; leading @names address; @all is explicit broadcast', () => {
  assert.deepEqual(parseComposer('hello team', names), { kind: 'message', to: null, body: 'hello team' });
  assert.deepEqual(parseComposer('@astra @claude please sync', names), { kind: 'message', to: ['astra', 'claude'], body: 'please sync' });
  assert.deepEqual(parseComposer('@all heads up', names), { kind: 'message', to: null, body: 'heads up' });
  assert.deepEqual(parseComposer('ping @astra later', names), { kind: 'message', to: null, body: 'ping @astra later' }, 'mid-text mentions are just text');
  assert.deepEqual(parseComposer('@astra\nline one\nline two', names), { kind: 'message', to: ['astra'], body: 'line one\nline two' });
});

test('addressing mistakes are errors with a helpful suggestion', () => {
  const typo = parseComposer('@astr hi', names);
  assert.equal(typo.kind, 'error');
  assert.match(typo.kind === 'error' ? typo.message : '', /Did you mean @astra\?/);
  assert.match((parseComposer('@zzzz hi', names) as { message: string }).message, /\/who lists participants/);
  assert.equal(parseComposer('@astra', names).kind, 'error');
  assert.equal(parseComposer('@all @astra hi', names).kind, 'error');
  assert.equal(parseComposer('   ', names).kind, 'empty');
});

test('commands parse with arguments; unknown commands are errors', () => {
  assert.deepEqual(parseComposer('/pause wrap up please', names), { kind: 'command', command: 'pause', args: 'wrap up please' });
  assert.deepEqual(parseComposer('/RESUME', names), { kind: 'command', command: 'resume', args: '' });
  assert.equal(parseComposer('/frobnicate', names).kind, 'error');
  assert.deepEqual(parseRetryArgs('#12 @astra'), { seq: 12, recipient: 'astra' });
  assert.deepEqual(parseRetryArgs('7'), { seq: 7, recipient: null });
  assert.ok('error' in parseRetryArgs('twelve'));
});

test('addressee drives the To: indicator', () => {
  assert.deepEqual(addressee('', names), { label: 'everyone', valid: true });
  assert.deepEqual(addressee('@astra @claude hi', names), { label: 'astra, claude', valid: true });
  assert.deepEqual(addressee('@nobody hi', names), { label: 'nobody', valid: false });
  assert.deepEqual(addressee('/pause', names), { label: 'command', valid: true });
});

test('Tab completes @partial names and cycles through matches', () => {
  assert.deepEqual(completeMention('@as', 3, names), { text: '@astra ', cursor: 7 });
  const first = completeMention('hi @c', 5, names, 0);
  const second = completeMention('hi @c', 5, names, 1);
  assert.deepEqual([first?.text, second?.text], ['hi @claude ', 'hi @codex_reviewer ']);
  assert.equal(completeMention('no mention', 10, names), null);
});

test('editing respects surrogate pairs', () => {
  let d = insert({ text: '', cursor: 0 }, 'a😀b');
  d = left(d); // before b
  d = backspace(d); // removes the whole emoji
  assert.deepEqual(d, { text: 'ab', cursor: 1 });
  d = right(left(d));
  assert.equal(d.cursor, 1);
  assert.deepEqual(del({ text: '😀x', cursor: 0 }), { text: 'x', cursor: 0 });
});

test('history recalls sent drafts and restores the unsent one', () => {
  let h = historyPush(historyPush(EMPTY_HISTORY, 'first'), 'second');
  const up1 = historyUp(h, 'typing…')!;
  assert.equal(up1.text, 'second');
  const up2 = historyUp(up1.history, up1.text)!;
  assert.equal(up2.text, 'first');
  assert.equal(historyUp(up2.history, up2.text), null);
  const down1 = historyDown(up2.history)!;
  assert.equal(down1.text, 'second');
  const down2 = historyDown(down1.history)!;
  assert.equal(down2.text, 'typing…', 'the unsent draft comes back');
  h = historyPush(h, 'first');
  assert.deepEqual(h.entries, ['second', 'first'], 'duplicates move to the newest position');
});
