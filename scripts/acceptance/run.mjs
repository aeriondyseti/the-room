// 4.1 acceptance orchestrator (throwaway fixture sessions only — never Kevin's panes or our work sessions).
//
//   node scripts/acceptance/run.mjs [--claude 2] [--codex 0] [--trials 20] [--scenarios] [--soak-minutes 0] [--label x]
//
// Starts fixtures in a scratch room (non-git dir + ROOM_ROOT, see claude-fixture.mjs), acts as the human (client
// 'tui'), and records per-message evidence: enqueue (createdAt → pipe/queue submit), turn start (transcript), reply
// (fixture's room_send with reply_to). Writes probes/acceptance/<stamp>-<label>.{json,md}. Always stops fixtures.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeRoot, start as startClaude } from './claude-fixture.mjs';
import { report } from './report.mjs';
import { refine } from './refine.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const flag = (k) => argv.includes(`--${k}`);
const cfg = {
  claude: Number(opt('claude', 2)), codex: Number(opt('codex', 0)), trials: Number(opt('trials', 20)),
  scenarios: flag('scenarios'), soakMinutes: Number(opt('soak-minutes', 0)), label: opt('label', 'run'),
  replyTimeoutMs: Number(opt('reply-timeout-ms', 180_000)),
};
// VP_DIST: a frozen copy of dist/ for long runs, so rebuilding the working tree (npm test wipes dist/) can't break
// the fixtures' MCP servers or the scratch room service mid-run.
const distRoot = resolve(process.env.VP_DIST ?? 'dist');
const dist = join(distRoot, 'cli', 'main.js');
const { RoomClient } = await import(pathToFileURL(join(distRoot, 'ipc', 'client.js')).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const root = makeRoot(cfg.label);
const client = await RoomClient.connect(root, { client: 'tui' });
const human = { kind: 'human' };
const whoIs = async (name, sid) => (await client.request('who', {})).participants.some((p) => p.name === name && p.sessionId === sid);
const results = { config: { ...cfg, root, startedAt: new Date().toISOString() }, fixtures: [], trials: [], scenarios: [], soak: [], errors: [] };
const fixtures = [];

async function send(body, to) {
  const r = await client.request('send', { caller: human, body, to: to ?? null, clientMessageId: `acc-${now()}-${Math.random().toString(36).slice(2)}` });
  return r.message;
}
async function allAfter(seq) {
  const out = []; let after = seq;
  for (;;) { const page = await client.request('read', { afterSeq: after, limit: 100 }); out.push(...page.items); if (!page.hasMore || !page.items.length) break; after = page.lastSeq; }
  return out;
}
/** Poll until `recipients` each replied to `msg` (or timeout). Returns { replies, deliveries }. */
async function awaitReplies(msg, recipients, timeoutMs = cfg.replyTimeoutMs) {
  const deadline = now() + timeoutMs; let replies = {}; let deliveries = [];
  while (now() < deadline) {
    deliveries = (await client.request('deliveries', { messageId: msg.id })).deliveries;
    for (const item of await allAfter(msg.seq)) if (item.message.replyTo === msg.id) replies[item.message.from.name] ??= item.message;
    if (recipients.every((n) => replies[n])) break;
    await sleep(250);
  }
  deliveries = (await client.request('deliveries', { messageId: msg.id })).deliveries;
  return { replies, deliveries };
}
async function waitIdle(fx, timeoutMs = 120_000) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) { if ((fx.status?.() ?? 'idle') === 'idle') return true; await sleep(500); }
  return false;
}
function evidence(fx, msg, delivery, reply, times) {
  const t0 = Date.parse(msg.createdAt);
  const sub = delivery?.attempts?.find((a) => a.outcome === 'submitted');
  const ms = (t) => (t == null ? null : t - t0);
  return {
    fixture: fx.name, harness: fx.harness, messageId: msg.id, createdAt: msg.createdAt, state: delivery?.state ?? null,
    attempts: delivery?.attempts?.length ?? 0, lastOutcome: delivery?.attempts?.at(-1)?.outcome ?? null, lastError: delivery?.attempts?.at(-1)?.error?.message ?? null,
    enqueueMs: sub ? ms(Date.parse(sub.finishedAt)) : null,
    receivedMs: ms(times?.receivedAt), promptMs: ms(times?.promptAt), turnStartMs: ms(times?.turnStartAt ?? null),
    replyMs: reply ? ms(Date.parse(reply.createdAt)) : null, replyIdentity: reply?.from?.identity ?? null,
    outcome: reply ? 'ok' : sub ? 'no_reply' : `not_submitted:${delivery?.state ?? 'none'}`,
  };
}
async function directTrial(fx, label) {
  if (!(await waitIdle(fx))) results.errors.push(`${fx.name}: not idle before ${label}`);
  await sleep(1500); // let the Stop hook/registry settle so this is a genuine idle wake
  const msg = await send(`${label}: reply ack`, [fx.name]);
  const { replies, deliveries } = await awaitReplies(msg, [fx.name]);
  const times = fx.times ? await fx.times(msg.id, Date.parse(msg.createdAt)) : { turnStartAt: await fx.turnStartedAt(msg.id, Date.parse(msg.createdAt)) };
  const e = evidence(fx, msg, deliveries.find((d) => d.recipient === fx.name), replies[fx.name], times);
  log(label, fx.name, e.outcome, `enqueue=${e.enqueueMs} turn=${e.turnStartMs} reply=${e.replyMs}`);
  return e;
}

try {
  // ---- fixtures ----
  const specs = [...Array(cfg.claude)].map((_, i) => ({ name: `fx${'ab'[i] ?? i}`, kind: 'claude' }));
  if (cfg.codex) {
    const path = resolve('scripts/acceptance/codex-fixture.mjs');
    if (!existsSync(path)) throw new Error('--codex needs scripts/acceptance/codex-fixture.mjs (Astra)');
    const codex = await import(pathToFileURL(path).href);
    for (let i = 0; i < cfg.codex; i++) specs.push({ name: `fx${'cd'[i] ?? `c${i}`}`, kind: 'codex', start: codex.start });
  }
  for (const s of specs) {
    log('starting', s.kind, s.name);
    const fx = s.kind === 'claude' ? await startClaude({ name: s.name, root, dist, whoIs }) : await s.start({ name: s.name, root, dist, whoIs });
    fixtures.push(fx);
    results.fixtures.push({ name: fx.name, harness: fx.harness, sessionId: fx.sessionId, pid: fx.pid ?? null });
  }
  const byName = (n) => fixtures.find((f) => f.name === n);

  // ---- idle-wake trials: N per harness, round-robin over that harness's fixtures ----
  for (const harness of ['claude', 'codex']) {
    const group = fixtures.filter((f) => f.harness === harness);
    for (let i = 0; group.length && i < cfg.trials; i++) results.trials.push(await directTrial(group[i % group.length], `wake trial ${harness} ${i + 1}`));
  }

  // ---- mixed idle/busy soak ----
  if (cfg.soakMinutes > 0) {
    const end = now() + cfg.soakMinutes * 60_000; let round = 0;
    while (now() < end) {
      round++;
      const pick = fixtures[Math.floor(Math.random() * fixtures.length)];
      const kind = ['idle', 'busy', 'broadcast'][round % 3];
      try {
        if (kind === 'idle') results.soak.push({ round, kind, ...(await directTrial(pick, `soak ${round} idle`)) });
        else if (kind === 'busy') {
          // Two back-to-back messages: the second arrives while the fixture is busy with the first.
          const m1 = await send(`soak ${round} busy 1: reply ack`, [pick.name]);
          const m2 = await send(`soak ${round} busy 2: reply ack`, [pick.name]);
          for (const m of [m1, m2]) {
            const { replies, deliveries } = await awaitReplies(m, [pick.name]);
            const e = evidence(pick, m, deliveries[0], replies[pick.name], pick.times ? await pick.times(m.id, Date.parse(m.createdAt)) : null);
            results.soak.push({ round, kind, ...e }); log(`soak ${round} busy`, pick.name, e.outcome, `reply=${e.replyMs}`);
          }
        } else {
          const m = await send(`soak ${round} broadcast: reply ack`);
          const { replies, deliveries } = await awaitReplies(m, fixtures.map((f) => f.name));
          for (const fx of fixtures) {
            const e = evidence(fx, m, deliveries.find((d) => d.recipient === fx.name), replies[fx.name], null);
            results.soak.push({ round, kind, ...e }); log(`soak ${round} broadcast`, fx.name, e.outcome, `reply=${e.replyMs}`);
          }
        }
      } catch (err) { results.errors.push(`soak ${round}: ${err.message}`); }
      const gap = 60_000 + Math.random() * 180_000; // 1–4 min idle between rounds
      await sleep(Math.min(gap, Math.max(0, end - now())));
    }
  }

  // ---- Done-when scenarios ----
  if (cfg.scenarios) {
    const names = fixtures.map((f) => f.name);
    const record = (name, pass, detail) => { results.scenarios.push({ name, pass, ...detail }); log('scenario', name, pass ? 'PASS' : 'FAIL'); };
    for (const fx of fixtures) await waitIdle(fx);

    // 1. Broadcast from the human reaches every fixture.
    { const m = await send('scenario broadcast: reply ack'); const { replies, deliveries } = await awaitReplies(m, names);
      record('broadcast reaches all', names.every((n) => replies[n]), { messageId: m.id, recipients: deliveries.map((d) => `${d.recipient}:${d.state}`), repliedBy: Object.keys(replies) }); }

    // 2. @name reaches only the selected instance.
    { const target = names[0]; for (const fx of fixtures) await waitIdle(fx);
      const m = await send('scenario direct: reply ack', [target]); const { replies, deliveries } = await awaitReplies(m, [target]);
      await sleep(15_000); const late = (await allAfter(m.seq)).filter((i) => i.message.replyTo === m.id).map((i) => i.message.from.name);
      record('@name reaches only the target', deliveries.length === 1 && !!replies[target] && late.every((n) => n === target), { messageId: m.id, deliveries: deliveries.map((d) => d.recipient), repliedBy: late }); }

    // 3/4. Agent-to-agent via room_send: same-harness and cross-harness replies.
    const relay = async (label, from, to) => {
      if (!from || !to) { record(label, false, { skipped: 'fixture missing' }); return; }
      for (const fx of fixtures) await waitIdle(fx);
      const m = await send(`RELAY ${to.name}`, [from.name]);
      const deadline = now() + cfg.replyTimeoutMs; let ping = null; let ack = null;
      while (now() < deadline && !(ping && ack)) {
        const items = await allAfter(m.seq);
        ping ??= items.find((i) => i.message.from.name === from.name && i.message.to?.includes(to.name))?.message ?? null;
        if (ping) ack = items.find((i) => i.message.replyTo === ping.id && i.message.from.name === to.name)?.message ?? null;
        await sleep(500);
      }
      const d = ping ? (await client.request('deliveries', { messageId: ping.id })).deliveries[0] : null;
      record(label, !!(ping && ack && d?.state === 'replied'), { trigger: m.id, ping: ping?.id ?? null, pingIdentity: ping?.from.identity ?? null, ack: ack?.id ?? null, ackIdentity: ack?.from.identity ?? null, pingDelivery: d?.state ?? null });
    };
    const claudes = fixtures.filter((f) => f.harness === 'claude'); const codexes = fixtures.filter((f) => f.harness === 'codex');
    await relay('same-harness reply (claude→claude)', claudes[0], claudes[1]);
    if (codexes.length > 1) await relay('same-harness reply (codex→codex)', codexes[0], codexes[1]);
    if (codexes.length) { await relay('cross-harness reply (claude→codex)', claudes[0], codexes[0]); await relay('cross-harness reply (codex→claude)', codexes[0], claudes[0]); }

    // 5. Busy instance, per harness: a second message sent while the first turn is running is delivered after it
    //    (native queue-after-current-turn), both are answered, and per-recipient order holds (invariant 4).
    for (const harness of ['claude', 'codex']) {
      const fx = fixtures.find((f) => f.harness === harness);
      if (!fx) continue;
      await waitIdle(fx);
      const m1 = await send('scenario busy 1: reply ack', [fx.name]);
      const m2 = await send('scenario busy 2: reply ack', [fx.name]);
      const r1 = await awaitReplies(m1, [fx.name]);
      const r2 = await awaitReplies(m2, [fx.name]);
      const sub = (d) => d?.attempts?.find((a) => a.outcome === 'submitted')?.finishedAt ?? null;
      const s1 = sub(r1.deliveries[0]); const s2 = sub(r2.deliveries[0]);
      const a1 = r1.replies[fx.name]?.createdAt ?? null; const a2 = r2.replies[fx.name]?.createdAt ?? null;
      const ordered = !!(s1 && s2 && Date.parse(s1) <= Date.parse(s2));
      record(`busy ${harness} instance: back-to-back messages both answered, in order`, !!(a1 && a2 && ordered), {
        first: m1.id, second: m2.id, submitted: [s1, s2], replied: [a1, a2],
        states: [r1.deliveries[0]?.state ?? null, r2.deliveries[0]?.state ?? null], coverage: `${harness} fixture only`,
      });
    }

    // 6. An offline instance never blocks the others (last: it consumes a fixture).
    { const victim = claudes.at(-1); await victim.stop(); await sleep(3000);
      const others = names.filter((n) => n !== victim.name);
      const m = await send('scenario offline: reply ack'); const { replies, deliveries } = await awaitReplies(m, others);
      await sleep(20_000); // let the dispatcher attempt the offline recipient, so its final state is evidence too
      const vd = (await client.request('deliveries', { messageId: m.id })).deliveries.find((d) => d.recipient === victim.name);
      record('offline instance does not block others', others.every((n) => replies[n]) && vd?.state !== 'replied', { messageId: m.id, offline: victim.name, offlineDelivery: vd ? { state: vd.state, waiting: vd.waiting, attempts: vd.attempts.map((a) => `${a.outcome}${a.error ? `:${a.error.code}` : ''}`) } : null, repliedBy: Object.keys(replies) });
      victim.stopped = true; }
    void byName;
  }
} catch (err) {
  results.errors.push(`fatal: ${err.stack ?? err.message}`); log('fatal', err.message);
} finally {
  for (const fx of fixtures) if (!fx.stopped) { try { await fx.stop(); } catch (e) { results.errors.push(`stop ${fx.name}: ${e.message}`); } }
  try { await client.request('shutdown', { caller: human }); } catch { /* already down */ }
  client.close();
  results.config.finishedAt = new Date().toISOString();
  const dir = resolve('probes/acceptance'); mkdirSync(dir, { recursive: true });
  const stamp = results.config.startedAt.replace(/[:.]/g, '-').slice(0, 19);
  const base = join(dir, `${stamp}-${cfg.label}`);
  await sleep(5000); // let the fixtures' transcripts flush, then fill in timings the live read missed
  try { refine(results); } catch (e) { results.errors.push(`refine: ${e.message}`); }
  writeFileSync(`${base}.json`, JSON.stringify(results, null, 1));
  writeFileSync(`${base}.md`, report(results));
  log('wrote', `${base}.{json,md}`);
}
