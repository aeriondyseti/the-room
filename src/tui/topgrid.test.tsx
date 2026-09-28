// 6.10: the organised top bar (Kevin's mockup; top bar only).
import './force-color.js';
import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, cleanup } from 'ink-testing-library';
import type { ParticipantState } from '../contracts/domain.js';
import type { AccountUsage } from '../contracts/account.js';
import { App } from './app.js';
import { demoSource } from './demo.js';
import { lineCols, lineText } from './format.js';
import { agentGrid, budgetGrid } from './topgrid.js';
import { stateDot } from './topbar.js';
import { STATE_COLOR } from './bars.js';
import { readSavedTopBar, saveTopBar } from './prefs.js';
import { helpLines } from './app.js';

afterEach(() => cleanup());
const dir = mkdtempSync(join(tmpdir(), 'vp-topgrid-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const plain = (s: string | undefined) => (s ?? '').replace(/\u001B\[[0-9;]*m/g, '');
const NOW = Date.parse('2026-09-28T16:00:00Z');
const agent = (name: string, over: Partial<ParticipantState> = {}): ParticipantState => ({
  name, harness: 'codex', sessionId: name, liveness: 'online', livenessCheckedAt: null, activity: 'idle', pending: 0,
  usage: { source: 'codex-token-count', status: 'ok', observedAt: null, cumulative: null, context: { usedTokens: 59, limitTokens: 100, percent: 59 } }, ...over,
});
const withWs = (model: string, branch: string, dirty = 0): Partial<ParticipantState> => ({ workspace: { model, cwd: null, cwdSource: null, observedAt: null,
  git: { status: 'ok', root: 'X:/r', worktree: null, branch, detached: false, head: 'abc', dirty, staged: 0, modified: dirty, untracked: 0, ahead: null, behind: null, checkedAt: null } } });
const claude: AccountUsage = {
  account: { harness: 'claude', scope: 'profile', key: 'k', sourceKey: 'k' }, status: 'ok', source: 'shared ccstatusline cache (login unverified)', checkedAt: null, observedAt: null,
  buckets: [
    { id: 'claude', windows: [{ kind: 'five_hour', durationMinutes: 300, usedPercent: 29, resetsAt: '2026-09-28T17:53:00Z' }, { kind: 'seven_day', durationMinutes: 10_080, usedPercent: 24, resetsAt: null }] },
    { id: 'claude-fable', label: 'Fable', windows: [{ kind: 'weekly_fable', durationMinutes: 10_080, usedPercent: 27, resetsAt: null }] },
  ],
};
const codex: AccountUsage = { account: { harness: 'codex', scope: 'account', key: 'c', sourceKey: 'c' }, status: 'stale', source: 'daemon', checkedAt: null, observedAt: null,
  buckets: [{ id: 'codex', windows: [{ kind: 'weekly', durationMinutes: 10_080, usedPercent: 18, resetsAt: null }] }] };
const colOf = (line: string, needle: string) => line.indexOf(needle);

test('AGENTS: a quiet section label, then one aligned row per agent; only the state word is loud; model and branch quiet', () => {
  const rows = agentGrid([agent('astra', withWs('gpt-6-astra', 'main')), agent('claude', { activity: 'busy', ...withWs('claude-opus-5-5', 'sprint/6.9', 3) })], { width: 100, stale: false, maxRows: 6 })!;
  const text = rows.map(lineText);
  assert.equal(text[0], 'AGENTS');
  assert.match(text[1]!, /^ ● astra +idle +ctx {3}59\.0%░░░ +gpt-6-astra +main$/);
  assert.match(text[2]!, /^ ● claude +busy +ctx .* +opus-5-5 +sprint\/6\.9\*3$/);
  for (const needle of ['ctx', 'main']) assert.equal(colOf(text[1]!, needle === 'main' ? 'main' : needle), colOf(text[2]!, needle === 'main' ? 'sprint' : needle), `column "${needle}" lines up`);
  const busy = rows[2]!.find((s) => s.text === 'busy');
  const idle = rows[1]!.find((s) => s.text === 'idle');
  assert.deepEqual([busy?.bold, idle?.bold, idle?.dim], [true, false, false], 'busy loud, idle plain');
  assert.ok(rows[1]!.find((s) => s.text === 'gpt-6-astra')?.dim && rows[2]!.find((s) => s.text === 'sprint/6.9*3')?.dim, 'model and branch are quiet');
});

test('AGENTS: sheds bars, then model, then branch to fit; overflow is "+N more · /who"; disconnected says last known; null when nothing fits', () => {
  const two = [agent('astra', withWs('gpt-6-astra', 'main')), agent('claude', withWs('claude-opus-5-5', 'sprint/6.9'))];
  const narrow = agentGrid(two, { width: 44, stale: false, maxRows: 6 })!.map(lineText);
  assert.ok(narrow.every((l) => l.length <= 44 && !l.includes('░')), narrow.join('\n'));
  assert.ok(narrow.some((l) => l.includes('59.0%')), 'the number is kept');
  const many = Array.from({ length: 9 }, (_, i) => agent(`agent${i}`));
  const capped = agentGrid(many, { width: 100, stale: false, maxRows: 4 })!.map(lineText);
  assert.equal(capped.at(-1), ' +6 more · /who');
  assert.equal(capped.filter((l) => /^ ● agent/.test(l)).length, 3);
  const stale = agentGrid([agent('astra')], { width: 100, stale: true, maxRows: 6 })!.map(lineText);
  assert.deepEqual(stale, ['AGENTS · last known', ' ◌ astra  last known: idle']);
  assert.equal(agentGrid([agent('a-very-long-agent-name-indeed')], { width: 20, stale: false, maxRows: 6 }), null);
});

test('BUDGETS: one row per account; 5h / weekly / Fable weekly named once; model limits as columns on their own account (6.12); "—" for no reading, blank for no such limit', () => {
  const rows = budgetGrid([claude, codex], { width: 120, now: NOW })!;
  const text = rows.map(lineText);
  assert.equal(text.length, 3, 'header + one row per account (no separate Fable row)');
  assert.match(text[0]!, /^BUDGETS +5h +weekly +Fable weekly$/);
  assert.match(text[1]!, /^ Claude +29\.0%░░░ +↻ 1h53m +24\.0%░░░ +27\.0%░░░$/);
  assert.match(text[2]!, /^ Codex +— +18\.0%░░░ +stale$/, 'Codex has no Fable limit: blank cells, not "—"; its caveat stays on its row');
  const barStart = (l: string, pct: string) => l.indexOf(pct) - 2; // the number is centred: two filled cells precede it
  assert.equal(colOf(text[0]!, '5h'), barStart(text[1]!, '29.0%'), '5h header over its column');
  assert.equal(colOf(text[0]!, 'weekly'), barStart(text[2]!, '18.0%'), 'weekly header over its column');
  assert.equal(colOf(text[0]!, 'Fable weekly'), barStart(text[1]!, '27.0%'), 'Fable weekly header over its column');
  assert.equal(colOf(text[2]!, '—'), barStart(text[1]!, '29.0%'), 'the dash sits in the 5h column');
  assert.ok(rows[2]!.every((s) => !s.color), 'stale values: colourless');
  assert.ok(!text.join('\n').includes('unverified'), 'login unverified is hidden (Kevin, 6.10)');
  const fb = budgetGrid([{ ...claude, fallback: true }], { width: 140, now: NOW })!;
  assert.ok(fb[1]!.find((s) => s.text.includes('via statusline, no model limits'))?.dim, 'other caveats: quiet, on the account row');
});

test('6.12: as the width shrinks, bars go 10 → 8 cells (fill recomputed) → plain numbers → fallback, in that order', () => {
  const kind = (width: number): string => {
    const g = budgetGrid([claude, codex], { width, now: NOW });
    if (!g) return 'fallback';
    const t = g.map(lineText).join('\n');
    return t.includes('29.0%░░░') ? '10' : t.includes('29.0%░░') ? '8' : /░/.test(t) ? '?' : 'numbers';
  };
  const seen: string[] = [];
  for (let w = 130; w >= 30; w--) {
    const k = kind(w);
    if (seen.at(-1) !== k) seen.push(k);
  }
  assert.deepEqual(seen, ['10', '8', 'numbers', 'fallback'], 'each step appears, never out of order (round(29/100×8) = 2 cells)');
});
test('BUDGETS: caveats wrap to a continuation row rather than being cut; bars go before that; unavailable says why; null when it cannot fit', () => {
  const mid = budgetGrid([{ ...claude, fallback: true }], { width: 56, now: NOW })!.map(lineText);
  assert.ok(mid.every((l) => l.length <= 56), mid.join('\n'));
  assert.ok(mid.join(' ').replace(/\s+/g, ' ').includes('via statusline, no model limits'), 'the caveat is kept whole (wrapped, not cut)');
  assert.ok(mid.join('\n').includes('29.0%') && mid.join('\n').includes('27.0%'), 'no value is cut');
  const down: AccountUsage = { ...claude, status: 'unavailable', reason: 'no ccstatusline usage cache', buckets: [] };
  assert.match(budgetGrid([down], { width: 120, now: NOW })!.map(lineText)[1]!, /^ Claude +usage unavailable — no ccstatusline usage cache$/);
  assert.equal(budgetGrid([claude], { width: 20, now: NOW }), null, 'too narrow for a grid: the caller falls back to wrapped metric lines');
  assert.deepEqual(budgetGrid([], { width: 80 }), []);
});

test('the dot follows activity for an online agent (green idle, amber busy/approval) and liveness otherwise', () => {
  assert.equal(stateDot(agent('a')).color, STATE_COLOR.ok);
  assert.equal(stateDot(agent('a', { activity: 'busy' })).color, STATE_COLOR.warn);
  assert.equal(stateDot(agent('a', { activity: 'waiting_permission' })).color, STATE_COLOR.warn);
  assert.deepEqual(stateDot(agent('a', { liveness: 'offline' })), { glyph: '○', color: 'gray' });
  assert.equal(stateDot(agent('a', { activity: 'unknown' })).color, 'gray');
});

test('app: the full grid by default; /compact and Ctrl+T switch density and it is remembered; saved choice round-trips', async () => {
  const saved: string[] = [];
  const ui = render(<App source={demoSource()} humanName="Kevin" width={110} height={30} onTopBarChange={async (m) => { saved.push(m); return true; }} />);
  await tick();
  assert.match(plain(ui.lastFrame()), /BUDGETS +5h +weekly/);
  ui.stdin.write('/compact');
  await tick();
  ui.stdin.write('\r');
  await tick();
  let frame = plain(ui.lastFrame());
  assert.doesNotMatch(frame, /BUDGETS/);
  assert.match(frame, /Top bar: compact \(remembered\)/);
  ui.stdin.write('\u0014'); // Ctrl+T
  await tick();
  frame = plain(ui.lastFrame());
  assert.match(frame, /BUDGETS/);
  assert.deepEqual(saved, ['compact', 'full']);
  const path = join(dir, '.room', 'tui.json');
  assert.equal(await saveTopBar(path, 'compact'), true);
  assert.equal(await readSavedTopBar(path), 'compact');
});

test('like pieces line up (Kevin): reset times, caveats and percentages each have their own column', () => {
  const withResets: AccountUsage = { ...claude, fallback: true, buckets: [
    { id: 'claude', windows: [{ kind: 'a', durationMinutes: 300, usedPercent: 29, resetsAt: '2026-09-28T17:53:00Z' }, { kind: 'b', durationMinutes: 10_080, usedPercent: 24, resetsAt: '2026-10-04T08:59:00Z' }] },
    { id: 'claude-fable', label: 'Fable', windows: [{ kind: 'c', durationMinutes: 10_080, usedPercent: 7, resetsAt: '2026-10-04T08:59:00Z' }] }] };
  const other = { ...codex, buckets: [{ id: 'codex', windows: [{ kind: 'w', durationMinutes: 10_080, usedPercent: 18, resetsAt: '2026-10-03T15:09:00Z' }] }] };
  const text = budgetGrid([withResets, other], { width: 160, now: NOW })!.map(lineText);
  const resets = (l: string) => [...l.matchAll(/↻/g)].map((m) => m.index);
  assert.equal(resets(text[1]!)[1], resets(text[2]!)[0], `weekly resets share a column:\n${text.join('\n')}`);
  assert.equal(colOf(text[1]!, 'via statusline'), colOf(text[2]!, 'stale'), 'caveats share a column');
  assert.equal(text[2]!.indexOf('18.0%'), text[1]!.indexOf('24.0%'), 'weekly percentages line up');
  assert.ok(text[1]!.includes('7.0%'), 'the Fable value renders');
});
test('help keys never run into their descriptions (measured key column)', () => {
  for (const line of helpLines().filter((l) => l.length === 2)) assert.match(line[0]!.text, / {2}$/, `"${line[0]!.text}" keeps a gap before its description`);
});

test('the grid yields to the wrapping chips on a short terminal and while an overlay is open (the saved density is kept)', async () => {
  const short = render(<App source={demoSource()} humanName="Kevin" width={110} height={16} />);
  await tick();
  assert.doesNotMatch(plain(short.lastFrame()), /AGENTS/, 'too short for the grid: the conversation keeps its rows');
  cleanup();
  const tall = render(<App source={demoSource()} humanName="Kevin" width={110} height={34} />);
  await tick();
  assert.match(plain(tall.lastFrame()), /AGENTS/);
  tall.stdin.write('?');
  await tick();
  assert.doesNotMatch(plain(tall.lastFrame()), /AGENTS/, 'help gets the room');
  tall.stdin.write('\u001B');
  await tick();
  assert.match(plain(tall.lastFrame()), /AGENTS/, 'and the grid comes back');
});
test('review fix: a limit that was hit (100.0%) still lines up its decimal with the other rows', () => {
  const full: AccountUsage = { ...codex, status: 'ok', buckets: [{ id: 'codex', windows: [{ kind: 'w', durationMinutes: 10_080, usedPercent: 100, resetsAt: null }] }] };
  const low: AccountUsage = { ...claude, buckets: [{ id: 'claude', windows: [{ kind: 'b', durationMinutes: 10_080, usedPercent: 7, resetsAt: null }] }] };
  const text = budgetGrid([low, full], { width: 120, now: NOW })!.map(lineText);
  assert.equal(text[1]!.indexOf('7.0%') + 1, text[2]!.indexOf('100.0%') + 3, `decimal points share a column:\n${text.join('\n')}`);
});
test('6.11: the reset arrow is followed by a space (it renders wider than one cell in some terminals)', () => {
  const text = budgetGrid([claude], { width: 120, now: NOW })!.map(lineText).join('\n');
  assert.ok(text.includes('↻ 1h53m'));
  assert.doesNotMatch(text, /↻\S/, 'never glued to the time');
});
test('6.12 review: every window of a model bucket gets a column — a Codex model limit keeps its 5h reading (nothing dropped)', () => {
  const spark: AccountUsage = { ...codex, status: 'ok', buckets: [
    { id: 'codex', windows: [{ kind: 'p', durationMinutes: 300, usedPercent: 20, resetsAt: null }, { kind: 's', durationMinutes: 10_080, usedPercent: 18, resetsAt: null }] },
    { id: 'spark', label: 'Spark', windows: [{ kind: 'p', durationMinutes: 300, usedPercent: 61, resetsAt: null }, { kind: 's', durationMinutes: 10_080, usedPercent: 12, resetsAt: null }] },
  ] };
  const text = budgetGrid([claude, spark], { width: 200, now: NOW })!.map(lineText);
  assert.match(text[0]!, /Fable weekly +Spark 5h +Spark weekly$/, text.join('\n'));
  assert.ok(text[2]!.includes('61.0%') && text[2]!.includes('12.0%'), 'the Spark 5h reading is shown, not dropped');
  assert.equal(text[2]!.indexOf('61.0%') - text[0]!.indexOf('Spark 5h') < 12, true, 'under its own header');
});

test('6.12 review / 6.14: empty columns take no space; bar size is monotonic in width (a narrower terminal never gets bigger bars); caveats wrap whole', () => {
  const g = budgetGrid([claude, codex], { width: 200, now: NOW })!.map(lineText);
  assert.match(g[1]!, /24\.0%░░░ {4}27\.0%/, `one gap (plus the bar's two filled cells) between columns, none doubled by an all-empty reset column:\n${g.join('\n')}`);
  const long: AccountUsage = { ...claude, fallback: true };
  const size = (w: number) => {
    const t = budgetGrid([long, codex], { width: w, now: NOW });
    if (!t) return 0;
    const s = t.map(lineText).join('\n');
    return s.includes('29.0%░░░') ? 10 : s.includes('29.0%░░') ? 8 : 1;
  };
  let prev = Infinity;
  for (let w = 160; w >= 30; w--) {
    const s = size(w);
    assert.ok(s <= prev, `width ${w}: bars grew from ${prev} to ${s} cells as the terminal narrowed`);
    prev = s;
  }
  const tight = budgetGrid([long], { width: 72, now: NOW })!.map(lineText);
  assert.ok(tight.join('\n').includes('29.0%'), 'values still shown');
  assert.ok(tight.join(' ').replace(/\s+/g, ' ').includes('via statusline, no model limits'), 'the caveat is kept whole');
});
test('6.12 cross-review: two distinct buckets with the same label are both shown, under visibly distinct headers', () => {
  const twoSparks: AccountUsage = { ...codex, status: 'ok', buckets: [
    { id: 'codex', windows: [{ kind: 's', durationMinutes: 10_080, usedPercent: 18, resetsAt: null }] },
    { id: 'model-a', label: 'Spark', windows: [{ kind: 'p', durationMinutes: 300, usedPercent: 10, resetsAt: null }] },
    { id: 'model-b', label: 'Spark', windows: [{ kind: 'p', durationMinutes: 300, usedPercent: 80, resetsAt: null }] },
  ] };
  const text = budgetGrid([twoSparks], { width: 200, now: NOW })!.map(lineText);
  assert.ok(text[1]!.includes('10.0%') && text[1]!.includes('80.0%'), `both readings survive:\n${text.join('\n')}`);
  assert.match(text[0]!, /Spark 5h \[model-a\] +Spark 5h \[model-b\]/);
});