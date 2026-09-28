import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

async function exercise(synthetic) {
  const env = { ...process.env };
  for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID']) delete env[key];
  if (synthetic) Object.assign(env, { CODEX_THREAD_ID: 'synthetic-thread', CODEX_SESSION_ID: 'synthetic-session' });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./thread-id-mcp.mjs', import.meta.url))], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let nextId = 0;
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const notify = (method, params = {}) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 5000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-test', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    notify('notifications/initialized');
    const list = await call('tools/list');
    assert.equal(list.result.tools.length, 3);
    const first = (await call('tools/call', { name: 'probe_identity', arguments: {} })).result.structuredContent;
    assert.equal(first.environment.CODEX_THREAD_ID, synthetic ? 'synthetic-thread' : null);
    assert.equal(first.environment.CODEX_SESSION_ID, synthetic ? 'synthetic-session' : null);
    assert.equal(first.environment.CLAUDE_CODE_SESSION_ID, null);
    assert.equal(first.pid, child.pid);
    assert.equal(first.parent_pid, process.pid);
    const context = (await call('tools/call', { name: 'probe_call_context', arguments: {}, _meta: { threadId: 'per-call-thread', secret: 'DO-NOT-RETURN' } })).result.structuredContent;
    assert.equal(context.server_instance_id, first.server_instance_id);
    assert.equal(context.tool_call_count, 2);
    assert.equal(context.params_metadata.explicit_identity_fields.threadId, 'per-call-thread');
    assert.ok(!JSON.stringify(context).includes('DO-NOT-RETURN'));
    const text = '"quotes" \'single\' `backticks` $dollars \\path\nsecond line 🦊';
    const echo = (await call('tools/call', { name: 'probe_echo', arguments: { text } })).result.structuredContent.echo;
    assert.equal(echo.text, text);
    assert.equal(echo.sha256_utf8, createHash('sha256').update(text).digest('hex'));
    assert.equal((await call('tools/call', { name: 'probe_identity', arguments: { unexpected: true } })).error.code, -32602);
    assert.equal((await call('tools/call', { name: 'missing' })).error.code, -32602);
    assert.equal(stderr, '');
    console.log(`PASS: ${synthetic ? 'synthetic' : 'absent'} identity, lifecycle, tools, metadata filtering, echo, errors`);
  } finally {
    child.stdin.end();
    child.kill();
    lines.close();
  }
}

await exercise(false);
await exercise(true);
