// Markdown summary for a 4.1 acceptance run (the JSON next to it is the full evidence).
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const fmt = (v) => (v == null ? '—' : v >= 10_000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);

function stats(rows, key) {
  const xs = rows.map((r) => r[key]).filter((v) => typeof v === 'number');
  return xs.length ? `${fmt(pct(xs, 50))} / ${fmt(pct(xs, 90))} / ${fmt(Math.max(...xs))} (n=${xs.length})` : '—';
}

export function report(r) {
  const out = [];
  const c = r.config;
  out.push(`# 4.1 acceptance run — ${c.label}`, '');
  out.push(`- Started ${c.startedAt} · finished ${c.finishedAt ?? '(incomplete)'}`);
  out.push(`- **Throwaway fixture sessions only** (\`claude --bg --model haiku\`${c.codex ? ' and Codex fixture threads' : ''}), in a scratch room (${c.root}); not Kevin's TUI panes and not our work sessions.`);
  out.push(`- Fixtures: ${r.fixtures.map((f) => `${f.name} (${f.harness}, ${f.sessionId.slice(0, 8)})`).join(', ') || 'none'}`);
  out.push(`- Latencies are measured from the room message's \`createdAt\`: **enqueue** = native submit finished (Claude pipe write / \`codex queue\`), **turn start** = first assistant record after the message entered the transcript, **reply** = the fixture's \`roundtable_send\` reply (\`reply_to\` = the message) was created. Stats are p50 / p90 / max.`, '');

  if (r.trials.length) {
    out.push('## Idle-wake trials', '', '| Harness | Trials | OK | Timeouts / failures | Enqueue (submit done) | Received (transcript) | Turn start | Reply |', '|---|---|---|---|---|---|---|---|');
    for (const h of ['claude', 'codex']) {
      const rows = r.trials.filter((t) => t.harness === h); if (!rows.length) continue;
      const ok = rows.filter((t) => t.outcome === 'ok').length;
      out.push(`| ${h} | ${rows.length} | ${ok} | ${rows.length - ok} | ${stats(rows, 'enqueueMs')} | ${stats(rows, 'receivedMs')} | ${stats(rows, 'turnStartMs')} | ${stats(rows, 'replyMs')} |`);
    }
    const bad = r.trials.filter((t) => t.outcome !== 'ok');
    if (bad.length) { out.push('', '**Failures / timeouts (all reported):**'); for (const t of bad) out.push(`- ${t.fixture} ${t.messageId}: ${t.outcome} (state ${t.state}, last attempt ${t.lastOutcome}${t.lastError ? `: ${t.lastError}` : ''})`); }
    out.push('');
  }

  if (r.soak.length) {
    const mins = c.soakMinutes;
    out.push(`## Mixed idle/busy exercise (${mins} min)`, '', '| Kind | Messages | OK | Timeouts / failures | Enqueue | Reply |', '|---|---|---|---|---|---|');
    for (const k of ['idle', 'busy', 'broadcast']) {
      const rows = r.soak.filter((s) => s.kind === k); if (!rows.length) continue;
      const ok = rows.filter((s) => s.outcome === 'ok').length;
      out.push(`| ${k} | ${rows.length} | ${ok} | ${rows.length - ok} | ${stats(rows, 'enqueueMs')} | ${stats(rows, 'replyMs')} |`);
    }
    const bad = r.soak.filter((s) => s.outcome !== 'ok');
    if (bad.length) { out.push('', '**Failures / timeouts (all reported):**'); for (const s of bad) out.push(`- round ${s.round} ${s.kind} ${s.fixture} ${s.messageId}: ${s.outcome} (state ${s.state}${s.lastError ? `, ${s.lastError}` : ''})`); }
    out.push('');
  }

  if (r.scenarios.length) {
    out.push('## Done-when scenarios', '', '| Scenario | Result | Evidence |', '|---|---|---|');
    for (const s of r.scenarios) { const { name, pass, ...ev } = s; out.push(`| ${name} | ${pass ? '✅ pass' : '❌ fail'} | \`${JSON.stringify(ev).replace(/\|/g, '\\|')}\` |`); }
    out.push('');
  }

  out.push('## Errors', '', ...(r.errors.length ? r.errors.map((e) => `- ${e.split('\n')[0]}`) : ['- none']), '');
  return out.join('\n');
}
