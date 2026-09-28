import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityReader, type ActivityReaderOptions } from './activity-reader.js';
import { claudeActivityParser } from './claude-activity.js';

const root = mkdtempSync(join(tmpdir(), 'vp-activity-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

function setup(over: Partial<ActivityReaderOptions> = {}) {
  const projects = join(root, `p${n++}`);
  mkdirSync(join(projects, 'proj'), { recursive: true });
  const reader = new ActivityReader({
    claudeProjectsDir: projects, codexSessionsDir: join(root, 'none'), parsers: [claudeActivityParser],
    detailBytes: 4096, windowItems: 100, startBytes: 1024 * 1024, maxLineBytes: 64 * 1024, readBytes: 1024 * 1024, ...over,
  });
  const file = (sid: string) => join(projects, 'proj', `${sid}.jsonl`);
  return { reader, file };
}
const T = '2026-09-28T10:00:00.000Z';
const call = (id: string, name = 'Bash') => JSON.stringify({ type: 'assistant', timestamp: T, message: { content: [{ type: 'tool_use', id, name, input: { command: `echo ${id}` } }] } }) + '\n';
const result = (id: string, text = 'ok') => JSON.stringify({ type: 'user', timestamp: T, message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } }) + '\n';
const target = (sessionId = 's1') => ({ participant: 'fxa', harness: 'claude' as const, sessionId });

test('polls new activity with monotonic seq; pages forward and backward', async () => {
  const { reader, file } = setup();
  writeFileSync(file('s1'), call('a') + result('a'));
  const first = await reader.poll(target());
  assert.deepEqual(first.items.map((i) => [i.seq, i.kind, i.callId]), [[1, 'tool_call', 'a'], [2, 'tool_result', 'a']]);
  appendFileSync(file('s1'), call('b') + result('b', 'done'));
  const second = await reader.poll(target());
  assert.deepEqual(second.items.map((i) => i.seq), [3, 4]);
  const page = reader.page({ participant: 'fxa', afterSeq: 2, limit: 10 });
  assert.deepEqual(page.items.map((i) => i.seq), [3, 4]);
  assert.equal(page.coverage, 'full');
  const back = reader.page({ participant: 'fxa', beforeSeq: 4, limit: 2 });
  assert.deepEqual(back.items.map((i) => i.seq), [2, 3]);
  assert.equal(back.hasMore, true);
  assert.equal(back.olderEvicted, false);
});

test('a bounded window evicts old items and says so; a large transcript starts near its end', async () => {
  const { reader, file } = setup({ windowItems: 3 });
  writeFileSync(file('s1'), ['a', 'b', 'c', 'd'].map((x) => call(x)).join(''));
  await reader.poll(target());
  const page = reader.page({ participant: 'fxa', limit: 10 });
  assert.deepEqual(page.items.map((i) => i.callId), ['b', 'c', 'd']);
  assert.equal(page.olderEvicted, true, 'older history is unavailable, not empty');

  const big = setup({ startBytes: 200 });
  writeFileSync(big.file('s1'), Array.from({ length: 20 }, (_, i) => call(`x${i}`)).join(''));
  const r = await big.reader.poll(target());
  assert.ok(r.items.length > 0 && r.items.length < 20, 'only the tail was loaded');
  assert.equal(big.reader.page({ participant: 'fxa', limit: 50 }).olderEvicted, true);
});

test('rebind to a new session and file rotation start new generations; stale cursors get reset', async () => {
  const { reader, file } = setup();
  writeFileSync(file('s1'), call('a'));
  const one = await reader.poll(target('s1'));
  writeFileSync(file('s2'), call('z'));
  const two = await reader.poll(target('s2'));
  assert.equal(two.stream.generation, one.stream.generation + 1);
  assert.equal(two.items[0]!.seq, 1);
  assert.equal(reader.page({ participant: 'fxa', stream: one.stream, afterSeq: 1 }).reset, true);

  const repl = file('s2') + '.new';
  writeFileSync(repl, call('r1') + call('r2') + call('r3'));
  renameSync(repl, file('s2'));
  const three = await reader.poll(target('s2'));
  assert.equal(three.stream.generation, two.stream.generation + 1, 'rotation is a new generation');
  assert.deepEqual(three.items.map((i) => i.callId), ['r1', 'r2', 'r3']);
});

test('persisted cursors resume exactly: no repeats and no gaps after a restart', async () => {
  const a = setup();
  writeFileSync(a.file('s1'), call('a') + call('b'));
  await a.reader.poll(target());
  const saved = JSON.parse(JSON.stringify(a.reader.export()));
  appendFileSync(a.file('s1'), call('c'));
  const b = new ActivityReader({ claudeProjectsDir: join(a.file('s1'), '..', '..'), codexSessionsDir: join(root, 'none'), parsers: [claudeActivityParser], detailBytes: 4096, windowItems: 100, startBytes: 1024 * 1024, maxLineBytes: 64 * 1024, readBytes: 1024 * 1024 });
  b.restore(saved);
  const r = await b.poll(target());
  assert.deepEqual(r.items.map((i) => [i.seq, i.callId]), [[3, 'c']]);
  assert.equal(b.page({ participant: 'fxa', limit: 10 }).olderEvicted, true, 'pre-restart items are unavailable, not missing silently');
});

test('coverage is honest: missing transcript → unavailable; unknown/malformed records → partial with a reason', async () => {
  const { reader, file } = setup();
  await reader.poll(target('nobody'));
  const none = reader.page({ participant: 'fxa' });
  assert.equal(none.coverage, 'unavailable');
  assert.match(none.reason ?? '', /no transcript/);

  writeFileSync(file('s1'), call('a') + '{broken\n' + JSON.stringify({ type: 'mystery-v2' }) + '\n' + JSON.stringify({ type: 'queue-operation' }) + '\n');
  await reader.poll(target('s1'));
  const page = reader.page({ participant: 'fxa' });
  assert.equal(page.coverage, 'partial');
  assert.match(page.reason ?? '', /1 unrecognised record.*1 malformed line/);
  assert.doesNotMatch(JSON.stringify(page), /\{broken/, 'raw malformed text is never surfaced');
});
