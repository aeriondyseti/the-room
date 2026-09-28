#!/usr/bin/env node
// Tiny, dependency-free MCP stdio probe. No files, subprocesses, or network access.
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const environmentNames = ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID'];
const instanceId = randomUUID();
const startedAt = new Date().toISOString();
let clientInfo = null;
let negotiatedVersion = null;
let initialized = false;
let toolCallCount = 0;

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const tools = [
  {
    name: 'probe_identity',
    description: 'Read the MCP process thread/session environment IDs, PID, parent PID, instance ID, and call counter. Missing IDs return null; nothing is inferred from room files or arguments.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations,
  },
  {
    name: 'probe_call_context',
    description: 'Inspect MCP per-call context: metadata field names and explicit thread/session ID fields only, plus process identity. Unknown metadata values are not returned.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations,
  },
  {
    name: 'probe_echo',
    description: 'Echo a supplied string exactly with its UTF-8 SHA-256 and lengths to test structured multiline/quote/Unicode transport. No message is sent to another agent.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 16000 } }, required: ['text'], additionalProperties: false },
    annotations,
  },
];

function identity() {
  return {
    server_instance_id: instanceId,
    started_at: startedAt,
    observed_at: new Date().toISOString(),
    pid: process.pid,
    parent_pid: process.ppid,
    tool_call_count: toolCallCount,
    cwd: process.cwd(),
    node_version: process.version,
    environment: Object.fromEntries(environmentNames.map(name => [name, process.env[name] ?? null])),
    client_info: clientInfo,
    protocol_version: negotiatedVersion,
    note: 'Environment IDs describe this server process. They do not establish the calling thread if the process is shared. No ID is hardcoded or read from session.toml.',
  };
}

function metadataSummary(meta) {
  const fields = [];
  const identityFields = {};
  const visit = (value, prefix = '', depth = 0) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4) return;
    for (const [key, item] of Object.entries(value)) {
      if (fields.length >= 80) return;
      const path = prefix ? `${prefix}.${key}` : key;
      fields.push(path);
      // Recognize namespaced keys too; do not echo tokens or other metadata values.
      const leaf = key.split('/').at(-1);
      if (/^(?:codex[_-]?)?(?:thread|session)[_-]?id$/i.test(leaf) && typeof item === 'string' && item.length <= 256) {
        identityFields[path] = item;
      }
      visit(item, path, depth + 1);
    }
  };
  visit(meta);
  return { metadata_field_names: fields, explicit_identity_fields: identityFields };
}

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
function error(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}
function result(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (!line.trim()) return;
  let request;
  try { request = JSON.parse(line); } catch { error(null, -32700, 'Invalid JSON'); return; }
  if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    error(null, -32600, 'Invalid JSON-RPC request'); return;
  }
  if (!Object.hasOwn(request, 'id')) {
    if (request.method === 'notifications/initialized' && negotiatedVersion) initialized = true;
    return; // Notifications receive no response.
  }
  const { id, method, params = {} } = request;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    error(id, -32602, 'Expected object params'); return;
  }
  if (method === 'initialize') {
    if (negotiatedVersion) { error(id, -32600, 'Already initialized'); return; }
    negotiatedVersion = versions.includes(params.protocolVersion) ? params.protocolVersion : '2025-06-18';
    clientInfo = { name: params.clientInfo?.name ?? null, version: params.clientInfo?.version ?? null };
    send(id, { protocolVersion: negotiatedVersion, capabilities: { tools: {} }, serverInfo: { name: 'thread-id-probe', version: '0.1.0' } });
  } else if (method === 'ping') {
    send(id, {});
  } else if (!initialized) {
    error(id, -32000, 'Initialize first');
  } else if (method === 'tools/list') {
    send(id, { tools });
  } else if (method === 'tools/call') {
    const tool = tools.find(item => item.name === params.name);
    if (!tool) { error(id, -32602, 'Unknown tool'); return; }
    const args = params.arguments ?? {};
    if (typeof args !== 'object' || Array.isArray(args) || args === null ||
        Object.keys(args).some(key => tool.name !== 'probe_echo' || key !== 'text') ||
        (tool.name === 'probe_echo' && (typeof args.text !== 'string' || args.text.length > 16000))) {
      error(id, -32602, 'Invalid tool arguments'); return;
    }
    toolCallCount++;
    const value = identity();
    if (tool.name === 'probe_call_context') {
      value.request_id = id; // JSON-RPC correlation ID, not a native thread ID.
      value.params_metadata = metadataSummary(params._meta);
      value.request_metadata = metadataSummary(request._meta);
    } else if (tool.name === 'probe_echo') {
      value.echo = {
        text: args.text,
        utf16_code_units: args.text.length,
        utf8_bytes: Buffer.byteLength(args.text, 'utf8'),
        sha256_utf8: createHash('sha256').update(args.text, 'utf8').digest('hex'),
      };
    }
    send(id, result(value));
  } else {
    error(id, -32601, 'Method not found');
  }
});
