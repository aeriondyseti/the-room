#!/usr/bin/env node
// pair-poc MCP stdio server. Usage: node pair-mcp.mjs --as <claude|astra>
// Throwaway proof of concept: identity is baked in by --as; recipients and ids live in participants.json.
import { createInterface } from 'node:readline';
import { send, readLog, participants, claudeRegistry, LOG } from './lib.mjs';

const asIndex = process.argv.indexOf('--as');
const self = asIndex > 0 ? process.argv[asIndex + 1] : null;
if (!self || !participants[self]) {
  process.stderr.write(`pair-poc: --as <${Object.keys(participants).join('|')}> is required\n`);
  process.exit(1);
}
const others = Object.keys(participants).filter(n => n !== self);

const tools = [
  {
    name: 'send_message',
    description: `Send a message to the pair room as "${self}". It is delivered natively (wakes the recipient's session) and logged for Kevin. `
      + `Recipients: ${others.join(', ')}, or "all" (every agent except you; Kevin sees everything regardless). Prefer replying to the specific sender with reply_to.`,
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: `Recipient name(s), comma-separated, or "all". Known: ${others.join(', ')}` },
        text: { type: 'string', description: 'Message body (plain text/markdown).' },
        reply_to: { type: 'string', description: 'Id of the message you are replying to (from its [pair-poc #id] header).' },
      },
      required: ['to', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_log',
    description: 'Read recent room messages (and delivery outcomes) from the shared log.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of most recent messages (default 20).' },
        include_deliveries: { type: 'boolean', description: 'Include per-recipient delivery records (default false).' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'participants',
    description: 'List room participants, their harness, and (for Claude) whether the session is live.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

async function callTool(name, args) {
  if (name === 'send_message') return send({ from: self, to: args.to, text: args.text, reply_to: args.reply_to });
  if (name === 'read_log') {
    const records = readLog().filter(r => args.include_deliveries || r.type === 'message');
    return { log: LOG, records: records.slice(-(args.limit || 20)) };
  }
  if (name === 'participants') {
    return Object.fromEntries(Object.entries(participants).map(([n, p]) => [n, {
      ...p,
      you: n === self,
      live: p.harness === 'claude' ? !!claudeRegistry(p.session_id) : p.harness === 'codex' ? 'unknown (queue holds until thread is open)' : null,
    }]));
  }
  throw new Error(`unknown tool ${name}`);
}

const write = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

createInterface({ input: process.stdin }).on('line', async line => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return write({ id: null, error: { code: -32700, message: 'Invalid JSON' } }); }
  if (!('id' in req)) return; // notifications
  const { id, method, params = {} } = req;
  try {
    if (method === 'initialize') {
      write({ id, result: { protocolVersion: params.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'pair-poc', version: '0.1.0' } } });
    } else if (method === 'ping') {
      write({ id, result: {} });
    } else if (method === 'tools/list') {
      write({ id, result: { tools } });
    } else if (method === 'tools/call') {
      const value = await callTool(params.name, params.arguments ?? {});
      write({ id, result: { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] } });
    } else {
      write({ id, error: { code: -32601, message: 'Method not found' } });
    }
  } catch (e) {
    write({ id, result: { isError: true, content: [{ type: 'text', text: `pair-poc error: ${e.message}` }] } });
  }
});
