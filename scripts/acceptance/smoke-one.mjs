// Smoke: one throwaway Claude fixture joins a scratch room, gets one human message, replies. Prints timings.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeRoot, start } from './claude-fixture.mjs';

const dist = resolve('dist/cli/main.js');
const { RoomClient } = await import(pathToFileURL(resolve('dist/ipc/client.js')).href);
const root = makeRoot('smoke');
console.log('room root', root);
const client = await RoomClient.connect(root, { client: 'tui' });
const whoIs = async (name, sid) => (await client.request('who', {})).participants.some((p) => p.name === name && p.sessionId === sid);
let fx;
try {
  fx = await start({ name: 'fxa', root, dist, whoIs });
  console.log('joined', fx.name, fx.sessionId, 'pid', fx.pid, 'status', fx.status());
  await new Promise((r) => setTimeout(r, 3000));
  const sent = await client.request('send', { caller: { kind: 'human' }, body: 'trial 1: reply ack', to: ['fxa'], clientMessageId: `smoke-${Date.now()}` });
  const id = sent.message.id; const t0 = Date.parse(sent.message.createdAt);
  const deadline = Date.now() + 120_000;
  let reply = null; let deliveries = null;
  while (Date.now() < deadline && !reply) {
    await new Promise((r) => setTimeout(r, 500));
    deliveries = (await client.request('deliveries', { messageId: id })).deliveries;
    const page = await client.request('read', { afterSeq: sent.message.seq, limit: 20 });
    reply = page.items.find((i) => i.message.replyTo === id)?.message ?? null;
  }
  const d = deliveries?.[0];
  const submitted = d?.attempts?.find((a) => a.outcome === 'submitted');
  console.log(JSON.stringify({ state: d?.state, attempts: d?.attempts, turnStart: await fx.turnStartedAt(id, t0), t0, reply: reply && { at: reply.createdAt, body: reply.body, from: reply.from } }, null, 1));
  console.log('enqueue→submit ms', submitted ? Date.parse(submitted.finishedAt ?? submitted.at ?? submitted.startedAt) - t0 : null);
} finally {
  if (process.env.KEEP !== '1') await fx?.stop();
  client.close();
}
