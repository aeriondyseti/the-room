// Per-call caller identity for the MCP front-end (proposal "MCP front-end and caller identity"; findings in
// probes/claude-identity-results.md and Astra's Codex probe). Resolved fresh on EVERY call; never from the MCP
// server's own pid alone, cwd, clientInfo, JSON-RPC ids, or model-supplied text (invariant 5).
import { execFile } from 'node:child_process';
import type { NativeEvidence } from '../contracts/ipc.js';
import { lookupByPid, type ClaudeRegistryDeps } from '../adapters/claude/registry.js';

export type IdentityResult =
  | { ok: true; native: NativeEvidence; note?: string }
  | { ok: false; code: 'identity_unresolved' | 'identity_mismatch'; message: string };

export interface IdentityDeps {
  claudeRegistry: ClaudeRegistryDeps;
  /** Parent pid of `pid` (null when unknown). The MCP server's own parent is `process.ppid`. */
  parentOf(pid: number): Promise<number | null>;
  /** This MCP process's parent pid (injectable for tests). */
  ownParentPid: number;
  env: NodeJS.ProcessEnv;
  /** How far up the process tree to look for the owning Claude session (e.g. through a `cmd /c` shim). */
  maxAncestors?: number;
}

const ID = /^[A-Za-z0-9-]{8,128}$/;

/** Resolve the calling native session from per-call MCP `_meta` (Codex) or the parent process registry (Claude). */
export async function resolveCaller(meta: Record<string, unknown> | undefined, deps: IdentityDeps): Promise<IdentityResult> {
  const codex = codexIds(meta);
  if (codex.length > 0) {
    const distinct = [...new Set(codex.map((c) => c.value))];
    if (distinct.length > 1) {
      return {
        ok: false,
        code: 'identity_mismatch',
        message: `Codex supplied conflicting thread/session ids (${codex.map((c) => `${c.field}=${c.value}`).join(', ')}); refusing to guess.`,
      };
    }
    const sessionId = distinct[0]!;
    if (!ID.test(sessionId)) return { ok: false, code: 'identity_unresolved', message: 'Codex supplied a malformed thread id.' };
    return { ok: true, native: { harness: 'codex', sessionId, source: 'codex-mcp-meta' } };
  }
  return resolveClaude(deps);
}

function codexIds(meta: Record<string, unknown> | undefined): Array<{ field: string; value: string }> {
  if (!meta) return [];
  const out: Array<{ field: string; value: string }> = [];
  const take = (field: string, v: unknown) => {
    if (typeof v === 'string' && v !== '') out.push({ field, value: v });
  };
  take('threadId', meta['threadId']);
  take('sessionId', meta['sessionId']);
  const turn = meta['x-codex-turn-metadata'];
  if (typeof turn === 'object' && turn !== null) {
    take('x-codex-turn-metadata.thread_id', (turn as Record<string, unknown>)['thread_id']);
    take('x-codex-turn-metadata.session_id', (turn as Record<string, unknown>)['session_id']);
  }
  return out;
}

async function resolveClaude(deps: IdentityDeps): Promise<IdentityResult> {
  const envId = deps.env['CLAUDE_CODE_SESSION_ID'];
  let pid: number | null = deps.ownParentPid;
  const limit = deps.maxAncestors ?? 4;
  for (let depth = 0; pid !== null && pid > 0 && depth <= limit; depth++) {
    const found = await lookupByPid(pid, deps.claudeRegistry);
    if (found.status === 'live') {
      const sessionId = found.record.sessionId;
      const note =
        envId && envId !== sessionId
          ? `CLAUDE_CODE_SESSION_ID (${envId}) differs from the live session (${sessionId}); using the live session.`
          : undefined;
      return { ok: true, native: { harness: 'claude', sessionId, source: 'claude-mcp-registry' }, ...(note ? { note } : {}) };
    }
    if (found.status === 'stale' || found.status === 'error') {
      return { ok: false, code: 'identity_unresolved', message: `Couldn't verify the calling Claude session: ${found.detail}.` };
    }
    pid = await deps.parentOf(pid);
  }
  return {
    ok: false,
    code: 'identity_unresolved',
    message:
      'Could not identify the calling session (no Codex thread metadata and no owning Claude session found). ' +
      'Use the CLI instead: `room send --as <name> …`.',
  };
}

/** Parent pid lookup via the OS process table (Windows: CIM). Cached briefly; null when unknown. */
export function windowsParentOf(timeoutMs = 5_000): (pid: number) => Promise<number | null> {
  let cache: { at: number; table: Map<number, number> } | null = null;
  const load = () =>
    new Promise<Map<number, number>>((resolve) => {
      if (process.platform !== 'win32') return resolve(new Map());
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          const table = new Map<number, number>();
          if (!err) for (const line of stdout.split(/\r?\n/)) {
            const m = /^(\d+) (\d+)$/.exec(line.trim());
            if (m) table.set(Number(m[1]), Number(m[2]));
          }
          resolve(table);
        },
      );
    });
  return async (pid) => {
    if (!cache || Date.now() - cache.at > 10_000) cache = { at: Date.now(), table: await load() };
    return cache.table.get(pid) ?? null;
  };
}
