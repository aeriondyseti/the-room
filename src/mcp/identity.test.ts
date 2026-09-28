import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeRegistryDeps } from '../adapters/claude/registry.js';
import { resolveCaller, type IdentityDeps } from './identity.js';

const root = mkdtempSync(join(tmpdir(), 'vp-mcp-identity-'));
after(() => rmSync(root, { recursive: true, force: true }));
const THREAD = '01a0e605-2485-7693-a111-97e35d22a97e';
const CLAUDE = '67b7bc1e-0c3e-4ffa-9d51-a88eb52d61d8';

function deps(records: Array<{ pid: number; sessionId: string; procStart?: string }>, over: Partial<IdentityDeps> = {}): IdentityDeps {
  const dir = mkdtempSync(join(root, 'sessions-'));
  for (const r of records) {
    writeFileSync(join(dir, `${r.pid}.json`), JSON.stringify({ pid: r.pid, sessionId: r.sessionId, messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-x', procStart: r.procStart ?? '1', pidDomain: 'test' }));
  }
  const registry: ClaudeRegistryDeps = {
    sessionsDir: dir,
    isPidAlive: (pid) => records.some((r) => r.pid === pid),
    processStartTime: async () => '1',
    pidDomain: 'test',
  };
  return { claudeRegistry: registry, processInfo: async () => null, ownParentPid: 100, env: {}, ...over };
}

test('Codex: per-call _meta.threadId identifies the caller; all supplied ids must agree', async () => {
  const d = deps([]);
  assert.deepEqual(await resolveCaller({ threadId: THREAD, sessionId: THREAD, 'x-codex-turn-metadata': { thread_id: THREAD, session_id: THREAD } }, d), {
    ok: true,
    native: { harness: 'codex', sessionId: THREAD, source: 'codex-mcp-meta' },
  });
  const conflict = await resolveCaller({ threadId: THREAD, 'x-codex-turn-metadata': { thread_id: 'other-thread-0000' } }, d);
  assert.equal(conflict.ok, false);
  assert.equal(!conflict.ok && conflict.code, 'identity_mismatch');
  const malformed = await resolveCaller({ threadId: 'x;rm' }, d);
  assert.equal(!malformed.ok && malformed.code, 'identity_unresolved');
});

test('Claude: the parent process registry identifies the caller; env is only a cross-check', async () => {
  const d = deps([{ pid: 100, sessionId: CLAUDE }], { env: { CLAUDE_CODE_SESSION_ID: CLAUDE } });
  assert.deepEqual(await resolveCaller(undefined, d), { ok: true, native: { harness: 'claude', sessionId: CLAUDE, source: 'claude-mcp-registry' } });
  const drift = await resolveCaller({}, deps([{ pid: 100, sessionId: CLAUDE }], { env: { CLAUDE_CODE_SESSION_ID: 'old-session-1234' } }));
  assert.equal(drift.ok, true);
  assert.match(drift.ok ? drift.note ?? '' : '', /differs from the live session/);
});

test('Claude: walks up through a launcher process to the owning session', async () => {
  const tree: Record<number, { ppid: number; name: string }> = { 100: { ppid: 50, name: 'cmd.exe' }, 50: { ppid: 7, name: 'node.exe' } };
  const d = deps([{ pid: 7, sessionId: CLAUDE }], { ownParentPid: 100, processInfo: async (pid) => tree[pid] ?? null });
  const r = await resolveCaller(undefined, d);
  assert.equal(r.ok && r.native.sessionId, CLAUDE);
});

test('a Codex host launched from inside a Claude session is never attributed to that Claude', async () => {
  const tree: Record<number, { ppid: number; name: string }> = { 100: { ppid: 7, name: 'codex.exe' } };
  const r = await resolveCaller({}, deps([{ pid: 7, sessionId: CLAUDE }], { ownParentPid: 100, processInfo: async (pid) => tree[pid] ?? null }));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.message : '', /launched by codex\.exe/);
});

test('an unreadable process table is reported as such (retryable), not as "no session"', async () => {
  const r = await resolveCaller({}, deps([], { processInfo: async () => { throw new Error('CIM timeout'); } }));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.message : '', /Couldn't read the process table/);
});

test('broken chain (Git Bash): the env fallback is CLI-only, shell-only, verified, and must agree', async () => {
  const records = [{ pid: 777, sessionId: CLAUDE }];
  const env = { CLAUDE_PID: '777', CLAUDE_CODE_SESSION_ID: CLAUDE };
  const shellChain = async (pid: number) => (pid === 5 ? { ppid: 6, name: 'bash.exe' } : pid === 6 ? { ppid: 99999, name: 'timeout.exe' } : null);
  const ok = await resolveCaller({}, deps(records, { ownParentPid: 5, env, processInfo: shellChain, allowEnvFallback: true }));
  assert.deepEqual(ok.ok && ok.native, { harness: 'claude', sessionId: CLAUDE, source: 'claude-env-verified' });

  const mcpPath = await resolveCaller({}, deps(records, { ownParentPid: 5, env, processInfo: shellChain }));
  assert.equal(mcpPath.ok, false, 'the MCP server never uses the inherited-env fallback');

  const otherHarness = async (pid: number) => (pid === 5 ? { ppid: 6, name: 'node.exe' } : pid === 6 ? { ppid: 99999, name: 'bash.exe' } : null);
  const viaUnknown = await resolveCaller({}, deps(records, { ownParentPid: 5, env, processInfo: otherHarness, allowEnvFallback: true }));
  assert.equal(viaUnknown.ok, false, 'an unknown executable before the break could be the real caller');

  const mismatch = await resolveCaller({}, deps(records, { ownParentPid: 5, env: { ...env, CLAUDE_CODE_SESSION_ID: 'someone-else-1234' }, processInfo: shellChain, allowEnvFallback: true }));
  assert.equal(mismatch.ok, false, 'env pid and env session must agree with the registry');
  const unverified = await resolveCaller({}, deps(records, { ownParentPid: 5, env, processInfo: shellChain, allowEnvFallback: true, claudeRegistry: { ...deps(records).claudeRegistry, processStartTime: async () => null } }));
  assert.equal(unverified.ok, false, 'the env fallback requires a verified start time');
});

test('no evidence → unresolved with the CLI fallback; env alone is not enough', async () => {
  const r = await resolveCaller({}, deps([], { env: { CLAUDE_CODE_SESSION_ID: CLAUDE } }));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.message : '', /add the room MCP server/);
});

test('a reused pid (start time mismatch) is not accepted as the caller', async () => {
  const d = deps([{ pid: 100, sessionId: CLAUDE, procStart: '999' }]);
  const r = await resolveCaller(undefined, d);
  assert.equal(r.ok, false);
});
