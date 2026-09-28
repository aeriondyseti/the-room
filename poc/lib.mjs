// pair-poc shared library: log + native delivery. Throwaway proof of concept, no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const POC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = process.env.PAIR_POC_ROOT || path.resolve(POC_DIR, '..');
export const LOG_DIR = path.join(ROOT, '.room-poc');
export const LOG = path.join(LOG_DIR, 'log.jsonl');

const config = JSON.parse(fs.readFileSync(path.join(POC_DIR, 'participants.json'), 'utf8'));
export const participants = config.participants;
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

export function append(record) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
}

export function readLog() {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Resolve a Claude session's live registry entry by sessionId (pid, pipe, key change across restarts).
export function claudeRegistry(sessionId) {
  if (!fs.existsSync(SESSIONS_DIR)) return null;
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      if (r.sessionId === sessionId && pidAlive(r.pid)) return r;
    } catch { /* partially written entry; skip */ }
  }
  return null;
}

function deliverClaude(sessionId, text) {
  return new Promise(resolve => {
    const reg = claudeRegistry(sessionId);
    if (!reg) return resolve({ ok: false, error: `no live Claude session ${sessionId}` });
    const sock = reg.messagingSocketPath;
    const hash = crypto.createHash('sha256').update(sock.toLowerCase()).digest('hex');
    let token;
    try {
      token = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${reg.pid}.${hash}.key`), 'utf8')).peerToken;
    } catch (e) { return resolve({ ok: false, error: `key file: ${e.message}` }); }
    let settled = false;
    const done = result => { if (!settled) { settled = true; resolve(result); } };
    const c = net.connect(sock, () => {
      c.write(JSON.stringify({ type: 'auth', token }) + '\n');
      c.write(JSON.stringify({ type: 'user', message: { content: text }, from: 'pair-poc', priority: 'next', msg_id: crypto.randomUUID() }) + '\n');
      setTimeout(() => { c.end(); done({ ok: true, evidence: 'pipe-write', pid: reg.pid }); }, 500);
    });
    c.on('error', e => done({ ok: false, error: `pipe: ${e.message}` }));
    setTimeout(() => { c.destroy(); done({ ok: false, error: 'pipe timeout' }); }, 8000);
  });
}

function deliverCodex(threadId, text) {
  return new Promise(resolve => {
    if (text.length > config.codex_max_chars) {
      return resolve({ ok: false, error: `message is ${text.length} chars; Codex limit ${config.codex_max_chars}` });
    }
    execFile(config.codex_exe, ['queue', '--thread', threadId, '--message', text],
      { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, error: (stderr || err.message).trim() });
        const m = stdout.match(/Queued message (\S+)/);
        resolve({ ok: true, evidence: 'codex-queue', native_id: m ? m[1] : null });
      });
  });
}

export function resolveRecipients(from, to) {
  const list = (Array.isArray(to) ? to : String(to).split(/[,\s]+/)).map(s => s.replace(/^@/, '').toLowerCase()).filter(Boolean);
  if (list.length === 0 || list.includes('all')) {
    return Object.keys(participants).filter(n => n !== from && participants[n].harness !== 'human');
  }
  for (const n of list) if (!participants[n]) throw new Error(`unknown participant "${n}" (known: ${Object.keys(participants).join(', ')})`);
  return [...new Set(list)];
}

export async function send({ from, to, text, reply_to }) {
  if (!participants[from]) throw new Error(`unknown sender "${from}"`);
  if (typeof text !== 'string' || !text.trim()) throw new Error('text is required');
  const recipients = resolveRecipients(from, to ?? 'all');
  const id = `m-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
  const header = from === 'kevin'
    ? `[pair-poc #${id} USER DIRECTIVE from=kevin to=${recipients.join(',')}]`
    : `[pair-poc #${id} from=${from} to=${recipients.join(',')}${reply_to ? ` reply_to=${reply_to}` : ''}]`;
  const footer = `--\nReply with the pair-poc MCP tool send_message (to="${from}", reply_to="${id}"). Kevin sees every message.`;
  const envelope = `${header}\n${text}\n${footer}`;
  append({ type: 'message', id, from, to: recipients, reply_to: reply_to ?? null, text });
  const deliveries = {};
  for (const name of recipients) {
    const p = participants[name];
    let result;
    if (p.harness === 'claude') result = await deliverClaude(p.session_id, envelope);
    else if (p.harness === 'codex') result = await deliverCodex(p.session_id, envelope);
    else result = { ok: true, evidence: 'logged-only' };
    append({ type: 'delivery', id, to: name, ...result });
    deliveries[name] = result;
  }
  return { id, recipients, deliveries };
}
