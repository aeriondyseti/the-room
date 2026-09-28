// Throwaway Claude Code fixture for the 4.1 acceptance run (NOT Kevin's sessions).
// Starts `claude --bg -n vpfix-<name>` in a scratch room, restricted to the room MCP tools, instructed to answer
// every room message with a one-word room_send reply. Stop removes the background session.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
export const FIXTURE_PREFIX = 'vpfix-';

const RULES = (name) => `You are "${name}", a throwaway acceptance-test fixture in a chat room. Rules:
- First, call room_join with name "${name}". Then end your turn.
- Handle EVERY room message you see, one room_send per message — including messages that arrive while you are already working (they may appear as queued or attached messages in the same turn). Then end your turn.
- If a room message's body starts with the uppercase word "RELAY" followed by a name, call room_send: to = [that name], body = "ping" (no reply_to).
- If a room message's body is just an acknowledgement ("ack" / "ACK"), do nothing for it (no reply loops).
- For every other room message, call room_send: to = [the sender's name], reply_to = the message id shown after '#' in its header, body = the single word "ack".
- Never call any other tool, never write files, never explain.`;

async function sleep(ms) { await new Promise((r) => setTimeout(r, ms)); }

function registryRecords() {
  const dir = join(CLAUDE_DIR, 'sessions');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(readFileSync(join(dir, f), 'utf8'))); } catch { /* being rewritten */ }
  }
  return out;
}

export function findTranscript(sessionId) {
  const projects = join(CLAUDE_DIR, 'projects');
  for (const d of existsSync(projects) ? readdirSync(projects) : []) {
    const p = join(projects, d, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Transcript timings for the room message `marker` (its id), as epoch ms or null:
 * - receivedAt: first record carrying the marker (the pipe message landed, e.g. a queue-operation line);
 * - promptAt: the `user` record carrying it (the message entered the conversation);
 * - turnStartAt: the first `assistant` record after that (the model began its turn — what "woke" means).
 */
export function transcriptTimes(sessionId, marker, sinceMs) {
  const out = { receivedAt: null, promptAt: null, turnStartAt: null };
  const path = findTranscript(sessionId);
  if (!path) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const t = Date.parse(r.timestamp);
    if (!Number.isFinite(t) || t < sinceMs - 1000) continue;
    if (out.promptAt !== null) {
      if (r.type === 'assistant') { out.turnStartAt = t; break; }
      continue;
    }
    if (!line.includes(marker)) continue;
    out.receivedAt ??= t;
    if (r.type === 'user') out.promptAt = t;
  }
  return out;
}

/**
 * Scratch room roots. `claude --bg` refuses untrusted workspaces, and we never edit Kevin's trust settings, so the
 * base must already be trusted: VP_FIXTURE_BASE, else the job scratch dir ($CLAUDE_JOB_DIR/tmp), else os.tmpdir().
 */
export function makeRoot(label) {
  const base = process.env.VP_FIXTURE_BASE ?? (process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, 'tmp') : tmpdir());
  return mkdtempSync(join(base, `${FIXTURE_PREFIX}${label}-`));
}

export async function gitInit(root) { await run('git', ['init', '-q', root]); }

/** Start one fixture. `dist` = absolute path to dist/cli/main.js. Resolves once the fixture has joined the room. */
export async function start({ name, root, dist, model = 'haiku', joinTimeoutMs = 120_000, whoIs }) {
  if (!name.startsWith('fx')) throw new Error('fixture names must start with "fx" (safety: never a real participant)');
  const mcpPath = join(root, `.mcp-${name}.json`);
  // ROOM_ROOT pins the scratch room: the root is a plain (non-git) directory, because `claude --bg` requires a
  // trusted workspace inside git repos and we never edit Kevin's trust settings.
  writeFileSync(mcpPath, JSON.stringify({ mcpServers: { room: { command: process.execPath, args: [dist, 'mcp'], env: { ROOM_ROOT: root } } } }));
  const display = `${FIXTURE_PREFIX}${name}-${Date.now().toString(36)}`; // unique: a leftover fixture never matches
  const args = ['--bg', '-n', display, '--model', model, '--strict-mcp-config', '--mcp-config', mcpPath,
    '--setting-sources', 'project', '--permission-mode', 'dontAsk', '--append-system-prompt', RULES(name),
    '--allowedTools', 'mcp__room__room_join', 'mcp__room__room_send', 'mcp__room__room_read', 'mcp__room__room_who',
    '--name', display, // a flag after --allowedTools so its variadic list does not swallow the prompt
    `Join the room now as "${name}".`];
  const started = Date.now();
  const { stdout } = await run('claude', args, { cwd: root, windowsHide: true, shell: false });
  const shortId = stdout.trim().split(/\s+/).find((w) => /^[0-9a-f]{6,}$/i.test(w)) ?? null;
  // Registry record for our display name (Claude writes it once the session is up).
  let record = null;
  while (!record && Date.now() - started < joinTimeoutMs) {
    record = registryRecords().find((r) => r.name === display) ?? null;
    if (!record) await sleep(500);
  }
  // `claude stop|rm` take the short id (the session id's first 8 hex chars, as `claude agents` shows it). Failures are
  // reported, not swallowed: after both commands the session must be gone from the registry, else stop() throws.
  const stopIds = async (id, sessionId) => {
    const errors = [];
    for (const cmd of ['stop', 'rm']) {
      try { await run('claude', [cmd, id], { windowsHide: true }); } catch (e) { errors.push(`claude ${cmd} ${id}: ${(e.stderr || e.message || '').toString().trim()}`); }
    }
    const present = () => registryRecords().some((r) => (sessionId ? r.sessionId === sessionId : r.name === display));
    for (let i = 0; i < 20 && present(); i++) await sleep(250); // the registry file goes away just after exit
    if (present()) throw new Error(`fixture ${name} (${display}) still running after stop: ${errors.join('; ') || 'no error reported'}`);
  };
  if (!record) {
    if (shortId) await stopIds(shortId, null);
    throw new Error(`fixture ${name}: no registry record within ${joinTimeoutMs}ms (display ${display}; claude said: ${stdout.trim()})`);
  }
  const id = record.sessionId.slice(0, 8);
  // Wait until the room lists it (the fixture calls room_join itself, verified by MCP identity). Any failure here
  // stops the fixture before rethrowing, so a half-started session never outlives the run.
  try {
    let joined = false;
    while (!joined && Date.now() - started < joinTimeoutMs) {
      joined = await whoIs(name, record.sessionId);
      if (!joined) await sleep(1000);
    }
    if (!joined) throw new Error(`fixture ${name}: did not join the room within ${joinTimeoutMs}ms`);
  } catch (err) {
    await stopIds(id, record.sessionId).catch((e) => { err.message += ` (and cleanup failed: ${e.message})`; });
    throw err;
  }
  return {
    name, harness: 'claude', sessionId: record.sessionId, pid: record.pid, shortId: id, display,
    async turnStartedAt(messageId, sinceMs) { return transcriptTimes(record.sessionId, messageId, sinceMs).turnStartAt; },
    async times(messageId, sinceMs) { return transcriptTimes(record.sessionId, messageId, sinceMs); },
    status() { return registryRecords().find((r) => r.sessionId === record.sessionId)?.status ?? 'gone'; },
    async stop() { await stopIds(id, record.sessionId); },
  };
}
