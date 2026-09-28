// Read-only view of Claude Code's local session registry (`<claudeConfigDir>/sessions/<pid>.json` + `.key`).
// Version-sensitive details (qualified on Claude Code 2.1.283) live here and in pipe.ts only (DESIGN §3).
// Invariant 8: this module never writes Claude's files. Invariant 6: tokens never leave this process.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

/** The fields we rely on from a Claude session record. */
export interface ClaudeSessionRecord {
  pid: number;
  sessionId: string;
  messagingSocketPath: string;
  /** Process start time (Windows FILETIME string) recorded by Claude, used to detect pid reuse. */
  procStart: string | null;
  /** e.g. 'busy' | 'idle' | 'waiting' (Claude-defined; not an enum we control). */
  status: string | null;
  waitingFor: string | null;
  name: string | null;
}

export type SessionLookup =
  | { status: 'live'; record: ClaudeSessionRecord }
  | { status: 'absent'; detail: string }
  | { status: 'stale'; detail: string };

export interface ClaudeRegistryDeps {
  /** Directory containing `<pid>.json` records. */
  sessionsDir: string;
  isPidAlive(pid: number): boolean;
  /** Current process start time for `pid` (FILETIME string), or null when it can't be determined. */
  processStartTime(pid: number): Promise<string | null>;
  pidDomain: string;
}

export function resolveClaudeConfigDir(explicit: string | null, env: NodeJS.ProcessEnv = process.env): string {
  return explicit ?? env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
}

export function defaultRegistryDeps(claudeConfigDir: string): ClaudeRegistryDeps {
  return {
    sessionsDir: join(claudeConfigDir, 'sessions'),
    isPidAlive,
    processStartTime: windowsProcessStartTime,
    pidDomain: `${process.platform}:${hostname().toLowerCase()}`,
  };
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** FILETIME start time via PowerShell (Windows only). Returns null on any failure: callers treat it as unknown. */
export function windowsProcessStartTime(pid: number): Promise<string | null> {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      const value = stdout.trim();
      resolve(!err && /^\d+$/.test(value) ? value : null);
    });
  });
}

/** Local named-pipe paths only; anything else is refused (we never dial a remote/odd path from a record). */
export function isLocalPipePath(p: string): boolean {
  return /^\\\\\.\\pipe\\(LOCAL\\)?[A-Za-z0-9._-]+$/i.test(p) && !/[. ]$/.test(p);
}

/** Claude's key file name suffix for a pipe: sha256 of the lower-cased pipe path. */
export function keyHashForPipe(pipePath: string): string {
  return createHash('sha256').update(pipePath.toLowerCase()).digest('hex');
}

/**
 * Find the live registry record for `sessionId`.
 * - `absent`: no live process claims it (the session is closed) → the agent is offline.
 * - `stale`: positive evidence the binding is wrong (pid reused, or several live records) → rebind needed.
 * - `live`: exactly one live, start-time-consistent record.
 */
export async function lookupSession(sessionId: string, deps: ClaudeRegistryDeps): Promise<SessionLookup> {
  let files: string[];
  try {
    files = await readdir(deps.sessionsDir);
  } catch {
    return { status: 'absent', detail: `no Claude session registry at ${deps.sessionsDir}` };
  }
  const candidates: ClaudeSessionRecord[] = [];
  for (const file of files) {
    const m = /^(\d+)\.json$/.exec(file);
    if (!m) continue;
    const record = parseRecord(await readFile(join(deps.sessionsDir, file), 'utf8').catch(() => null), Number(m[1]), deps.pidDomain);
    if (record && record.sessionId === sessionId) candidates.push(record);
  }
  const live = candidates.filter((r) => deps.isPidAlive(r.pid));
  if (live.length === 0) {
    return { status: 'absent', detail: candidates.length ? 'the session process has exited' : 'no running Claude session has this id' };
  }
  if (live.length > 1) {
    return { status: 'stale', detail: `${live.length} live processes claim this session id` };
  }
  const record = live[0]!;
  if (record.procStart !== null) {
    const actual = await deps.processStartTime(record.pid);
    // Unknown start time (query failed) is not evidence of reuse; only a positive mismatch is.
    if (actual !== null && actual !== record.procStart) {
      return { status: 'stale', detail: `pid ${record.pid} now belongs to a different process` };
    }
  }
  return { status: 'live', record };
}

/** Read the peer token for a live record's pipe. Returns null when no valid key is published. */
export async function readPeerToken(record: ClaudeSessionRecord, deps: ClaudeRegistryDeps): Promise<string | null> {
  const file = join(deps.sessionsDir, `${record.pid}.${keyHashForPipe(record.messagingSocketPath)}.key`);
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    const token = typeof parsed === 'object' && parsed !== null ? (parsed as { peerToken?: unknown }).peerToken : undefined;
    return typeof token === 'string' && /^[0-9a-f]{32}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

function parseRecord(raw: string | null, filePid: number, pidDomain: string): ClaudeSessionRecord | null {
  if (raw === null) return null;
  let r: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    r = parsed as Record<string, unknown>;
  } catch {
    return null; // torn write in progress; the next lookup will see the complete record
  }
  if (r['pid'] !== filePid || typeof r['sessionId'] !== 'string') return null;
  const pipe = r['messagingSocketPath'];
  if (typeof pipe !== 'string' || !isLocalPipePath(pipe)) return null;
  if (typeof r['pidDomain'] === 'string' && r['pidDomain'] !== pidDomain) return null;
  // Warm spares and terminals attached to a background job are not addressable sessions.
  if (r['spare'] || r['parkedJobId']) return null;
  const procStart = r['procStartFt'] ?? r['procStart'];
  return {
    pid: filePid,
    sessionId: r['sessionId'],
    messagingSocketPath: pipe,
    procStart: typeof procStart === 'string' || typeof procStart === 'number' ? String(procStart) : null,
    status: typeof r['status'] === 'string' ? r['status'] : null,
    waitingFor: typeof r['waitingFor'] === 'string' ? r['waitingFor'] : null,
    name: typeof r['name'] === 'string' ? r['name'] : null,
  };
}
