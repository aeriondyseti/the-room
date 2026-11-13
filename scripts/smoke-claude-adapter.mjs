#!/usr/bin/env node
// Live smoke test for the Claude adapter (ROADMAP 2.2). Sends ONE message to a real Claude Code session.
// Usage: npm run build && node scripts/smoke-claude-adapter.mjs <claude-session-id> [message]
// Only target a session you own and expect to receive a message (e.g. your own). Nothing else is touched.
import { ClaudeAdapter, claudeAdapterOptionsFrom, defaultRegistryDeps, resolveClaudeConfigDir } from '../dist/adapters/claude/index.js';
import { loadConfig } from '../dist/core/config.js';

const [sessionId, message] = process.argv.slice(2);
if (!sessionId) {
  console.error('usage: node scripts/smoke-claude-adapter.mjs <claude-session-id> [message]');
  process.exit(2);
}
const config = loadConfig();
const adapter = new ClaudeAdapter(claudeAdapterOptionsFrom(config, defaultRegistryDeps(resolveClaudeConfigDir(config.claudeConfigDir), config.claudeProcStartTimeoutMs)));
const target = { harness: 'claude', sessionId };
const tag = `SMOKE-${Date.now().toString(36).toUpperCase()}`;
console.log('probe:', JSON.stringify(await adapter.probe(target)));
const started = Date.now();
const result = await adapter.submit({
  target,
  envelope: message ?? `[roundtable smoke test ${tag}] Claude adapter live check — no reply needed.`,
  messageId: tag,
  recipient: 'smoke',
  attempt: 1,
});
console.log(`submit (${Date.now() - started} ms):`, JSON.stringify(result));
process.exitCode = result.status === 'submitted' ? 0 : 1;
