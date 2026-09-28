import type { Caller } from '../contracts/ipc.js';
import { RoomError } from '../contracts/errors.js';
import { lookupByPid } from '../adapters/claude/registry.js';
import type { IdentityDeps } from '../mcp/identity.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Detect agent context before allowing any human-only action. --as never overrides native evidence. */
export async function cliCaller(name: string | null, deps: IdentityDeps): Promise<Caller> {
  const ids = [deps.env.CODEX_THREAD_ID, deps.env.CODEX_SESSION_ID].filter((x): x is string => !!x).map(x => x.toLowerCase());
  if (ids.length) {
    if (ids.some(id => !UUID.test(id))) throw new RoomError('identity_unresolved', 'Malformed Codex session environment.');
    if (new Set(ids).size !== 1) throw new RoomError('identity_mismatch', 'Codex thread/session environment values disagree.');
    return { kind: 'agent', native: { harness: 'codex', sessionId: ids[0]!, source: 'codex-env' }, declaredName: name };
  }
  let pid: number | null = deps.ownParentPid;
  let agentDetected = !!deps.env.CLAUDE_CODE_SESSION_ID;
  const seen = new Set<number>();
  for (let n = 0; pid && n < (deps.maxAncestors ?? 16); n++) {
    if (seen.has(pid)) break;
    seen.add(pid);
    const info = await deps.processInfo(pid);
    // A nested Codex without its identity must not inherit a Claude ancestor's identity.
    if (info?.name && /^(codex|agy|gemini)(\.exe)?$/i.test(info.name)) {
      agentDetected = true;
      break;
    }
    const found = await lookupByPid(pid, deps.claudeRegistry);
    if (found.status === 'live') {
      if (!found.verified) throw new RoomError('identity_unresolved', 'Cannot verify the Claude process start time.');
      return { kind: 'agent', native: { harness: 'claude', sessionId: found.record.sessionId, source: 'claude-ancestry' }, declaredName: name };
    }
    if (found.status === 'error' || found.status === 'stale') throw new RoomError('identity_unresolved', found.detail);
    if (info?.name && /^claude(\.exe)?$/i.test(info.name)) agentDetected = true;
    pid = info?.ppid ?? null;
  }
  if (name) return { kind: 'agent', native: null, declaredName: name };
  if (agentDetected) throw new RoomError('identity_unresolved', 'Agent context detected without a native identity; pass --as for a labelled declared fallback.');
  return { kind: 'human' };
}
