#!/usr/bin/env node
// Throwaway MCP stdio probe for Claude Code caller identity. Read-only.
// Reports: env session vars (names of CLAUDE* vars; values only for non-secret ids),
// per-call _meta identity fields, parent pid, and the nearest ancestor pid that has
// a ~/.claude/sessions/<pid>.json registry entry (with its sessionId).
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const instanceId = randomUUID();
let clientInfo = null, initialized = false, calls = 0;
const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
const SAFE_VALUES = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE', 'CLAUDE_SESSION_ID'];

function processTable() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }'],
    { encoding: 'utf8', windowsHide: true });
  const t = new Map();
  for (const l of out.split(/\r?\n/)) { const m = l.match(/^(\d+) (\d+) (.*)$/); if (m) t.set(+m[1], { ppid: +m[2], name: m[3].trim() }); }
  return t;
}
function registry(pid) {
  const f = path.join(sessionsDir, `${pid}.json`);
  if (!fs.existsSync(f)) return null;
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  return { pid, sessionId: r.sessionId, name: r.name ?? null, kind: r.kind ?? null, status: r.status ?? null };
}
function ancestry() {
  const direct = registry(process.ppid);
  let chain = [], found = direct, t = null;
  if (!found) {
    t = processTable();
    let pid = process.ppid;
    for (let i = 0; i < 12 && pid && t.has(pid); i++) {
      chain.push(`${pid}:${t.get(pid).name}`);
      found = registry(pid); if (found) break;
      pid = t.get(pid).ppid;
    }
  }
  return { parent_pid: process.ppid, parent_is_registered_session: !!direct, chain, registry_match: found };
}
function metaIds(meta) {
  const fields = [], ids = {};
  const visit = (v, p = '', d = 0) => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || d > 4) return;
    for (const [k, item] of Object.entries(v)) {
      const q = p ? `${p}.${k}` : k; fields.push(q);
      const leaf = k.split('/').at(-1);
      if (/(?:thread|session)[_-]?id$/i.test(leaf) && typeof item === 'string') ids[q] = item;
      visit(item, q, d + 1);
    }
  };
  visit(meta); return { field_names: fields, identity_fields: ids };
}
function identity(params) {
  return {
    server_instance_id: instanceId, pid: process.pid, calls, client_info: clientInfo,
    env_claude_var_names: Object.keys(process.env).filter(k => /^CLAUDE/i.test(k)).sort(),
    env_safe_values: Object.fromEntries(SAFE_VALUES.map(k => [k, process.env[k] ?? null])),
    params_meta: metaIds(params?._meta),
    ancestry: ancestry(),
  };
}
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const tools = [{ name: 'claude_identity', description: 'Report the calling Claude session identity evidence (env, per-call metadata, parent process registry). Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }];
createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (!('id' in req)) { if (req.method === 'notifications/initialized') initialized = true; return; }
  const { id, method, params = {} } = req;
  if (method === 'initialize') { clientInfo = params.clientInfo ?? null;
    send(id, { protocolVersion: params.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'claude-identity-probe', version: '0.1.0' } }); }
  else if (method === 'ping') send(id, {});
  else if (method === 'tools/list') send(id, { tools });
  else if (method === 'tools/call') { calls++; const v = identity(params);
    send(id, { content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] }); }
  else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }) + '\n');
});
