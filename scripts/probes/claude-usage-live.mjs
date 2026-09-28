// Live check of the Claude usage endpoint provider (Kevin-approved option B). Prints only the mapped windows
// (bucket, label, window, %, reset); never the token or the raw response.   node scripts/probes/claude-usage-live.mjs
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = resolve('dist');
const { claudeUsageApiProvider } = await import(pathToFileURL(`${dist}/adapters/claude/usage-api.js`).href);
const { resolveClaudeConfigDir } = await import(pathToFileURL(`${dist}/adapters/claude/registry.js`).href);
const provider = claudeUsageApiProvider({ claudeConfigDir: resolveClaudeConfigDir(null) });
const a = await provider.sample();
console.log(JSON.stringify({ status: a.status, reason: a.reason ?? null, scope: a.account.scope,
  buckets: a.buckets.map((b) => ({ id: b.id, label: b.label ?? null, windows: b.windows.map((w) => `${w.kind} ${w.durationMinutes ?? '?'}min ${w.usedPercent ?? 'n/a'}% resets ${w.resetsAt ?? '?'}`) })) }, null, 1));
