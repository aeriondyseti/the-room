import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newCursor, readRecords } from './record-tail.js';

const dir = mkdtempSync(join(tmpdir(), 'vp-record-tail-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => join(dir, `t${n++}.jsonl`);
const line = (o: unknown) => JSON.stringify(o) + '\n';

test('reads complete records with their byte offsets; a partial trailing line waits', async () => {
  const p = file();
  writeFileSync(p, line({ a: 1 }) + line({ b: 2 }) + '{"c":');
  const c = newCursor(p);
  const r = await readRecords(c);
  assert.deepEqual(r.records.map((x) => x.value), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(r.records.map((x) => x.offset), [0, line({ a: 1 }).length]);
  appendFileSync(p, '3}\n');
  const r2 = await readRecords(c);
  assert.deepEqual(r2.records.map((x) => x.value), [{ c: 3 }]);
  assert.equal(r2.records[0]!.offset, line({ a: 1 }).length + line({ b: 2 }).length);
});

test('a same-size (or larger) replacement is a rotation, not a silent continuation', async () => {
  const p = file();
  writeFileSync(p, line({ id: 'old-1' }) + line({ id: 'old-2' }));
  const c = newCursor(p);
  await readRecords(c);
  const repl = join(dir, 'replacement.jsonl');
  writeFileSync(repl, line({ id: 'new-1' }) + line({ id: 'new-2' }) + line({ id: 'new-3' }));
  renameSync(repl, p);
  const r = await readRecords(c);
  assert.equal(r.rotated, true);
  assert.deepEqual(r.records.map((x) => (x.value as { id: string }).id), ['new-1', 'new-2', 'new-3']);
});

test('in-place rewrite with identical size but different content is detected via the head hash', async () => {
  const p = file();
  writeFileSync(p, line({ id: 'aaaa' }));
  const c = newCursor(p);
  await readRecords(c);
  writeFileSync(p, line({ id: 'bbbb' }) + line({ id: 'cccc' }));
  const r = await readRecords(c);
  assert.equal(r.rotated, true);
  assert.deepEqual(r.records.map((x) => (x.value as { id: string }).id), ['bbbb', 'cccc']);
});

test('an oversized line is skipped to its newline, even across reads; the next record parses cleanly', async () => {
  const p = file();
  const huge = JSON.stringify({ blob: 'x'.repeat(5000) });
  writeFileSync(p, line({ before: true }) + huge.slice(0, 3000));
  const c = newCursor(p);
  const r1 = await readRecords(c, { maxLineBytes: 1000, maxBytes: 4096 });
  assert.deepEqual(r1.records.map((x) => x.value), [{ before: true }]);
  assert.equal(r1.oversized, 1);
  appendFileSync(p, huge.slice(3000) + '\n' + line({ after: true }));
  const r2 = await readRecords(c, { maxLineBytes: 1000, maxBytes: 4096 });
  assert.deepEqual(r2.records.map((x) => x.value), [{ after: true }], 'never parsed from the middle of the huge line');
  assert.equal(r2.oversized, 0, 'the same oversized line is counted once');
});

test('malformed lines are counted, never returned as text; backlog reports unread bytes', async () => {
  const p = file();
  writeFileSync(p, 'not json\n' + line({ ok: 1 }) + line({ ok: 2 }) + line({ ok: 3 }));
  const c = newCursor(p);
  const r = await readRecords(c, { maxBytes: 20 });
  assert.equal(r.malformed, 1);
  assert.equal(r.backlog, true);
  const rest = await readRecords(c);
  assert.equal(rest.backlog, false);
  assert.deepEqual([...r.records, ...rest.records].map((x) => x.value), [{ ok: 1 }, { ok: 2 }, { ok: 3 }]);
});

test('a missing file is reported as not existing and leaves the cursor untouched', async () => {
  const c = newCursor(join(dir, 'nope.jsonl'));
  const r = await readRecords(c);
  assert.equal(r.exists, false);
  assert.equal(c.offset, 0);
});
