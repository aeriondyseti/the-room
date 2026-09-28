// ROADMAP 5.1: theming, code blocks, first-run/empty states, runtime context in /detail, layout tunables.
import './force-color.js'; // first: colour assertions must not depend on the caller's TTY
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { HUMAN, type ParticipantState } from '../contracts/domain.js';
import { App } from './app.js';
import { detailLines } from './detail.js';
import { FakeRoomSource } from './fake-source.js';
import { bodyLines, lineText } from './format.js';
import { COLOR_THEME, MONO_THEME, themeFrom } from './theme.js';
import { demoSource } from './demo.js';

afterEach(() => cleanup());
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const plain = (s: string | undefined) => (s ?? '').replace(/\u001B\[[0-9;]*m/g, '');
const agent = (name: string, over: Partial<ParticipantState> = {}): ParticipantState => ({
  name, harness: 'codex', sessionId: name, liveness: 'online', livenessCheckedAt: null, activity: 'idle', pending: 0, usage: null, ...over,
});

test('themeFrom: NO_COLOR (non-empty), --no-color and TERM=dumb select monochrome; otherwise colour', () => {
  assert.equal(themeFrom({}, []).mono, false);
  assert.equal(themeFrom({ NO_COLOR: '1' }, []).mono, true);
  assert.equal(themeFrom({ NO_COLOR: '' }, []).mono, false, 'an empty NO_COLOR does not count (no-color.org)');
  assert.equal(themeFrom({}, ['--no-color']).mono, true);
  assert.equal(themeFrom({ TERM: 'dumb' }, []).mono, true);
  assert.equal(MONO_THEME.color('red'), undefined);
  assert.equal(COLOR_THEME.color('red'), 'red');
});

test('monochrome: no colour escapes at all, but the cursor (inverse), states and high usage stay visible', async () => {
  const ui = render(<App source={demoSource()} humanName="Kevin" width={110} height={28} theme={MONO_THEME} />);
  await tick();
  const frame = ui.lastFrame() ?? '';
  // Foreground/background colour SGR codes: 30–37, 39, 40–47, 49, 90–97, 100–107, and 38;/48; extended colours.
  const colourCodes = [...frame.matchAll(/\u001B\[([0-9;]*)m/g)].flatMap((m) => m[1]!.split(';').map(Number)).filter((n) => (n >= 30 && n <= 49) || (n >= 90 && n <= 107));
  assert.deepEqual(colourCodes, [], 'no colour codes in monochrome');
  assert.match(frame, /\u001B\[7m/, 'inverse (the composer cursor) survives');
  const text = plain(frame);
  assert.match(text, /ctx .*88\.0%!/, 'high usage is marked without colour');
  assert.match(text, /\? astra uncertain/, 'delivery states keep glyph + word');
  assert.match(text, /○ codex_review/, 'offline liveness keeps its glyph');
});

test('colour theme still renders colour (no regression)', async () => {
  const ui = render(<App source={demoSource()} humanName="Kevin" width={110} height={28} />);
  await tick();
  assert.match(ui.lastFrame() ?? '', /\u001B\[3[0-9]m/);
  assert.doesNotMatch(plain(ui.lastFrame()), /ctx 88%!/, 'the "!" marker is monochrome-only');
});

test('code fences keep indentation, hard-wrap without re-flowing, sit behind a gutter; unclosed fences close at the end', () => {
  const body = 'Try this:\n```js\nif (x) {\n    return  y;\n}\n```\nthanks';
  const out = bodyLines(body, 40).map(lineText);
  assert.deepEqual(out, ['  Try this:', '  ┌ js', '  │ if (x) {', '  │     return  y;', '  │ }', '  └', '  thanks']);
  const long = bodyLines('```\n' + 'x'.repeat(30) + '\n```', 20).map(lineText);
  assert.deepEqual(long, ['  ┌ code', '  │ ' + 'x'.repeat(16), '  │ ' + 'x'.repeat(14), '  └']);
  const open = bodyLines('```py\nprint(1)', 30).map(lineText);
  assert.deepEqual(open, ['  ┌ py', '  │ print(1)', '  └']);
  const ansi = bodyLines('```\n\u001B[31mred\n```', 30).map(lineText);
  assert.match(ansi[1]!, /␛\[31mred/, 'code is sanitized too');
  assert.deepEqual(bodyLines('~~~\na\n~~~', 20).map(lineText), ['  ┌ code', '  │ a', '  └'], 'tilde fences work');
});

test('fences never drop text: inline ``` stays prose, the full info string shows, CommonMark-style closing', () => {
  const inline = bodyLines('```npm test``` fails on main\nnext line', 60).map(lineText);
  assert.deepEqual(inline, ['  ```npm test``` fails on main', '  next line'], 'inline triple backticks are prose, not a fence');
  const info = bodyLines('```js const x = 1\ncode\n```', 60).map(lineText);
  assert.deepEqual(info, ['  ┌ js const x = 1', '  │ code', '  └'], 'text after the fence is shown, not dropped');
  const four = bodyLines('````md\n```\ninner\n```\n````\nafter', 60).map(lineText);
  assert.deepEqual(four, ['  ┌ md', '  │ ```', '  │ inner', '  │ ```', '  └', '  after'], 'a longer fence closes only on a fence at least as long');
  const mixed = bodyLines('~~~\n```\n~~~\nprose', 60).map(lineText);
  assert.deepEqual(mixed, ['  ┌ code', '  │ ```', '  └', '  prose'], 'a closing fence must use the same character');
  const longInfo = bodyLines('```' + 'a'.repeat(30) + '\nx\n```', 20).map(lineText);
  assert.deepEqual(longInfo.slice(0, 3), ['  ┌ ' + 'a'.repeat(16), '    ' + 'a'.repeat(14), '  │ x'], 'a long info string wraps');
});


test('first run: no agents → welcome with join steps; agents but no messages → who is here', async () => {
  const empty = render(<App source={new FakeRoomSource({ participants: [] })} humanName="Kevin" width={100} height={20} />);
  await tick();
  const a = plain(empty.lastFrame());
  assert.match(a, /no agents have joined yet/);
  assert.match(a, /join the room as <name>/);
  assert.match(a, /room doctor/);
  cleanup();
  const quiet = render(<App source={new FakeRoomSource({ participants: [agent('astra'), agent('claude')] })} humanName="Kevin" width={100} height={20} />);
  await tick();
  const b = plain(quiet.lastFrame());
  assert.match(b, /The room is quiet/);
  assert.match(b, /2 agents are here: astra, claude/);
  assert.match(b, /@astra/);
});

test('/detail shows which native runtime took an attempt', async () => {
  const src = new FakeRoomSource({ participants: [agent('astra')] });
  const posted = src.post(HUMAN, ['astra'], 'hi', { states: { astra: 'uncertain' } });
  const t = posted.message.createdAt;
  src.setDelivery(posted.message.id, 'astra', {
    attempts: [{ n: 1, startedAt: t, finishedAt: t, outcome: 'uncertain', evidence: null, error: null, runtimeContext: { harness: 'codex', executable: 'C:\\codex.exe', home: 'C:\\home\\.codex' } }],
  });
  const item = (await src.request('read', { messageId: posted.message.id })).items[0]!;
  const text = detailLines(item, { width: 80, humanName: 'Kevin', seqById: new Map(), stale: false }).map(lineText).join('\n');
  assert.match(text, /via C:\\codex\.exe · home C:\\home\\\.codex/);
});

