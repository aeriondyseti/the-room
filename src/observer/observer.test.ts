import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageObserver } from './observer.js';
import { parseClaudeRecord, parseCodexRecord } from './parsers.js';
import { readNew } from './jsonl-tail.js';

const root = mkdtempSync(join(tmpdir(), 'vp-observer-'));
after(() => rmSync(root, { recursive: true, force: true }));

const NOW = Date.parse('2026-09-28T06:00:00.000Z');
const T = (min: number) => new Date(NOW - min * 60_000).toISOString();

// Shapes captured from Claude Code 2.1.283 / Codex 0.157.1 transcripts (trimmed to the fields we read).
const claudeLine = (id: string, at: string, u: { in: number; out: number; cw: number; cr: number }) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at,
    message: {
      id,
      model: 'claude-opus-5-5',
      usage: { input_tokens: u.in, output_tokens: u.out, cache_creation_input_tokens: u.cw, cache_read_input_tokens: u.cr },
    },
  }) + '\n';
const codexLine = (at: string, total: { in: number; cached: number; out: number }, lastIn: number, window = 342000) =>
  JSON.stringify({
    timestamp: at,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: total.in, cached_input_tokens: total.cached, cache_write_input_tokens: 0, output_tokens: total.out },
        last_token_usage: { input_tokens: lastIn, cached_input_tokens: 0, output_tokens: 10 },
        model_context_window: window,
      },
      rate_limits: { primary: { used_percent: 6.0, window_minutes: 10080 } },
    },
  }) + '\n';

function dirs() {
  const base = mkdtempSync(join(root, 'case-'));
  const claudeProjectsDir = join(base, 'claude', 'projects');
  const codexSessionsDir = join(base, 'codex', 'sessions');
  mkdirSync(claudeProjectsDir, { recursive: true });
  mkdirSync(codexSessionsDir, { recursive: true });
  const observer = new UsageObserver({ claudeProjectsDir, codexSessionsDir, staleMs: 15 * 60_000, now: () => NOW });
  return { claudeProjectsDir, codexSessionsDir, observer };
}

test('Claude: sums per-response usage across the session files, dedupes streamed repeats, context from newest', async () => {
  const d = dirs();
  const a = join(d.claudeProjectsDir, 'X--repo');
  const b = join(d.claudeProjectsDir, 'X--repo--claude-worktrees-sprint');
  mkdirSync(a);
  mkdirSync(b);
  // Streamed: the same message id appears on consecutive lines with identical usage — count once.
  writeFileSync(join(a, 'sess.jsonl'), claudeLine('m1', T(20), { in: 2, out: 100, cw: 50, cr: 1000 }) + claudeLine('m1', T(20), { in: 2, out: 100, cw: 50, cr: 1000 }) + '{"type":"user"}\n');
  writeFileSync(join(b, 'sess.jsonl'), claudeLine('m2', T(1), { in: 3, out: 200, cw: 10, cr: 5000 }));
  writeFileSync(join(b, 'other-session.jsonl'), claudeLine('zz', T(1), { in: 999, out: 999, cw: 0, cr: 0 }));
  const snap = await d.observer.snapshot({ harness: 'claude', sessionId: 'sess' });
  assert.equal(snap.status, 'ok');
  assert.equal(snap.source, 'claude-transcript');
  assert.deepEqual(snap.cumulative, { input: 5, output: 300, cacheRead: 6000, cacheWrite: 60 });
  assert.deepEqual(snap.context, { usedTokens: 5013, limitTokens: null, percent: null }, 'no guessed limit/percent');
  assert.equal(snap.observedAt, T(1));
});

test('Claude: a configured per-model limit yields a percentage; unknown models stay null', async () => {
  const d = dirs();
  const p = join(d.claudeProjectsDir, 'X--repo');
  mkdirSync(p);
  writeFileSync(join(p, 'lim.jsonl'), claudeLine('m1', T(1), { in: 0, out: 1, cw: 0, cr: 250_000 }));
  const o = new UsageObserver({ claudeProjectsDir: d.claudeProjectsDir, codexSessionsDir: d.codexSessionsDir, staleMs: 15 * 60_000, now: () => NOW, contextLimits: { 'claude-opus-5-5': 1_000_000 } });
  assert.deepEqual((await o.snapshot({ harness: 'claude', sessionId: 'lim' })).context, { usedTokens: 250_000, limitTokens: 1_000_000, percent: 25 });
  const none = new UsageObserver({ claudeProjectsDir: d.claudeProjectsDir, codexSessionsDir: d.codexSessionsDir, staleMs: 15 * 60_000, now: () => NOW, contextLimits: { 'other-model': 5 } });
  assert.equal((await none.snapshot({ harness: 'claude', sessionId: 'lim' })).context?.percent, null);
});

test('Codex: cumulative totals with cached split out, context percent from the reported window', async () => {
  const d = dirs();
  const day = join(d.codexSessionsDir, '2026', '09', '27');
  mkdirSync(day, { recursive: true });
  const file = join(day, 'rollout-2026-09-27T22-18-11-thread-1.jsonl');
  writeFileSync(file, '{"type":"event_msg","payload":{"type":"token_count","info":null}}\n' + codexLine(T(5), { in: 1000, cached: 800, out: 50 }, 171000));
  const snap = await d.observer.snapshot({ harness: 'codex', sessionId: 'thread-1' });
  assert.equal(snap.status, 'ok');
  assert.deepEqual(snap.cumulative, { input: 200, output: 50, cacheRead: 800, cacheWrite: 0 });
  assert.deepEqual(snap.context, { usedTokens: 171000, limitTokens: 342000, percent: 50 });
  appendFileSync(file, codexLine(T(2), { in: 3000, cached: 2000, out: 90 }, 34200));
  const next = await d.observer.snapshot({ harness: 'codex', sessionId: 'thread-1' });
  assert.deepEqual(next.cumulative, { input: 1000, output: 90, cacheRead: 2000, cacheWrite: 0 }, 'latest total wins, not summed');
  assert.equal(next.context?.percent, 10);
});

test('missing transcripts are unavailable, never zero', async () => {
  const d = dirs();
  for (const harness of ['claude', 'codex'] as const) {
    const snap = await d.observer.snapshot({ harness, sessionId: 'nobody' });
    assert.equal(snap.status, 'unavailable');
    assert.equal(snap.cumulative, null);
    assert.equal(snap.context, null);
    assert.ok(snap.reason);
  }
  const noUsage = join(d.claudeProjectsDir, 'X--repo');
  mkdirSync(noUsage);
  writeFileSync(join(noUsage, 'fresh.jsonl'), '{"type":"user"}\n');
  const snap = await d.observer.snapshot({ harness: 'claude', sessionId: 'fresh' });
  assert.equal(snap.status, 'unavailable');
  assert.equal(snap.reason, 'no usage recorded yet');
});

test('old readings are labelled stale but keep their values', async () => {
  const d = dirs();
  const p = join(d.claudeProjectsDir, 'X--repo');
  mkdirSync(p);
  writeFileSync(join(p, 'old.jsonl'), claudeLine('m1', T(60), { in: 1, out: 1, cw: 0, cr: 0 }));
  const snap = await d.observer.snapshot({ harness: 'claude', sessionId: 'old' });
  assert.equal(snap.status, 'stale');
  assert.deepEqual(snap.cumulative, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
});

test('partial trailing lines wait for completion; truncation restarts cleanly', async () => {
  const d = dirs();
  const p = join(d.claudeProjectsDir, 'X--repo');
  mkdirSync(p);
  const file = join(p, 's.jsonl');
  const full = claudeLine('m1', T(1), { in: 1, out: 10, cw: 0, cr: 0 });
  writeFileSync(file, full + full.slice(0, 20)); // second line incomplete
  assert.equal((await d.observer.snapshot({ harness: 'claude', sessionId: 's' })).cumulative?.output, 10);
  appendFileSync(file, full.slice(20).replace('"m1"', '"m1"')); // completes a repeat of m1 → deduped
  assert.equal((await d.observer.snapshot({ harness: 'claude', sessionId: 's' })).cumulative?.output, 10);
  writeFileSync(file, claudeLine('m9', T(1), { in: 1, out: 7, cw: 0, cr: 0 })); // replaced with shorter content
  assert.equal((await d.observer.snapshot({ harness: 'claude', sessionId: 's' })).cumulative?.output, 7, 'restarted from 0');
});

test('cursors export and restore: a new observer continues without double counting', async () => {
  const d = dirs();
  const p = join(d.claudeProjectsDir, 'X--repo');
  mkdirSync(p);
  const file = join(p, 'r.jsonl');
  writeFileSync(file, claudeLine('m1', T(3), { in: 1, out: 10, cw: 0, cr: 0 }));
  await d.observer.snapshot({ harness: 'claude', sessionId: 'r' });
  const cursors = d.observer.exportCursors();
  assert.equal(cursors.length, 1);
  assert.equal(cursors[0]?.lastMessageId, 'm1');

  const again = new UsageObserver({ claudeProjectsDir: d.claudeProjectsDir, codexSessionsDir: d.codexSessionsDir, staleMs: 15 * 60_000, now: () => NOW });
  again.restoreCursors(cursors);
  // The streamed repeat of m1 lands after the restart, then a new message.
  appendFileSync(file, claudeLine('m1', T(3), { in: 1, out: 10, cw: 0, cr: 0 }) + claudeLine('m2', T(1), { in: 1, out: 5, cw: 0, cr: 0 }));
  const snap = await again.snapshot({ harness: 'claude', sessionId: 'r' });
  assert.equal(snap.cumulative?.output, 15);
});

test('parsers reject unknown shapes with null (never zero)', () => {
  assert.equal(parseClaudeRecord({ type: 'assistant', message: { id: 'x' } }), null);
  assert.equal(parseClaudeRecord({ type: 'assistant', message: { id: 'x', usage: { input_tokens: -1, output_tokens: 1 } } }), null);
  assert.equal(parseClaudeRecord('nope'), null);
  assert.equal(parseCodexRecord({ type: 'event_msg', payload: { type: 'token_count', info: null } }), null);
  assert.equal(parseCodexRecord({ type: 'response_item', payload: {} }), null);
  const noWindow = parseCodexRecord(JSON.parse(codexLine(T(0), { in: 10, cached: 0, out: 1 }, 5, 0)));
  assert.equal(noWindow?.contextLimit, null, 'a zero window is treated as unknown');
});

test('readNew skips unparsable lines and reports missing files', async () => {
  const file = join(root, 'tail.jsonl');
  writeFileSync(file, '{"a":1}\nnot json\n{"b":2}\n');
  const cursor = { path: file, offset: 0 };
  const r = await readNew(cursor);
  assert.equal(r.records.length, 2);
  assert.equal(r.skippedLines, 1);
  assert.equal((await readNew({ path: join(root, 'nope.jsonl'), offset: 0 })).exists, false);
  const small = join(root, 'long.jsonl');
  writeFileSync(small, 'x'.repeat(50));
  const c2 = { path: small, offset: 0 };
  assert.equal((await readNew(c2, 10)).skippedLines, 1, 'an over-long line is skipped, not stalled on');
});
