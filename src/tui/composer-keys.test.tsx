// 6.13: composer word editing, raw key identity and the growing composer (Astra's spec docs/COMPOSER-KEYS-SPEC.md;
// key bytes from Kevin's live Windows Terminal probe: Enter CR, Ctrl+Enter LF, Backspace DEL, Ctrl+Backspace BS,
// Ctrl+Left ESC[1;5D, Ctrl+Right ESC[1;5C).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import type { ParticipantState } from '../contracts/domain.js';
import type { Params } from '../contracts/ipc.js';
import { App } from './app.js';
import { FakeRoomSource } from './fake-source.js';
import { cols } from './format.js';
import { deleteWordBackward, visualRows, wordLeft, wordRight, type Draft } from './composer.js';
import { bsIsCtrlBackspaceIn, classifyRawKey } from './raw-keys.js';
import { sidePanelLines } from './sidepanel.js';

afterEach(() => cleanup());
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const plain = (s: string | undefined) => (s ?? '').replace(/\u001B\[[0-9;]*m/g, '');
/** "hello wor|ld" → { text, cursor } (| marks the cursor). */
const d = (s: string): Draft => ({ text: s.replace('|', ''), cursor: s.indexOf('|') });
const show = (x: Draft) => x.text.slice(0, x.cursor) + '|' + x.text.slice(x.cursor);

test('Ctrl+Backspace deletes the previous whitespace-delimited token (the spec table)', () => {
  const cases: Array<[string, string]> = [
    ['hello world|', 'hello |'],
    ['hello world   |', 'hello |'],
    ['hello wor|ld', 'hello |ld'],
    ['hello\n   |', 'hello\n|'],
    ['hello\n|world', 'hello|world'],
    ['use @claude|', 'use |'],
    ['open X:\\repo\\file.ts|', 'open |'],
    ['|hello', '|hello'],
  ];
  for (const [before, after] of cases) assert.equal(show(deleteWordBackward(d(before))), after, before);
});

test('word deletion and navigation are grapheme-safe (joined emoji, combining marks, non-ASCII words)', () => {
  assert.equal(show(deleteWordBackward(d('hi 👩‍💻👩‍💻|'))), 'hi |');
  assert.equal(show(deleteWordBackward(d('café e\u0301|'))), 'café |');
  assert.equal(show(wordLeft(d('日本語 テキスト|'))), '日本語 |テキスト');
  const emoji = wordRight(d('|👩‍💻x y'));
  assert.equal(show(emoji), '👩‍💻x |y');
});

test('Ctrl+Left / Ctrl+Right move by token (spec examples), cross newlines, clamp at the ends', () => {
  assert.equal(show(wordLeft(d('hello world|'))), 'hello |world');
  assert.equal(show(wordRight(d('hel|lo world'))), 'hello |world');
  assert.equal(show(wordLeft(d('hello |world'))), '|hello world');
  assert.equal(show(wordLeft(d('|hello'))), '|hello');
  assert.equal(show(wordRight(d('hello|'))), 'hello|');
  assert.equal(show(wordRight(d('one|\n  two'))), 'one\n  |two');
  assert.equal(show(wordLeft(d('one\n  |two'))), '|one\n  two');
});

test('raw key identity: LF = Ctrl+Enter; BS = Ctrl+Backspace only where qualified (Windows Terminal); DEL is plain', () => {
  assert.equal(classifyRawKey('\n', { bsIsCtrlBackspace: false }), 'ctrl-enter');
  assert.equal(classifyRawKey('\r', { bsIsCtrlBackspace: true }), null, 'CR is plain Enter');
  assert.equal(classifyRawKey('\b', { bsIsCtrlBackspace: true }), 'ctrl-backspace');
  assert.equal(classifyRawKey('\b', { bsIsCtrlBackspace: false }), null, 'other terminals may send BS for a plain Backspace');
  assert.equal(classifyRawKey('\x7f', { bsIsCtrlBackspace: true }), null, 'DEL is a plain Backspace');
  assert.equal(classifyRawKey('hello\nworld', { bsIsCtrlBackspace: true }), null, 'a paste is never a shortcut');
  assert.equal(bsIsCtrlBackspaceIn({ WT_SESSION: 'abc' }), true);
  assert.equal(bsIsCtrlBackspaceIn({}), false);
});

test('visual rows: soft wraps measured by display width (wide chars count two); the cursor at a full row end gets its own row', () => {
  const v = visualRows(d('abcdefghij|'), 5, cols);
  assert.deepEqual(v.rows.map((r) => r.before + (r.cursor ?? '') + r.after), ['abcde', 'fghij', ' ']);
  assert.equal(v.cursorRow, 2);
  const wide = visualRows(d('日本語日本|'), 6, cols);
  assert.deepEqual(wide.rows.map((r) => r.before), ['日本語', '日本'], 'three wide characters fill six columns');
  const mid = visualRows(d('ab|c\nde'), 10, cols);
  assert.deepEqual(mid.rows, [{ before: 'ab', cursor: 'c', after: '' }, { before: 'de', cursor: null, after: '' }]);
});

const agent = (name: string): ParticipantState => ({ name, harness: 'codex', sessionId: name, liveness: 'online', livenessCheckedAt: null, activity: 'idle', pending: 0, usage: null });
async function setup(height = 30, width = 100, windowsTerminal = true) {
  const src = new FakeRoomSource({ participants: [agent('astra')] });
  const ui = render(<App source={src} humanName="Kevin" width={width} height={height} windowsTerminal={windowsTerminal} />);
  await tick();
  const type = async (s: string) => { ui.stdin.write(s); await tick(); };
  const sends = () => src.requests.filter((r) => r.method === 'send').map((r) => r.params as Params<'send'>);
  return { ui, type, sends, frame: () => plain(ui.lastFrame()) };
}

test('through Ink: Ctrl+Enter (LF) adds a line and never sends; Enter (CR) sends; Alt+Enter does nothing', async () => {
  const t = await setup();
  await t.type('line one');
  await t.type('\n');
  await t.type('line two');
  assert.equal(t.sends().length, 0, 'Ctrl+Enter never sends');
  await t.type('\u001B\r');
  assert.equal(t.sends().length, 0, 'Alt+Enter is left to the terminal and never sends');
  await t.type('\r');
  assert.equal(t.sends()[0]?.body, 'line one\nline two');
  await t.type('/restart');
  await t.type('\n');
  assert.equal(t.sends().length, 1);
  assert.doesNotMatch(t.frame(), /Restart the room service\?/, 'Ctrl+Enter never runs or confirms a command');
});

test('through Ink: Ctrl+Backspace (BS) deletes a word, Backspace (DEL) one character, Ctrl+W a word; Ctrl+←/→ move by word', async () => {
  const t = await setup();
  await t.type('hello big world');
  await t.type('\b');
  await t.type('\r');
  assert.equal(t.sends()[0]?.body, 'hello big');
  await t.type('hello world');
  await t.type('\x7f');
  await t.type('\r');
  assert.equal(t.sends()[1]?.body, 'hello worl');
  await t.type('one two three');
  await t.type('\u0017'); // Ctrl+W
  await t.type('\r');
  assert.equal(t.sends()[2]?.body, 'one two');
  await t.type('aaa bbb');
  await t.type('\u001B[1;5D'); // Ctrl+Left → before "bbb"
  await t.type('X');
  await t.type('\u001B[1;5C'); // Ctrl+Right → end of the draft (past "bbb")
  await t.type('Y');
  await t.type('\r');
  assert.equal(t.sends()[3]?.body, 'aaa XbbbY');
});

test('through Ink: outside Windows Terminal BS stays a plain Backspace', async () => {
  const t = await setup(30, 100, false);
  await t.type('hello world');
  await t.type('\b');
  await t.type('\r');
  assert.equal(t.sends()[0]?.body, 'hello worl');
});

test('the composer grows with the draft (soft wraps included) and scrolls inside itself; the bottom bar is never overwritten', async () => {
  for (const [lines, height] of [[6, 30], [8, 30], [12, 30], [30, 30], [12, 16]] as const) {
    const t = await setup(height);
    for (let i = 1; i <= lines; i++) {
      await t.type(`line ${i}`);
      if (i < lines) await t.type('\n');
    }
    const rows = t.frame().split('\n');
    assert.equal(rows.length, height, `${lines} lines @ ${height} rows: the frame keeps its height`);
    assert.match(rows.at(-1)!, /^● live/, `${lines} lines @ ${height} rows: the status bar is intact`);
    assert.ok(rows.some((r) => r.includes(`line ${lines}`)), 'the cursor line is visible');
    if (lines > 12 || height < 20) assert.ok(rows.some((r) => r.startsWith('↑ ')), 'rows above are marked');
    cleanup();
  }
  const t = await setup(30, 60);
  await t.type('x'.repeat(200)); // one long soft-wrapped line
  const rows = t.frame().split('\n');
  assert.equal(rows.length, 30);
  assert.match(rows.at(-1)!, /^● live/, 'a long soft-wrapped line never pushes into the bottom bar');
  assert.ok(rows.every((r) => cols(r) <= 60), 'nothing wider than the terminal');
});

test('review fix: Left/Right/Backspace move by grapheme, and the cursor is never lost inside a cluster', async () => {
  const t = await setup(20, 60);
  for (let i = 1; i <= 14; i++) {
    await t.type(`line ${i}`);
    await t.type('\n');
  }
  await t.type('cafe\u0301 👩‍💻');
  await t.type('\u001B[D'); // Left over the joined emoji: one grapheme
  await t.type('\u001B[D'); // Left over the space
  await t.type('\u001B[D'); // Left over "é" (e + combining accent): one grapheme
  const rows = t.frame().split('\n');
  assert.ok(rows.some((r) => r.includes('cafe\u0301')), `the cursor line stays in view:\n${rows.join('\n')}`);
  await t.type('\x7f'); // Backspace deletes the "f" before the cursor; the accented é stays whole
  await t.type('\r');
  assert.match(t.sends()[0]?.body ?? '', /cae\u0301 👩‍💻$/);
  const v = visualRows({ text: 'ab\ncafe\u0301', cursor: 7 }, 20, cols);
  assert.equal(v.cursorRow, 1, 'an index inside a cluster still puts the cursor on its row');
  assert.equal(v.rows[1]?.cursor, 'e\u0301');
});

test('review fix: a tab is measured and drawn as two columns, so the row budget holds', () => {
  const v = visualRows({ text: 'a\tb|'.replace('|', ''), cursor: 3 }, 4, cols, (g) => (g === '\t' ? '  ' : g));
  assert.deepEqual(v.rows.map((r) => r.before + (r.cursor ?? '') + r.after), ['a  b', ' '], 'a + two spaces + b fills four columns; the cursor wraps');
});

test('review fix: CSI-u Ctrl+Enter / Ctrl+Backspace work too; outside Windows Terminal Alt+Enter adds a line and the hint says "\\ + Enter"', async () => {
  const t = await setup();
  await t.type('one two');
  await t.type('\u001B[127;5u'); // CSI-u Ctrl+Backspace
  await t.type('\u001B[13;5u'); // CSI-u Ctrl+Enter
  await t.type('three');
  assert.equal(t.sends().length, 0, 'CSI-u Ctrl+Enter never sends');
  await t.type('\r');
  assert.equal(t.sends()[0]?.body, 'one \nthree');
  assert.match(t.frame(), /Ctrl\+Enter newline/, 'Windows Terminal hint');
  cleanup();
  const other = await setup(30, 100, false);
  assert.match(other.frame(), /\\ \+ Enter newline/, 'elsewhere the hint offers the backslash newline');
  await other.type('a');
  await other.type('\u001B\r'); // Alt+Enter
  await other.type('b');
  assert.equal(other.sends().length, 0);
  await other.type('\r');
  assert.equal(other.sends()[0]?.body, 'a\nb', 'outside Windows Terminal Alt+Enter adds a line');
});
test('cross-review: a key release (CSI-u event type 3) never acts — one press + one release = one action; a released Enter never submits', async () => {
  const t = await setup();
  await t.type('one two');
  await t.type('\u001B[127;5u'); // press Ctrl+Backspace
  await t.type('\u001B[127;5:3u'); // release Ctrl+Backspace
  await t.type('\u001B[13;5u'); // press Ctrl+Enter
  await t.type('\u001B[13;5:3u'); // release Ctrl+Enter
  await t.type('x');
  await t.type('\u001B[13;1:3u'); // release of a plain Enter
  assert.equal(t.sends().length, 0, 'a release never submits');
  await t.type('\r');
  assert.equal(t.sends()[0]?.body, 'one \nx', 'exactly one deletion and one newline');
});
test('TD-0034: at every height and in both layouts the frame holds — header, the To:/command row and the status bar survive suggestions, feedback and a long draft', async () => {
  for (const layout of ['top', 'left'] as const) {
    for (const height of [12, 13, 14, 16, 20]) {
      for (const typed of ['/', '@nobody hi\r', 'a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nc\nd\ne\nf\ng\nh\u0017']) {
        const src = new FakeRoomSource({ participants: [agent('astra')] });
        const ui = render(<App source={src} humanName="Kevin" width={100} height={height} layout={layout} windowsTerminal={true} />);
        await tick();
        for (const ch of typed) { ui.stdin.write(ch); await tick(5); }
        await tick();
        const rows = plain(ui.lastFrame()).split('\n');
        const where = `${layout} h=${height} typed ${JSON.stringify(typed)}:\n${rows.join('\n')}`;
        assert.equal(rows.length, height, `frame height — ${where}`);
        assert.match(rows[0]!, /agent-roundtable/, `header kept — ${where}`);
        assert.ok(rows.some((r) => /^(To: |command)/.test(r)), `To:/command row kept — ${where}`);
        const statusAt = rows.findIndex((r) => r.startsWith('● live'));
        assert.equal(statusAt, height - 1, `status bar on the last row (no outer divider since its removal) — ${where}`);
        cleanup();
      }
    }
  }
});
test('TD-0034 review: the worst case still fits — banner + error line + "/" + a multi-line top bar at 12 rows; the highlighted command is always on screen', async () => {
  const many = Array.from({ length: 10 }, (_, i) => agent(`agent_${i}`));
  const account = { account: { harness: 'claude' as const, scope: 'profile' as const, key: 'k', sourceKey: 'k' }, status: 'ok' as const, source: 's', checkedAt: null, observedAt: null,
    buckets: [{ id: 'claude', windows: [{ kind: 'a', durationMinutes: 300, usedPercent: 29, resetsAt: null }, { kind: 'b', durationMinutes: 10_080, usedPercent: 24, resetsAt: null }] }] };
  for (const [layout, width] of [['top', 100], ['top', 30], ['top', 20], ['left', 60], ['left', 120]] as const) {
    for (const height of [12, 13, 14]) {
      const src = new FakeRoomSource({ participants: many });
      src.setAccounts([account]);
      const ui = render(<App source={src} humanName="Kevin" width={width} height={height} layout={layout} windowsTerminal={true} />);
      await tick();
      src.setStatus({ state: 'reconnecting', attempt: 2 } as never); // a connection banner
      await tick();
      for (const ch of '/xyz\r') { ui.stdin.write(ch); await tick(5); } // an error feedback line that stays while typing
      for (let i = 0; i < 3; i++) { ui.stdin.write('\x7f'); await tick(5); } // back to "/": suggestions open, feedback kept
      await tick();
      let rows = plain(ui.lastFrame()).split('\n');
      const where = () => `${layout} w=${width} h=${height}:\n${rows.join('\n')}`;
      assert.equal(rows.length, height, `frame height — ${where()}`);
      assert.match(rows[0]!, /agent-roundtable/, `header kept — ${where()}`);
      assert.ok(rows.some((r) => /^(To: |command)/.test(r)), `To:/command row kept — ${where()}`);
      assert.ok(rows.some((r) => /(^|\s)▸ \//.test(r)), `the highlighted command is visible — ${where()}`);
      assert.ok(rows.some((r) => /\+\d+ (more|↑\/↓)/.test(r)), `hidden suggestions are announced — ${where()}`);
      ui.stdin.write('\u001B[B'); await tick(5); ui.stdin.write('\u001B[B'); await tick(); // ↓↓
      rows = plain(ui.lastFrame()).split('\n');
      assert.ok(rows.some((r) => /(^|\s)▸ \//.test(r)), `still visible after ↓↓ — ${where()}`);
      assert.equal(rows.length, height, `frame height after ↓↓ — ${where()}`);
      cleanup();
    }
  }
});

test('TD-0034 review: tall terminals behave exactly as before — 6 suggestions + "+N more"; a long draft grows to the configured max; the conversation keeps 3 rows', async () => {
  const t = await setup(30);
  await t.type('/');
  let rows = t.frame().split('\n');
  assert.equal(rows.filter((r) => /^[▸ ] \/\w/.test(r)).length, 6, rows.join('\n'));
  assert.ok(rows.some((r) => /^ {2}\+\d+ more · ↑\/↓ to see them\s*$/.test(r)));
  await t.type('\u001B'); // Esc clears the draft
  for (let i = 1; i <= 16; i++) { await t.type(`line ${i}`); if (i < 16) await t.type('\n'); }
  rows = t.frame().split('\n');
  const draftRows = rows.filter((r) => /^(›|↑|↓| ) ?line \d+\s*$|^ {2}line \d+\s*$/.test(r)).length;
  assert.equal(draftRows, 12, `the draft grows to composerMaxRows (12):\n${rows.join('\n')}`);
});
test('6.18 review: the smallest viewport still announces — the help pager keeps "↓ N more", the side panel shows summary lines, and the folded count leads its row', async () => {
  const many = Array.from({ length: 10 }, (_, i) => agent(`agent_${i}`));
  const account = { account: { harness: 'claude' as const, scope: 'profile' as const, key: 'k', sourceKey: 'k' }, status: 'ok' as const, source: 's', checkedAt: null, observedAt: null,
    buckets: [{ id: 'claude', windows: [{ kind: 'a', durationMinutes: 300, usedPercent: 29, resetsAt: null }] }] };
  for (const layout of ['top', 'left'] as const) {
    const src = new FakeRoomSource({ participants: many });
    src.setAccounts([account]);
    const ui = render(<App source={src} humanName="Kevin" width={120} height={12} layout={layout} windowsTerminal={true} />);
    await tick();
    src.setStatus({ state: 'reconnecting', attempt: 2 } as never);
    await tick();
    ui.stdin.write('?');
    await tick();
    const rows = plain(ui.lastFrame()).split('\n');
    assert.equal(rows.length, 12);
    assert.ok(rows.some((r) => /↓ \d+ more lines? · PgDn/.test(r)), `${layout}: the pager's marker survives the smallest viewport:\n${rows.join('\n')}`);
    cleanup();
  }
  const tiny = sidePanelLines(many, [account], { width: 32, height: 2, stale: false, mono: false, now: Date.now(), humanName: 'Kevin' }).map((l) => l.map((s) => s.text).join(''));
  assert.deepEqual(tiny, ['AGENTS · 10 · /who', '+ budgets · /layout top'], 'a 2-row panel says what it cannot show');
  const asking = sidePanelLines([...many.slice(0, 9), { ...agent('asks'), activity: 'waiting_permission' as const }], [account], { width: 40, height: 2, stale: false, mono: false, now: Date.now(), humanName: 'Kevin' }).map((l) => l.map((s) => s.text).join(''));
  assert.equal(asking[0], 'AGENTS · 10 · 1 need attention · /who', 'the attention count survives the tiny summary');
  // Cramped enough to fold: 12 rows, 30 columns, a banner and an error line.
  const src = new FakeRoomSource({ participants: [agent('astra')] });
  const ui = render(<App source={src} humanName="Kevin" width={30} height={12} windowsTerminal={true} />);
  await tick();
  src.setStatus({ state: 'reconnecting', attempt: 2 } as never);
  for (const ch of '/xyz\r') { ui.stdin.write(ch); await tick(5); }
  for (let i = 0; i < 3; i++) { ui.stdin.write('\x7f'); await tick(5); }
  await tick();
  const frameRows = plain(ui.lastFrame()).split('\n');
  assert.equal(frameRows.length, 12, frameRows.join('\n'));
  const folded = frameRows.find((r) => /▸ \//.test(r)) ?? '';
  assert.match(folded, /^\+\d+ ↑\/↓ ▸ \//, `the count leads the folded row: "${folded}"`);
});
