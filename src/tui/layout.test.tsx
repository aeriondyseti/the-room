// 6.8: top bar ⇄ left panel layout toggle (Kevin: "a toggle to swap between top-bar and left-bar forms").
import './force-color.js'; // first: colour assertions must not depend on the caller's TTY
import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, cleanup } from 'ink-testing-library';
import type { ParticipantState } from '../contracts/domain.js';
import type { AccountUsage } from '../contracts/account.js';
import { App } from './app.js';
import { MONO_THEME } from './theme.js';
import { demoSource } from './demo.js';
import { cols, lineCols } from './format.js';
// 6.15: bar assertions use the monochrome rendering (track = "░"); colour frames are checked separately (layout.test).
import { barText } from './test-utils.js';
import { leftPanelFits, sidePanelLines } from './sidepanel.js';
import { accountLines, participantLines } from './topbar.js';
import { STATE_COLOR, STALE_FILL, TEXT_ON_FILL, TEXT_ON_TRACK, TRACK_BG, contextBar, sliderBar, surfaceStyle, usageBar } from './bars.js';
import { readSavedLayout, saveLayout, startingLayout, tuiPrefsPath } from './prefs.js';
import { layoutFlag } from '../cli/tui-command.js';

afterEach(() => cleanup());
const dir = mkdtempSync(join(tmpdir(), 'vp-layout-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const plain = (s: string | undefined) => (s ?? '').replace(/\u001B\[[0-9;]*m/g, '');
const NOW = Date.parse('2026-09-28T16:00:00Z');
const agent = (name: string, over: Partial<ParticipantState> = {}): ParticipantState => ({
  name, harness: 'codex', sessionId: name, liveness: 'online', livenessCheckedAt: null, activity: 'idle', pending: 0,
  usage: { source: 'codex-token-count', status: 'ok', observedAt: null, cumulative: null, context: { usedTokens: 42, limitTokens: 100, percent: 42 } }, ...over,
});
const claude: AccountUsage = {
  account: { harness: 'claude', scope: 'profile', key: 'k', sourceKey: 'k' }, status: 'ok', source: 'shared ccstatusline cache (login unverified)', checkedAt: null, observedAt: null,
  buckets: [
    { id: 'claude', windows: [{ kind: 'five_hour', durationMinutes: 300, usedPercent: 7, resetsAt: null }, { kind: 'seven_day', durationMinutes: 10_080, usedPercent: 21, resetsAt: null }] },
    { id: 'claude-fable', label: 'Fable', windows: [{ kind: 'weekly_fable', durationMinutes: 10_080, usedPercent: 22, resetsAt: null }] },
  ],
};

test('side panel (6.16): name + right-aligned state, then ctx and model · branch; BUDGETS rows; ONE label column so every bar, number and reset lines up; exact height, never wider', () => {
  const p = agent('claude', { harness: 'claude', activity: 'busy', pending: 1, workspace: { model: 'claude-opus-5-5', cwd: null, cwdSource: null, observedAt: null,
    git: { status: 'ok', root: 'X:/r', worktree: null, branch: 'sprint/6.8', detached: false, head: 'abc', dirty: 2, staged: 0, modified: 2, untracked: 0, ahead: null, behind: null, checkedAt: null } } });
  const lines = sidePanelLines([p, agent('astra')], [claude], { width: 32, height: 26, stale: false, mono: false, now: NOW, humanName: 'Kevin' });
  const text = lines.map(barText);
  assert.equal(lines.length, 26, 'padded to the panel height');
  assert.ok(lines.every((l) => lineCols(l) <= 32), 'no line exceeds the panel width');
  assert.match(text[1]!, /^● claude +busy · 1 queued$/);
  assert.equal(cols(text[1]!), 32, 'the state is right-aligned');
  assert.equal(text[2], '  ctx      42.0%░░░');
  assert.equal(text[3], '  opus-5-5 · sprint/6.8*2');
  assert.match(text[4]!, /^● astra +idle$/);
  const u = text.indexOf('BUDGETS');
  assert.ok(u > 0 && !text.includes('PLAN USAGE'), 'the section is named like the top bar');
  assert.equal(text[u + 1], 'Claude');
  const rows = text.slice(u + 2, u + 5);
  assert.deepEqual(rows.map((r) => r.slice(0, 9)), ['  5h     ', '  weekly ', '  Fable  '], 'labels share one column; Fable (a weekly limit) is named by its model');
  const pctCols = [text[2]!, ...rows].map((r) => r.indexOf('%'));
  assert.equal(new Set(pctCols).size, 1, `every percentage (ctx and budgets) ends in the same column:\n${[text[2], ...rows].join('\n')}`);
  assert.ok(text.includes('you: Kevin'));
});

test('side panel (6.16): agents come first — identities before budgets, attention before the rest; budgets never silently vanish; disconnected says last known', () => {
  const many = Array.from({ length: 8 }, (_, i) => agent(`agent${i}`));
  const roomy = sidePanelLines(many, [claude], { width: 32, height: 18, stale: false, mono: false, now: NOW, humanName: 'Kevin' }).map(barText);
  assert.equal(roomy.filter((l) => /^● agent/.test(l)).length, 8, 'every agent name is shown before any budget detail');
  assert.ok(roomy.some((l) => l.startsWith('  Fable')), 'budgets fit too');
  const tight = sidePanelLines([...many.slice(0, 7), agent('asks', { activity: 'waiting_permission' })], [claude], { width: 32, height: 10, stale: false, mono: false, now: NOW, humanName: 'Kevin' }).map(barText);
  const more = tight.find((l) => /^\+\d+ more · \/who$/.test(l));
  assert.ok(more, 'agents that do not fit are summarised, never silently dropped');
  assert.equal(Number(more!.match(/\d+/)![0]) + tight.filter((l) => /^● /.test(l)).length, 8);
  assert.ok(tight.some((l) => /^● asks +needs approval$/.test(l)), 'an agent needing approval is never the one hidden');
  assert.ok(tight.includes('+ more usage · /layout top'), 'budgets that do not fit are announced, not silently absent');
  const stale = sidePanelLines([agent('astra')], [], { width: 32, height: 8, stale: true, mono: false, now: NOW, humanName: 'Kevin' }).map(barText);
  assert.equal(stale[0], 'AGENTS · last known');
  assert.match(stale[1]!, /^◌ astra +last known: idle$/, 'no live liveness or usage while disconnected');
});
test('left panel yields when the conversation would get too narrow', () => {
  assert.equal(leftPanelFits(120, 32, 90), true);
  assert.equal(leftPanelFits(89, 32, 90), false, 'below the breakpoint');
  assert.equal(leftPanelFits(90, 60, 90), false, 'a wide panel never squeezes the conversation below its minimum');
});

test('prefs: saved in .room/tui.json with other keys kept; unreadable or invalid → none; flag > saved > configured > top', async () => {
  const root = join(dir, 'room');
  const path = tuiPrefsPath(root);
  assert.equal(path, join(root, '.room', 'tui.json'));
  assert.equal(await readSavedLayout(path), null);
  mkdirSync(join(root, '.room'), { recursive: true });
  writeFileSync(path, JSON.stringify({ other: 1, layout: 'sideways' }));
  assert.equal(await readSavedLayout(path), null, 'an unknown value is ignored');
  assert.equal(await saveLayout(path, 'left'), true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { other: 1, layout: 'left' });
  assert.equal(await readSavedLayout(path), 'left');
  writeFileSync(path, '{not json');
  assert.equal(await readSavedLayout(path), null);
  writeFileSync(join(dir, 'blocker2'), '');
  assert.equal(await saveLayout(join(dir, 'blocker2', 'tui.json'), 'top'), false, 'an unwritable location reports false, never throws');
  assert.equal(startingLayout('top', 'left', 'left'), 'top');
  assert.equal(startingLayout(null, 'left', 'top'), 'left');
  assert.equal(startingLayout(null, null, 'left'), 'left');
  assert.equal(startingLayout(null, null, 'top'), 'top');
});

test('--layout flag parsing: separate or = forms; missing value is null; absent is undefined', () => {
  assert.equal(layoutFlag(['--layout', 'left']), 'left');
  assert.equal(layoutFlag(['--no-color', '--layout=top']), 'top');
  assert.equal(layoutFlag(['--layout']), null);
  assert.equal(layoutFlag(['--demo']), undefined);
});

test('app: /layout and Ctrl+B switch layouts and report the saved choice; too narrow falls back to the top bar with a notice', async () => {
  const saved: string[] = [];
  const ui = render(<App source={demoSource()} humanName="Kevin" width={120} height={30} onLayoutChange={async (l) => { saved.push(l); return true; }} />);
  await tick();
  assert.match(plain(ui.lastFrame()), /BUDGETS +5h/, 'starts with the top bar (its budget grid header)');
  ui.stdin.write('/layout');
  await tick();
  ui.stdin.write('\r');
  await tick();
  let frame = plain(ui.lastFrame());
  assert.match(frame, /AGENTS/);
  assert.match(frame, /^BUDGETS +│/m, 'the left panel BUDGETS section');
  assert.doesNotMatch(frame, /BUDGETS +5h/, 'no top-bar grid while the panel shows');
  assert.match(frame, /Layout: left panel \(remembered\)/);
  ui.stdin.write('\u0002'); // Ctrl+B
  await tick();
  frame = plain(ui.lastFrame());
  assert.match(frame, /BUDGETS +5h/, 'back to the top bar');
  assert.match(frame, /Layout: top bar/);
  assert.deepEqual(saved, ['left', 'top']);
  ui.stdin.write('/layout sideways');
  await tick();
  ui.stdin.write('\r');
  await tick();
  assert.match(plain(ui.lastFrame()), /Usage: \/layout \[top\|left\]/);

  cleanup();
  const narrow = render(<App source={demoSource()} humanName="Kevin" width={80} height={30} layout="left" />);
  await tick();
  frame = plain(narrow.lastFrame());
  assert.match(frame, /BUDGETS +5h/, 'the conversation keeps a readable width (top bar, no panel)');
  assert.match(frame, /Left panel needs a terminal 90\+ columns wide; showing the top bar until then\./);
});

test('app: a layout that could not be saved says so', async () => {
  const ui = render(<App source={demoSource()} humanName="Kevin" width={120} height={30} onLayoutChange={async () => false} />);
  await tick();
  ui.stdin.write('\u0002');
  await tick(80);
  assert.match(plain(ui.lastFrame()), /couldn't be saved/);
});

test('bars: ccstatusline slider (10 cells, round(clamp)) with one-decimal percentages; n/a has no bar; stale is dim and colourless', () => {
  assert.deepEqual([0, 4, 5, 43, 95, 100, 130, -5].map((p) => sliderBar(p)), [
    '░░░░░░░░░░', '░░░░░░░░░░', '▓░░░░░░░░░', '▓▓▓▓░░░░░░', '▓▓▓▓▓▓▓▓▓▓', '▓▓▓▓▓▓▓▓▓▓', '▓▓▓▓▓▓▓▓▓▓', '░░░░░░░░░░',
  ]);
  assert.equal(barText(usageBar('weekly', 43, { stale: false })), 'weekly   43.0%░░░', '6.14: the number sits inside the bar');
  assert.equal(barText(usageBar('weekly', 4, { stale: false })), 'weekly ░░░4.0%░░░', 'a low non-zero reading keeps its number');
  assert.equal(barText(usageBar('5h', null, { stale: false })), '5h —', 'unknown: no bar, never an empty 0% bar');
  const high = usageBar('5h', 95, { stale: false });
  assert.equal(barText(high), '5h   95.0%!  ');
  assert.ok(high[0]!.color === undefined && high.slice(1).every((s) => s.surface?.kind === 'fill' && s.surface.color === STATE_COLOR.critical), 'quiet label; the bar is a red surface (> 90%) with the number over it');
  assert.equal(usageBar('5h', 43, { stale: false })[1]?.surface?.color, STATE_COLOR.ok, 'green under 70%');
  assert.equal(usageBar('5h', 70, { stale: false })[1]?.surface?.color, STATE_COLOR.warn, 'amber from 70%');
  assert.equal(usageBar('5h', 90, { stale: false })[1]?.surface?.color, STATE_COLOR.warn, 'amber up to 90%');
  assert.equal(barText(usageBar('', null, { stale: false })), '—', 'a bare grid cell with no reading is a dash, never 0');
  const stale = usageBar('5h', 95, { stale: true });
  assert.equal(barText(stale), '5h   95.0%   ', 'stale: no warning emphasis');
  assert.ok(stale.every((s) => s.color === undefined && (!s.surface || s.surface.kind === 'track' || s.surface.color === undefined)), 'stale: no state colour anywhere (the fill is drawn grey)');
  assert.ok(stale.filter((s) => /\S/.test(s.text)).every((s) => s.dim), 'stale text is dim');
  assert.equal(barText(usageBar('5h', 43, { stale: false, bar: false })), '5h 43.0%');
  assert.equal(barText(contextBar(null, { stale: false })), 'ctx —');
  assert.equal(barText(contextBar({ source: 'codex-token-count', status: 'ok', observedAt: null, cumulative: null, context: { usedTokens: 12_000, limitTokens: null, percent: null } }, { stale: false })), 'ctx 12k', 'tokens without a limit: no bar');
});

test('both layouts show the same values; several agents on one subscription still give one account row', () => {
  const two = [agent('claude', { harness: 'claude' }), agent('claude-ui', { harness: 'claude' })];
  const pct = (lines: string[]) => lines.join('\n').match(/\d+\.\d%/g)?.sort();
  const top = [...participantLines(two, { width: 200, stale: false, mono: false, maxLines: 2 }), ...accountLines([claude], { width: 200, mono: false, now: NOW })].map(barText);
  const left = sidePanelLines(two, [claude], { width: 32, height: 30, stale: false, mono: false, now: NOW, humanName: 'Kevin' }).map(barText);
  assert.deepEqual(pct(left), pct(top), 'same percentages in both layouts');
  assert.equal(top.filter((l) => l.startsWith('Claude')).length, 1);
  assert.equal(left.filter((l) => /^Claude\b/.test(l)).length, 1);
});
test('review fixes: a short panel ends usage with "more usage" (never silently); qualifiers stay on the account row', () => {
  const stale = (harness: 'claude' | 'codex'): AccountUsage => ({ ...claude, status: 'stale', source: 's', account: { ...claude.account, harness, sourceKey: harness },
    buckets: [{ id: harness, windows: [{ kind: 'a', durationMinutes: 300, usedPercent: 38, resetsAt: '2026-09-28T18:00:00Z' }, { kind: 'b', durationMinutes: 10_080, usedPercent: 71, resetsAt: '2026-10-02T09:00:00Z' }] }] });
  const tall = sidePanelLines([], [stale('claude'), stale('codex')], { width: 32, height: 30, stale: false, mono: false, now: NOW, humanName: 'Kevin' }).map(barText);
  assert.ok(tall.some((l) => /^Claude +stale$/.test(l)) && tall.some((l) => /^Codex +stale$/.test(l)), 'the staleness qualifier rides on the account heading (right-aligned)');
  assert.ok(tall.some((l) => l.includes('░')), 'room to spare: bars');
  // 6.16: compact mode only shortens notes (resets are inline here; they take their own row only when too wide), so a
  // short panel ends with the marker. Folding reset rows away in compact mode is TD-0033.
  const short = sidePanelLines([], [stale('claude'), stale('codex')], { width: 32, height: 11, stale: false, mono: false, now: NOW, humanName: 'Kevin' }).map(barText);
  assert.equal(short.length, 11);
  assert.ok(short.includes('+ more usage · /layout top'), 'short: the cut is announced');
  const tiny = sidePanelLines([], [stale('claude'), stale('codex')], { width: 32, height: 8, stale: false, mono: false, now: NOW, humanName: 'Kevin' }).map(barText);
  assert.ok(tiny.includes('+ more usage · /layout top'), 'anything cut is announced');
  for (const [i, l] of tiny.entries()) if (/^\s+(5h|weekly)/.test(l)) assert.ok(tiny.slice(0, i).some((h) => /stale$/.test(h)), 'every shown value has its qualifier above it');
  const token = { source: 'claude-transcript' as const, status: 'stale' as const, observedAt: null, cumulative: null, context: { usedTokens: 12_000, limitTokens: null, percent: null } };
  assert.equal(barText(contextBar(token, { stale: false })), 'ctx 12k?', 'a stale token-only reading keeps its "?"');
});

test('review fixes: quick successive saves persist the latest choice', async () => {
  const path = join(dir, 'serial', '.room', 'tui.json');
  const results = await Promise.all([saveLayout(path, 'left'), saveLayout(path, 'top'), saveLayout(path, 'left')]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(await readSavedLayout(path), 'left');
});
test('cross-review (Astra): on a very short panel a shown value never loses its source qualifier', () => {
  for (const height of [7, 8, 9, 10, 11, 12]) {
    const text = sidePanelLines([], [{ ...claude, fallback: true }], { width: 32, height, stale: false, mono: false, now: NOW, humanName: 'Kevin' }).map(barText);
    const firstValue = text.findIndex((l) => /\d+\.\d%/.test(l));
    if (firstValue < 0) continue;
    assert.ok(text.slice(0, firstValue).some((l) => /statusline/.test(l)), `height ${height}: "${text.join(' | ')}"`);
  }
});
test('6.15: a bar is one flat surface — fill = solid bright background, track = solid dim background, label with no background of its own; mono: inverse fill, ░ track', () => {
  const bar = usageBar('', 43, { stale: false });
  assert.ok(bar.every((s) => s.surface), 'every cell is surface');
  assert.ok(!bar.some((s) => s.text.includes('░')), 'no stipple glyph in the model');
  const fill = bar.find((s) => s.surface?.kind === 'fill')!;
  const track = bar.find((s) => s.surface?.kind === 'track')!;
  assert.deepEqual(surfaceStyle(fill, false), { backgroundColor: STATE_COLOR.ok, color: TEXT_ON_FILL });
  assert.deepEqual(surfaceStyle(track, false), { backgroundColor: TRACK_BG, color: TEXT_ON_TRACK }, 'track text has an explicit light foreground');
  const staleTrack = usageBar('', 43, { stale: true }).find((s) => s.surface?.kind === 'track' && /\S/.test(s.text))!;
  assert.equal(surfaceStyle(staleTrack, false).dim, undefined, 'a stale label reads as one on both surfaces (not dimmed on either)');
  assert.deepEqual(surfaceStyle(fill, true), { inverse: true, dim: fill.dim }, 'monochrome: the fill is reverse video');
  assert.deepEqual(surfaceStyle(track, true), { inverse: false, dim: track.dim, blank: '░' }, 'monochrome: the track shows ░ so the extent (and a 0% bar) stays visible');
  const staleFill = usageBar('', 43, { stale: true }).find((s) => s.surface?.kind === 'fill')!;
  const st = surfaceStyle(staleFill, false);
  assert.deepEqual([st.backgroundColor, st.color, st.dim], [STALE_FILL, TEXT_ON_FILL, undefined], 'stale: grey fill, never a state colour; its text is not dimmed into the grey');
  assert.equal(bar.map((s) => s.text).join('').replace(/ /g, ''), '43.0%', 'the label is the only text, drawn over the surface');
});

test('6.15: rendered colour frames (top/left × full/compact) — no stipple, a flat dim track background, dark label text on the fill', async () => {
  for (const layout of ['top', 'left'] as const) {
    for (const topBar of ['full', 'compact'] as const) {
      const ui = render(<App source={demoSource()} humanName="Kevin" width={130} height={34} layout={layout} topBar={topBar} />);
      await tick();
      const frame = ui.lastFrame() ?? '';
      const where = `${layout}/${topBar}`;
      assert.doesNotMatch(plain(frame), /░/, `${where}: no ░ anywhere`);
      assert.match(frame, /\u001B\[48;5;237m/, `${where}: the track is a 256-colour background`);
      assert.match(frame, /\u001B\[30m/, `${where}: label text on a fill is dark`);
      assert.match(frame, /\u001B\[(4[1-3]|48;5;214)m/, `${where}: a fill is drawn as a state-colour background`);
      cleanup();
    }
  }
});

test('6.15: the rendered monochrome frame — reverse-video fill, no background colours, a visible ░ track (a 0% bar stays visible)', async () => {
  const ui = render(<App source={demoSource()} humanName="Kevin" width={130} height={34} theme={MONO_THEME} />);
  await tick();
  const frame = ui.lastFrame() ?? '';
  assert.doesNotMatch(frame, /\u001B\[4[0-9](;|m)|\u001B\[10[0-7]m/, 'no background colour codes in monochrome');
  const builder = frame.split('\n').find((l) => l.includes('claude_builder')) ?? '';
  assert.match(builder, /\u001B\[7m/, 'the fill is reverse video');
  assert.match(plain(builder), /░/, 'the track shows as ░ in monochrome');
  const zero = usageBar('', 0, { stale: false });
  assert.ok(zero.some((s) => s.surface?.kind === 'track') && surfaceStyle(zero.at(-1)!, true).blank === '░', 'a 0% bar is all track: visible as ░ in monochrome');
});
test('side panel (6.16): every window of every model bucket is shown (a Spark 5h too); same-label buckets stay distinct', () => {
  const codex: AccountUsage = { account: { harness: 'codex', scope: 'account', key: 'c', sourceKey: 'c' }, status: 'ok', source: 'd', checkedAt: null, observedAt: null, buckets: [
    { id: 'codex', windows: [{ kind: 's', durationMinutes: 10_080, usedPercent: 18, resetsAt: null }] },
    { id: 'model-a', label: 'Spark', windows: [{ kind: 'p', durationMinutes: 300, usedPercent: 61, resetsAt: null }, { kind: 's', durationMinutes: 10_080, usedPercent: 12, resetsAt: null }] },
    { id: 'model-b', label: 'Spark', windows: [{ kind: 'p', durationMinutes: 300, usedPercent: 80, resetsAt: null }] },
  ] };
  const text = sidePanelLines([], [codex], { width: 40, height: 20, stale: false, mono: false, now: NOW, humanName: 'Kevin' }).map(barText).join('\n');
  for (const v of ['61.0%', '12.0%', '80.0%', '18.0%']) assert.ok(text.includes(v), `${v} shown:\n${text}`);
  assert.match(text, /Spark 5h \[model-a\]/);
  assert.match(text, /Spark 5h \[model-b\]/);
  assert.match(text, /^ {2}Spark \[model-a\]|^ {2}Spark +/m, 'the weekly Spark limit is named by its model');
});
const spark = (label: string): AccountUsage => ({ account: { harness: 'codex', scope: 'account', key: 'c', sourceKey: 'c' }, status: 'ok', source: 'd', checkedAt: null, observedAt: null, buckets: [
  { id: 'codex', windows: [{ kind: 'p', durationMinutes: 300, usedPercent: 38, resetsAt: '2026-09-28T18:12:00Z' }, { kind: 's', durationMinutes: 10_080, usedPercent: 71, resetsAt: '2026-10-01T20:41:00Z' }] },
  { id: 'codex_bengalfox', label, windows: [{ kind: 'p', durationMinutes: 300, usedPercent: 61, resetsAt: '2026-09-28T19:00:00Z' }, { kind: 's', durationMinutes: 10_080, usedPercent: 12, resetsAt: '2026-10-01T20:41:00Z' }] },
] });

test('6.16 review: across widths no percentage or reset time is ever cut, and %, reset columns line up (labels ellipsise instead)', () => {
  for (const width of [44, 40, 34, 32, 30, 28, 26, 24]) {
    for (const label of ['Fable', 'GPT-5.3-Codex-Spark']) {
      const text = sidePanelLines([agent('astra')], [spark(label)], { width, height: 40, stale: false, mono: false, now: NOW, humanName: 'Kevin' }).map(barText);
      const where = `width ${width}, label ${label}:\n${text.join('\n')}`;
      for (const v of ['38.0%', '71.0%!', '61.0%', '12.0%', '42.0%']) assert.ok(text.some((l) => l.includes(v)), `${v} whole — ${where}`);
      const resets = text.filter((l) => l.includes('↻'));
      assert.equal(resets.length, 4, `every reset shown — ${where}`);
      assert.ok(resets.every((l) => /↻ \S.*\S$/.test(l) && !/↻[^\n]*…/.test(l)), `no reset is cut — ${where}`);
      const values = text.filter((l) => /\d\.\d%/.test(l));
      assert.equal(new Set(values.map((l) => l.indexOf('%'))).size, 1, `% column aligned — ${where}`);
      assert.equal(new Set(resets.map((l) => l.indexOf('↻'))).size, 1, `reset column aligned — ${where}`);
      assert.ok(text.every((l) => cols(l) <= width), `never wider — ${where}`);
    }
  }
});

test('6.16 review: an unobserved window duration is labelled "(?)", never passed off as a second weekly; a narrow panel keeps the stale qualifier', () => {
  const odd: AccountUsage = { ...spark('Spark'), buckets: [spark('Spark').buckets[0]!, { id: 'b', label: 'Spark', windows: [{ kind: 's', durationMinutes: 10_080, usedPercent: 3, resetsAt: null }, { kind: 'x', durationMinutes: null, usedPercent: 50, resetsAt: null }] }] };
  const text = sidePanelLines([], [odd], { width: 40, height: 20, stale: false, mono: false, now: NOW, humanName: 'Kevin' }).map(barText);
  assert.ok(text.some((l) => /^ {2}Spark \(\?\)/.test(l) && l.includes('50.0%')), text.join('\n'));
  const narrow = sidePanelLines([], [{ ...spark('Spark'), status: 'stale' }], { width: 14, height: 20, stale: true, mono: false, now: NOW, humanName: 'Kevin' }).map(barText);
  assert.ok(narrow.some((l) => /last known/.test(l)), `the qualifier survives a narrow panel:\n${narrow.join('\n')}`);
});

test('6.16 review: every shown agent gets the same level of detail at every height', () => {
  const ws = (name: string) => agent(name, { workspace: { model: 'gpt-6', cwd: null, cwdSource: null, observedAt: null, git: null } });
  const four = [ws('a1'), ws('a2'), ws('a3'), ws('a4')];
  for (let height = 8; height <= 24; height++) {
    const text = sidePanelLines(four, [claude], { width: 32, height, stale: false, mono: false, now: NOW, humanName: 'Kevin' }).map(barText);
    const heads = text.map((l, i) => (/^● /.test(l) ? i : -1)).filter((i) => i >= 0);
    const detail = heads.map((h, k) => {
      const end = k + 1 < heads.length ? heads[k + 1]! : text.findIndex((l, i) => i > h && !/^ {2}\S/.test(l));
      return (end < 0 ? text.length : end) - h - 1;
    });
    assert.equal(new Set(detail).size <= 1, true, `height ${height}: uneven detail ${JSON.stringify(detail)}\n${text.join('\n')}`);
  }
});