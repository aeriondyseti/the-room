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
import { demoSource } from './demo.js';
import { lineCols, lineText } from './format.js';
import { leftPanelFits, sidePanelLines } from './sidepanel.js';
import { accountLines, participantLines } from './topbar.js';
import { PALETTE, contextBar, sliderBar, usageBar } from './bars.js';
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

test('side panel: name + ctx, status, model · branch per agent; usage one window per row with its notes; exact height, never wider', () => {
  const p = agent('claude', { harness: 'claude', activity: 'busy', pending: 1, workspace: { model: 'claude-opus-5-5', cwd: null, cwdSource: null, observedAt: null,
    git: { status: 'ok', root: 'X:/r', worktree: null, branch: 'sprint/6.8', detached: false, head: 'abc', dirty: 2, staged: 0, modified: 2, untracked: 0, ahead: null, behind: null, checkedAt: null } } });
  const lines = sidePanelLines([p, agent('astra')], [claude], { width: 32, height: 26, stale: false, mono: false, now: NOW, humanName: 'Kevin' });
  const text = lines.map(lineText);
  assert.equal(lines.length, 26, 'padded to the panel height');
  assert.ok(lines.every((l) => lineCols(l) <= 32), 'no line exceeds the panel width');
  assert.deepEqual(text.slice(1, 6), ['● claude', '  busy · 1 queued', '  ctx ▓▓▓▓░░░░░░ 42.0%', '  opus-5-5 · sprint/6.8*2', '● astra']);
  const u = text.indexOf('PLAN USAGE');
  assert.deepEqual(text.slice(u + 1, u + 7), ['Claude', '  5h ▓░░░░░░░░░ 7.0%', '  weekly ▓▓░░░░░░░░ 21.0%', '  Fable weekly ▓▓░░░░░░░░ 22.0%', '  (ccstatusline, login', '  unverified)'], 'notes wrap, never cut');
  assert.ok(text.includes('you: Kevin'));
});

test('side panel: agents that do not fit become "+N more · /who"; plan usage stays whole; disconnected says last known', () => {
  const many = Array.from({ length: 8 }, (_, i) => agent(`agent${i}`));
  const text = sidePanelLines(many, [claude], { width: 32, height: 18, stale: false, mono: false, now: NOW, humanName: 'Kevin' }).map(lineText);
  const more = text.find((l) => /^\+\d+ more · \/who$/.test(l));
  assert.ok(more, 'overflow is summarised, never silently dropped');
  const shown = text.filter((l) => /^● agent/.test(l)).length;
  assert.equal(Number(more!.match(/\d+/)![0]) + shown, 8);
  assert.ok(text.includes('  Fable weekly ▓▓░░░░░░░░ 22.0%'), 'usage is kept whole');
  const stale = sidePanelLines([agent('astra')], [], { width: 32, height: 8, stale: true, mono: false, now: NOW, humanName: 'Kevin' }).map(lineText);
  assert.equal(stale[0], 'AGENTS · last known');
  assert.equal(stale[1], '◌ astra', 'no live liveness or usage while disconnected');
  assert.equal(stale[2], '  last known: idle');
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
  assert.doesNotMatch(plain(ui.lastFrame()), /PLAN USAGE/, 'starts with the top bar');
  ui.stdin.write('/layout');
  await tick();
  ui.stdin.write('\r');
  await tick();
  let frame = plain(ui.lastFrame());
  assert.match(frame, /AGENTS/);
  assert.match(frame, /PLAN USAGE/);
  assert.match(frame, /Layout: left panel \(remembered\)/);
  ui.stdin.write('\u0002'); // Ctrl+B
  await tick();
  frame = plain(ui.lastFrame());
  assert.doesNotMatch(frame, /PLAN USAGE/);
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
  assert.doesNotMatch(frame, /PLAN USAGE/, 'the conversation keeps a readable width');
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
  assert.equal(lineText(usageBar('weekly', 43, PALETTE.weekly, { stale: false })), 'weekly ▓▓▓▓░░░░░░ 43.0%');
  assert.equal(lineText(usageBar('weekly', 4, PALETTE.weekly, { stale: false })), 'weekly ░░░░░░░░░░ 4.0%', 'a low non-zero reading keeps its number');
  assert.equal(lineText(usageBar('5h', null, PALETTE.fiveHour, { stale: false })), '5h n/a', 'unknown: no bar, never an empty 0% bar');
  const high = usageBar('5h', 95, PALETTE.fiveHour, { stale: false });
  assert.equal(lineText(high), '5h ▓▓▓▓▓▓▓▓▓▓ 95.0%!');
  assert.ok(high.every((s) => s.color === PALETTE.fiveHour), 'label, bar and number share the group colour');
  const stale = usageBar('5h', 95, PALETTE.fiveHour, { stale: true });
  assert.equal(lineText(stale), '5h ▓▓▓▓▓▓▓▓▓▓ 95.0%', 'stale: no warning emphasis');
  assert.ok(stale.every((s) => s.color === undefined && s.dim));
  assert.equal(lineText(usageBar('5h', 43, PALETTE.fiveHour, { stale: false, bar: false })), '5h 43.0%');
  assert.equal(lineText(contextBar(null, { stale: false })), 'ctx n/a');
  assert.equal(lineText(contextBar({ source: 'codex-token-count', status: 'ok', observedAt: null, cumulative: null, context: { usedTokens: 12_000, limitTokens: null, percent: null } }, { stale: false })), 'ctx 12k', 'tokens without a limit: no bar');
});

test('both layouts show the same values; several agents on one subscription still give one account row', () => {
  const two = [agent('claude', { harness: 'claude' }), agent('claude-ui', { harness: 'claude' })];
  const pct = (lines: string[]) => lines.join('\n').match(/\d+\.\d%/g)?.sort();
  const top = [...participantLines(two, { width: 200, stale: false, mono: false, maxLines: 2 }), ...accountLines([claude], { width: 200, mono: false, now: NOW })].map(lineText);
  const left = sidePanelLines(two, [claude], { width: 32, height: 30, stale: false, mono: false, now: NOW, humanName: 'Kevin' }).map(lineText);
  assert.deepEqual(pct(left), pct(top), 'same percentages in both layouts');
  assert.equal(top.filter((l) => l.startsWith('Claude')).length, 1);
  assert.equal(left.filter((l) => l === 'Claude').length, 1);
});
test('review fixes: a short panel degrades usage (no bars/reset rows) then says "more usage", never silently; qualifiers stay on the account row', () => {
  const stale = (harness: 'claude' | 'codex'): AccountUsage => ({ ...claude, status: 'stale', source: 's', account: { ...claude.account, harness, sourceKey: harness },
    buckets: [{ id: harness, windows: [{ kind: 'a', durationMinutes: 300, usedPercent: 38, resetsAt: '2026-09-28T18:00:00Z' }, { kind: 'b', durationMinutes: 10_080, usedPercent: 71, resetsAt: '2026-10-02T09:00:00Z' }] }] });
  const tall = sidePanelLines([], [stale('claude'), stale('codex')], { width: 32, height: 30, stale: false, mono: false, now: NOW, humanName: 'Kevin' }).map(lineText);
  assert.ok(tall.includes('Claude (stale)') && tall.includes('Codex (stale)'), 'the staleness qualifier rides on the account heading');
  assert.ok(tall.some((l) => l.includes('▓')), 'room to spare: bars');
  const short = sidePanelLines([], [stale('claude'), stale('codex')], { width: 32, height: 12, stale: false, mono: false, now: NOW, humanName: 'Kevin' }).map(lineText);
  assert.equal(short.length, 12);
  assert.ok(short.every((l) => !l.includes('▓')), 'short: numbers only');
  assert.ok(short.includes('Codex (stale)'), 'compact form keeps both accounts whole here');
  const tiny = sidePanelLines([], [stale('claude'), stale('codex')], { width: 32, height: 8, stale: false, mono: false, now: NOW, humanName: 'Kevin' }).map(lineText);
  assert.ok(tiny.includes('+ more usage · /layout top'), 'anything cut is announced');
  for (const [i, l] of tiny.entries()) if (/^\s+(5h|weekly)/.test(l)) assert.ok(tiny.slice(0, i).some((h) => /\(stale\)$/.test(h)), 'every shown value has its qualifier above it');
  const token = { source: 'claude-transcript' as const, status: 'stale' as const, observedAt: null, cumulative: null, context: { usedTokens: 12_000, limitTokens: null, percent: null } };
  assert.equal(lineText(contextBar(token, { stale: false })), 'ctx 12k?', 'a stale token-only reading keeps its "?"');
});

test('review fixes: quick successive saves persist the latest choice', async () => {
  const path = join(dir, 'serial', '.room', 'tui.json');
  const results = await Promise.all([saveLayout(path, 'left'), saveLayout(path, 'top'), saveLayout(path, 'left')]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(await readSavedLayout(path), 'left');
});