// Per-call caller identity for the MCP front-end (pre-build proposal "MCP front-end and caller identity"; findings in
// git show v0.9.0:probes/claude-identity-results.md and Astra's Codex probe). Resolved fresh on EVERY call; never from the MCP
// server's own pid alone, cwd, clientInfo, JSON-RPC ids, or model-supplied text (invariant 5).
import { execFile } from 'node:child_process';
import type { NativeEvidence } from '../contracts/ipc.js';
import { lookupByPid, type ClaudeRegistryDeps } from '../adapters/claude/registry.js';

export type IdentityResult =
  | { ok: true; native: NativeEvidence; note?: string }
  | { ok: false; code: 'identity_unresolved' | 'identity_mismatch'; message: string };

export interface ProcessInfo {
  ppid: number | null;
  /** Executable name, e.g. "codex.exe" (null when unknown). */
  name: string | null;
}

export interface IdentityDeps {
  claudeRegistry: ClaudeRegistryDeps;
  /** Parent pid + executable name of `pid`; throws when the process table can't be read. */
  processInfo(pid: number): Promise<ProcessInfo | null>;
  /** This MCP process's parent pid (injectable for tests). */
  ownParentPid: number;
  env: NodeJS.ProcessEnv;
  /** How far up the process tree to look for the owning Claude session (e.g. through a `cmd /c` shim). */
  maxAncestors?: number;
  /**
   * Allow the CLAUDE_PID + CLAUDE_CODE_SESSION_ID fallback when the process chain breaks. For the CLI run from an
   * agent's shell only — never for the MCP server (harnesses launch it directly, so its parent is the harness).
   * Even when allowed, every process walked before the break must be a known shell/launcher.
   */
  allowEnvFallback?: boolean;
}

/** Processes that may sit between a Claude shell and our CLI without being a harness of their own. */
// Deliberately excludes node.exe: node-based harnesses (agy, gemini) run as node, so a node ancestor could be the
// real caller. The CLI's own node process isn't walked (the walk starts at its parent).
const SHELLS = /^(bash|sh|dash|zsh|cmd|pwsh|powershell|timeout|env|conhost|winpty|mintty)(\.exe)?$/i;

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

/** Another harness in the chain means that harness launched us; never attribute its calls to a Claude above it. */
const OTHER_HARNESS = /^(codex|agy|gemini)(\.exe)?$/i;

async function resolveClaude(deps: IdentityDeps): Promise<IdentityResult> {
  const envId = deps.env['CLAUDE_CODE_SESSION_ID'];
  const walked: Array<string | null> = [];
  let pid: number | null = deps.ownParentPid;
  // Shells and launchers stack up between a harness and its tools (live: node → node → bash → bash → cmd →
  // claude.exe). Walking deeper is safe: ancestors must pass the start-time check and other harnesses stop it.
  const limit = deps.maxAncestors ?? 8;
  for (let depth = 0; pid !== null && pid > 0 && depth <= limit; depth++) {
    const found = await lookupByPid(pid, deps.claudeRegistry);
    if (found.status === 'live') {
      // Only the direct parent may be accepted with an unverifiable start time; walked ancestors must verify.
      if (!found.verified && depth > 0) {
        return { ok: false, code: 'identity_unresolved', message: "Couldn't verify the owning Claude session's process identity." };
      }
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
    let info: ProcessInfo | null;
    try {
      info = await deps.processInfo(pid);
    } catch {
      return { ok: false, code: 'identity_unresolved', message: "Couldn't read the process table to find the calling session; try again." };
    }
    if (info?.name && OTHER_HARNESS.test(info.name)) {
      return {
        ok: false,
        code: 'identity_unresolved',
        message: `This MCP server was launched by ${info.name}, which sent no thread identity; refusing to attribute the call to a Claude session above it.`,
      };
    }
    if (info === null) break; // the chain is broken here (e.g. an MSYS parent that already exited)
    walked.push(info.name);
    pid = info.ppid;
  }
  // CLI-only fallback when the process chain is broken (Git Bash/MSYS fork emulation leaves parent pids pointing at
  // exited processes). CLAUDE_PID/CLAUDE_CODE_SESSION_ID are inherited, so they only count when (a) every process we
  // walked before the break is a plain shell/launcher (no other harness could be the real caller), and (b) the live,
  // start-time-verified record at CLAUDE_PID carries exactly that session id.
  const envPid = Number(deps.env['CLAUDE_PID']);
  const onlyShells = walked.length > 0 && walked.every((name) => name !== null && SHELLS.test(name));
  if (deps.allowEnvFallback && onlyShells && envId && Number.isInteger(envPid) && envPid > 0) {
    const found = await lookupByPid(envPid, deps.claudeRegistry);
    if (found.status === 'live' && found.verified && found.record.sessionId === envId) {
      return { ok: true, native: { harness: 'claude', sessionId: envId, source: 'claude-env-verified' } };
    }
  }
  return {
    ok: false,
    code: 'identity_unresolved',
    message:
      'Could not identify the calling session (no Codex thread metadata and no owning Claude session found). ' +
      'Ask the human to add the room MCP server to this session and resume it (docs/reference/operations.md).',
  };
}

/**
 * Process info via the OS process table (Windows: CIM). A successful table is cached briefly; a failed load is
 * NOT cached and throws, so a transient failure is reported as such rather than as "no owning session".
 */
export function windowsProcessInfo(timeoutMs = 5_000, cacheMs = 10_000): (pid: number) => Promise<ProcessInfo | null> {
  let cache: { at: number; table: Map<number, ProcessInfo> } | null = null;
  const load = () =>
    new Promise<Map<number, ProcessInfo>>((resolve, reject) => {
      if (process.platform !== 'win32') return resolve(new Map());
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }'],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return reject(err);
          const table = new Map<number, ProcessInfo>();
          for (const line of stdout.split(/\r?\n/)) {
            const m = /^(\d+) (\d+) ?(.*)$/.exec(line.trim());
            if (m) table.set(Number(m[1]), { ppid: Number(m[2]), name: m[3] || null });
          }
          resolve(table);
        },
      );
    });
  return async (pid) => {
    if (!cache || Date.now() - cache.at > cacheMs) cache = { at: Date.now(), table: await load() };
    return cache.table.get(pid) ?? null;
  };
}
