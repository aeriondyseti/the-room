// Transcript timings can lag the reply (Claude flushes its transcript asynchronously), so timings are recomputed
// after the run. `node refine.mjs <results.json>` re-derives them for a saved run and rewrites its .json and .md.
import { readFileSync, writeFileSync } from 'node:fs';
import { transcriptTimes } from './claude-fixture.mjs';
import { report } from './report.mjs';

export function refine(results) {
  const sid = Object.fromEntries(results.fixtures.map((f) => [f.name, f.sessionId]));
  for (const row of [...results.trials, ...results.soak]) {
    if (row.harness !== 'claude' || !sid[row.fixture]) continue;
    const t0 = Date.parse(row.createdAt);
    const t = transcriptTimes(sid[row.fixture], row.messageId, t0);
    const ms = (v) => (v == null ? null : v - t0);
    row.receivedMs ??= ms(t.receivedAt);
    row.promptMs ??= ms(t.promptAt);
    row.turnStartMs ??= ms(t.turnStartAt);
  }
  return results;
}

if (process.argv[1]?.endsWith('refine.mjs')) {
  const path = process.argv[2];
  const results = refine(JSON.parse(readFileSync(path, 'utf8')));
  writeFileSync(path, JSON.stringify(results, null, 1));
  writeFileSync(path.replace(/\.json$/, '.md'), report(results));
  console.log('refined', path);
}
