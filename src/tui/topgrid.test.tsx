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
  assert.match(text[1]!, /^ ● astra +idle +ctx ▓{6}░{4} 59\.0% +gpt-6-astra +main$/);
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
  assert.ok(narrow.every((l) => l.length <= 44 && !l.includes('▓')), narrow.join('\n'));
  assert.ok(narrow.some((l) => l.includes('59.0%')), 'the number is kept');
  const many = Array.from({ length: 9 }, (_, i) => agent(`agent${i}`));
  const capped = agentGrid(many, { width: 100, stale: false, maxRows: 4 })!.map(lineText);
  assert.equal(capped.at(-1), ' +6 more · /who');
  assert.equal(capped.filter((l) => /^ ● agent/.test(l)).length, 3);
  const stale = agentGrid([agent('astra')], { width: 100, stale: true, maxRows: 6 })!.map(lineText);
  assert.deepEqual(stale, ['AGENTS · last known', ' ◌ astra  last known: idle']);
  assert.equal(agentGrid([agent('a-very-long-agent-name-indeed')], { width: 20, stale: false, maxRows: 6 }), null);
});

test('BUDGETS: 5h / weekly named once; one row per limit; "—" where there is no reading; caveats quiet at the end of the account row', () => {
  const rows = budgetGrid([claude, codex], { width: 120, now: NOW })!;
  const text = rows.map(lineText);
  assert.match(text[0]!, /^BUDGETS +5h +weekly$/);
  assert.match(text[1]!, /^ Claude +▓▓▓░{7} 29\.0% +↻1h53m +▓▓░{8} 24\.0% +login unverified$/);
  assert.match(text[2]!, /^ Fable +— +▓▓▓░{7} 27\.0%$/);
  assert.match(text[3]!, /^ Codex +— +▓▓░{8} 18\.0% +stale$/);
  assert.equal(colOf(text[0]!, '5h'), colOf(text[1]!, '▓'), '5h header over its column');
  assert.equal(colOf(text[0]!, 'weekly'), colOf(text[2]!, '▓'), 'weekly header over its column');
  assert.equal(colOf(text[2]!, '—'), colOf(text[1]!, '▓'), 'the dash sits in the 5h column');
  assert.ok(rows[3]!.every((s) => !s.color), 'stale values: colourless');
  assert.ok(rows[1]!.find((s) => s.text.includes('login unverified'))?.dim);
});

test('BUDGETS: caveats wrap to a continuation row rather than being cut; bars go before that; unavailable says why; null when it cannot fit', () => {
  const mid = budgetGrid([claude], { width: 56, now: NOW })!.map(lineText);
  assert.ok(mid.every((l) => l.length <= 56), mid.join('\n'));
  assert.ok(mid.some((l) => l.trim() === 'login unverified') || mid.some((l) => /login unverified$/.test(l)), 'the caveat is kept whole');
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
  const withResets: AccountUsage = { ...claude, buckets: [
    { id: 'claude', windows: [{ kind: 'a', durationMinutes: 300, usedPercent: 29, resetsAt: '2026-09-28T17:53:00Z' }, { kind: 'b', durationMinutes: 10_080, usedPercent: 24, resetsAt: '2026-10-04T08:59:00Z' }] },
    { id: 'claude-fable', label: 'Fable', windows: [{ kind: 'c', durationMinutes: 10_080, usedPercent: 7, resetsAt: '2026-10-04T08:59:00Z' }] }] };
  const text = budgetGrid([withResets, { ...codex, buckets: [{ id: 'codex', windows: [{ kind: 'w', durationMinutes: 10_080, usedPercent: 18, resetsAt: '2026-10-03T15:09:00Z' }] }] }], { width: 120, now: NOW })!.map(lineText);
  const weeklyResets = text.slice(1).map((l) => l.lastIndexOf('↻'));
  assert.equal(new Set(weeklyResets).size, 1, `weekly resets share a column:\n${text.join('\n')}`);
  assert.equal(colOf(text[1]!, 'login unverified'), colOf(text[3]!, 'stale'), 'caveats share a column');
  assert.equal(text[2]!.indexOf(' 7.0%'), text[1]!.lastIndexOf('24.0%'), 'percentages are right-aligned (decimals line up)');
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