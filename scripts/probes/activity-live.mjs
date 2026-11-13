// 6.1 live check: a throwaway fixture's real transcript → service ActivityReader → `activity` request + live events.
// Throwaway fixture + scratch room only.   node scripts/probes/activity-live.mjs
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeRoot, start } from '../acceptance/claude-fixture.mjs';

const dist = resolve('dist');
const { RoomClient } = await import(pathToFileURL(`${dist}/ipc/client.js`).href);
const root = makeRoot('activity');
const client = await RoomClient.connect(root, { client: 'tui' });
const events = [];
client.onEvent((e) => { if (e.type === 'activity.appended') events.push(e); });
await client.request('subscribe', {});
const whoIs = async (n, sid) => (await client.request('who', {})).participants.some((p) => p.name === n && p.sessionId === sid);
let fx;
try {
  fx = await start({ name: 'fxv', root, dist: `${dist}/cli/main.js`, whoIs });
  await client.request('send', { caller: { kind: 'human' }, to: ['fxv'], body: 'activity check: reply ack', clientMessageId: `act-${Date.now()}` });
  const deadline = Date.now() + 90_000;
  let page;
  while (Date.now() < deadline) {
    page = await client.request('activity', { participant: 'fxv', limit: 50 });
    if (page.items.some((i) => i.kind === 'tool_result' && i.tool === undefined) && page.items.filter((i) => i.tool === 'roundtable.roundtable_send').length) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(JSON.stringify({ coverage: page.coverage, reason: page.reason ?? null, olderEvicted: page.olderEvicted, backlog: page.backlog, stream: page.stream,
    items: page.items.map((i) => `${i.seq} ${i.kind}${i.tool ? ' ' + i.tool : ''}${i.role ? ' ' + i.role : ''}${i.isError ? ' ERR' : ''} | ${i.summary.slice(0, 70)}`),
    liveEvents: events.length, liveItems: events.reduce((n, e) => n + e.items.length, 0) }, null, 1));
} finally {
  await fx?.stop().catch((e) => console.error('stop failed:', e.message));
  try { await client.request('shutdown', { caller: { kind: 'human' } }); } catch (e) { console.error('shutdown failed:', e.message); }
  client.close();
}
