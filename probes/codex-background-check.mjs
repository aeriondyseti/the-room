// Research-only runner. Mutating RPCs are restricted to IDs created in its manifest.
import { Duplex } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const cx = 'C:/Users/Kevin/.codex/packages/standalone/current/bin/codex.exe';
const socketPath = 'C:/Users/Kevin/.codex/app-server-control/app-server-control.sock';
const root = path.resolve(process.argv[2] || '.room/probes/codex-background');
fs.mkdirSync(root, { recursive: true });
const manifestPath = path.join(root, 'manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath)) : { createdAt: new Date().toISOString(), threads: [] };
const save = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
const eventsPath = path.join(root, 'events.jsonl');
function log(kind, data) { fs.appendFileSync(eventsPath, JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + '\n'); }
function note(label, data = {}) { log('note', { label, ...data }); console.log(JSON.stringify({ label, ...data })); }
const delay = ms => new Promise(r => setTimeout(r, ms));

class Client {
  constructor(label) { this.label = label; this.pending = new Map(); this.events = []; this.seq = 0; this.buffer = Buffer.alloc(0); this.parts = []; }
  async connect() {
    // Node's Windows pipe transport does not open AF_UNIX socket files. The
    // native Codex proxy supplies a raw byte tunnel; WebSocket framing is ours.
    this.proxy = spawn(cx, ['app-server', 'proxy', '--sock', socketPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proxy.stderr.on('data', d => log('proxy-stderr', { client: this.label, text: d.toString() }));
    this.socket = Duplex.from({ readable: this.proxy.stdout, writable: this.proxy.stdin });
    const key = randomBytes(16).toString('base64');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('upgrade timeout')), 10000);
      const onData = chunk => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const header = this.buffer.subarray(0, end).toString();
        const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (!header.startsWith('HTTP/1.1 101') || !header.includes(expected)) { clearTimeout(timer); reject(new Error(header)); return; }
        this.buffer = this.buffer.subarray(end + 4); this.socket.off('data', onData); clearTimeout(timer); resolve();
      };
      this.socket.on('data', onData);
      this.socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    this.socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.parse(); });
    this.socket.on('error', error => note('socket-error', { client: this.label, error: error.message }));
    this.parse();
    const init = await this.rpc('initialize', { clientInfo: { name: 'vibe_background_probe', version: '0.1' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
    note('connected', { client: this.label, platform: init.platformOs });
    return this;
  }
  frame(bytes, opcode = 1) {
    const mask = randomBytes(4); const size = bytes.length;
    const head = Buffer.alloc(size < 126 ? 2 : size <= 65535 ? 4 : 10);
    head[0] = 0x80 | opcode; head[1] = 0x80 | (size < 126 ? size : size <= 65535 ? 126 : 127);
    if (size >= 126 && size <= 65535) head.writeUInt16BE(size, 2);
    if (size > 65535) head.writeBigUInt64BE(BigInt(size), 2);
    const masked = Buffer.from(bytes); for (let i = 0; i < size; i++) masked[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([head, mask, masked]));
  }
  send(msg) { log('send', { client: this.label, msg }); this.frame(Buffer.from(JSON.stringify(msg))); }
  parse() {
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0] & 15, final = !!(this.buffer[0] & 128), masked = !!(this.buffer[1] & 128);
      let n = this.buffer[1] & 127, offset = 2;
      if (n === 126) { if (this.buffer.length < 4) return; n = this.buffer.readUInt16BE(2); offset = 4; }
      else if (n === 127) { if (this.buffer.length < 10) return; n = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      if (masked) offset += 4;
      if (this.buffer.length < offset + n) return;
      const body = Buffer.from(this.buffer.subarray(offset, offset + n));
      if (masked) for (let i = 0; i < n; i++) body[i] ^= this.buffer[offset - 4 + i % 4];
      this.buffer = this.buffer.subarray(offset + n);
      if (opcode === 9) { this.frame(body, 10); continue; }
      if (opcode === 8) { this.socket.end(); return; }
      if (opcode !== 1 && opcode !== 0) continue;
      this.parts.push(body); if (!final) continue;
      const msg = JSON.parse(Buffer.concat(this.parts).toString()); this.parts = [];
      const event = { at: Date.now(), msg }; this.events.push(event);
      // Log only events for probe threads, request responses, and targeted server requests.
      const threadId = msg.params?.threadId ?? msg.params?.thread?.id;
      if (!threadId || manifest.threads.some(t => t.id === threadId)) log('receive', { client: this.label, msg });
      if (!msg.method && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
    }
  }
  async rpc(method, params = {}) {
    if (params.threadId && !manifest.threads.some(t => t.id === params.threadId)) throw new Error('Not a probe thread');
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout ${method}`)); }, 30000);
      this.pending.set(id, msg => { clearTimeout(timer); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); });
      this.send({ id, method, params });
    });
  }
  async wait(predicate, timeout = 60000, since = 0) {
    const end = Date.now() + timeout;
    do { const event = this.events.find(e => e.at >= since && predicate(e.msg)); if (event) return event; await delay(100); } while (Date.now() < end);
    return null;
  }
  close() { this.socket.destroy(); this.proxy.kill(); }
}

async function command(args, timeout = 90000) {
  const child = spawn(cx, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  const timer = setTimeout(() => child.kill(), timeout);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  clearTimeout(timer); log('command', { args, code, stdout, stderr }); return { code, stdout, stderr };
}

const client = await new Client('primary').connect();
const completion = (id, turn) => m => m.method === 'turn/completed' && m.params.threadId === id && (!turn || m.params.turn.id === turn);
const input = text => [{ type: 'text', text }];
async function newThread(label, extra = {}) {
  const data = await client.rpc('thread/start', { cwd: root, sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user',
    developerInstructions: 'This is a bounded throwaway Codex harness experiment. Follow the probe prompt exactly. Do not access other projects, message other agents, spawn subagents, or modify global configuration. Do not use MCP tools.',
    config: { model_reasoning_effort: 'low' }, ...extra });
  manifest.threads.push({ id: data.thread.id, label, path: data.thread.path, model: data.model }); save();
  await client.rpc('thread/name/set', { threadId: data.thread.id, name: `vibe-bg-probe-${label}` }).catch(e => note('name-error', { error: e.message }));
  note('thread-created', { id: data.thread.id, label, model: data.model, path: data.thread.path }); return data.thread.id;
}

try {
  const phase = process.argv[3] || 'idle';
  if (phase === 'idle') {
    const id = await newThread('queue');
    const begin = Date.now();
    const sent = await command(['queue', '--thread', id, '--message', 'Reply with exactly BG-IDLE-PONG. Do not use tools.']);
    note('idle-queue-command', { code: sent.code, stdout: sent.stdout.trim(), elapsedMs: Date.now() - begin });
    const ended = await client.wait(completion(id), 20000, begin);
    note('idle-20s-window', { completed: !!ended, elapsedMs: ended ? ended.at - begin : null, started: client.events.filter(e => e.at >= begin && e.msg.method === 'turn/started').map(e => ({ at: e.at, params: e.msg.params })) });
    note('idle-queue-list', await client.rpc('thread/queue/list', { threadId: id }));
    if (!ended) {
      const startAt = Date.now(); const started = await client.rpc('thread/queue/start', { threadId: id });
      note('explicit-queue-start', started);
      note('explicit-queue-completion', { event: await client.wait(completion(id, started.turn.id), 90000, startAt) });
    }
    note('thread-read', await client.rpc('thread/read', { threadId: id }));
  } else if (phase === 'busy-stop') {
    const id = manifest.threads.find(t => t.label === 'queue').id;
    await client.rpc('thread/resume', { threadId: id, excludeTurns: true });
    const begin = Date.now();
    const first = await client.rpc('turn/start', { threadId: id, input: input('Run exactly one PowerShell command: Start-Sleep -Seconds 12; Write-Output BG-SLEEP-DONE. Wait for the command to finish, then reply BG-BUSY-FIRST. This is a timing probe, so actually run the command.') });
    const commandStarted = await client.wait(m => m.method === 'item/started' && m.params.threadId === id && m.params.item.type === 'commandExecution', 45000, begin);
    note('busy-command-started', { event: commandStarted });
    if (!commandStarted) throw new Error('No commandExecution start');
    const queuedAt = Date.now();
    note('busy-queue-command', await command(['queue', '--thread', id, '--message', 'Reply exactly BG-BUSY-SECOND. Do not use tools.']));
    const firstDone = await client.wait(completion(id, first.turn.id), 90000, begin);
    const nextStart = await client.wait(m => m.method === 'turn/started' && m.params.threadId === id && m.params.turn.id !== first.turn.id, 30000, queuedAt);
    const nextDone = nextStart && await client.wait(completion(id, nextStart.msg.params.turn.id), 60000, nextStart.at);
    note('busy-order', { firstDone, nextStart, nextDone, nextStartAfterFirstMs: firstDone && nextStart ? nextStart.at - firstDone.at : null });

    const stopAt = Date.now();
    const long = await client.rpc('turn/start', { threadId: id, input: input('Run exactly one PowerShell command: Start-Sleep -Seconds 45; Write-Output BG-SHOULD-NOT-FINISH. Wait for it. This is an interrupt probe; do not shorten the sleep.') });
    const longCommand = await client.wait(m => m.method === 'item/started' && m.params.threadId === id && m.params.item.type === 'commandExecution', 45000, stopAt);
    note('interrupt-command-started', { event: longCommand });
    if (!longCommand) throw new Error('No interrupt command start');
    await delay(2000);
    const interruptAt = Date.now();
    note('interrupt-rpc', await client.rpc('turn/interrupt', { threadId: id, turnId: long.turn.id }));
    const stopped = await client.wait(completion(id, long.turn.id), 15000, stopAt);
    note('interrupt-completed', { event: stopped, elapsedMs: stopped ? stopped.at - interruptAt : null });
    await client.rpc('thread/resume', { threadId: id, excludeTurns: true });
    const afterAt = Date.now();
    const after = await client.rpc('turn/start', { threadId: id, input: input('Reply exactly BG-AFTER-INTERRUPT. Do not use tools.') });
    note('after-interrupt', { event: await client.wait(completion(id, after.turn.id), 60000, afterAt) });
  } else if (phase === 'disconnected') {
    const id = manifest.threads.find(t => t.label === 'queue').id;
    await client.rpc('thread/resume', { threadId: id, excludeTurns: true });
    await client.rpc('thread/unsubscribe', { threadId: id });
    client.close();
    const startedAt = Date.now();
    note('no-client-queue', await command(['queue', '--thread', id, '--message', 'Reply exactly BG-NO-CLIENT-PONG. Do not use tools.']));
    await delay(15000);
    const observer = await new Client('reconnected-observer').connect();
    try {
      note('no-client-after-15s', { elapsedMs: Date.now() - startedAt, read: await observer.rpc('thread/read', { threadId: id }), turns: await observer.rpc('thread/turns/list', { threadId: id, limit: 2, itemsView: 'full' }), queue: await observer.rpc('thread/queue/list', { threadId: id }) });
    } finally { observer.close(); }
  } else if (phase === 'approval') {
    const id = await newThread('approval', { approvalPolicy: 'untrusted', approvalsReviewer: 'user' });
    const warmAt = Date.now();
    const warm = await client.rpc('turn/start', { threadId: id, input: input('Reply exactly BG-APPROVAL-READY. Do not use tools.') });
    if (!await client.wait(completion(id, warm.turn.id), 60000, warmAt)) throw new Error('Approval warmup failed');
    const observer = await new Client('approval-observer').connect();
    try {
      await observer.rpc('thread/resume', { threadId: id, excludeTurns: true });
      const begin = Date.now();
      const turn = await client.rpc('turn/start', { threadId: id, input: input(`This is a permission-prompt experiment. Run one PowerShell command to write a harmless marker: Set-Content -LiteralPath '${path.join(root, 'approval-marker.txt')}' -Value 'BG-APPROVED'. Request permission if the sandbox requires it; do not work around a denial and do not use another tool to write it.`) });
      const isApproval = m => m.id !== undefined && m.method && /requestApproval|requestUserInput/.test(m.method) && m.params?.threadId === id;
      const primaryRequest = await client.wait(isApproval, 60000, begin);
      await delay(10000);
      note('approval-unanswered-10s', { primaryRequest, observerRequests: observer.events.filter(e => e.at >= begin && isApproval(e.msg)), markerExists: fs.existsSync(path.join(root, 'approval-marker.txt')), status: await observer.rpc('thread/read', { threadId: id }), completed: !!client.events.find(e => e.at >= begin && completion(id, turn.turn.id)(e.msg)) });
      client.close();
      await delay(5000);
      note('approval-primary-disconnected-5s', { status: await observer.rpc('thread/read', { threadId: id }), observerRequests: observer.events.filter(e => e.at >= begin && isApproval(e.msg)) });
      await observer.rpc('turn/interrupt', { threadId: id, turnId: turn.turn.id });
      note('approval-interrupted', { event: await observer.wait(completion(id, turn.turn.id), 15000, begin) });
    } finally { observer.close(); }
  } else if (phase === 'exec-conflict') {
    const id = manifest.threads.find(t => t.label === 'queue').id;
    await client.rpc('thread/resume', { threadId: id, excludeTurns: true });
    note('exec-resume-daemon-hosted', await command(['exec', 'resume', '--ignore-user-config', '--skip-git-repo-check', '--json', id, 'Reply exactly BG-EXEC-PONG. Do not use tools.'], 45000));
  } else if (phase === 'exec-standalone') {
    const seed = await command(['exec', '--ignore-user-config', '--skip-git-repo-check', '--json', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort="low"', 'Reply exactly BG-EXEC-SEED. Do not use tools.']);
    const lines = seed.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const id = lines.find(e => e.type === 'thread.started')?.thread_id;
    note('exec-seed', { ...seed, id });
    if (!id) throw new Error('No exec seed thread id');
    manifest.threads.push({ id, label: 'exec-standalone' }); save();
    note('exec-resume-standalone', await command(['exec', 'resume', '--ignore-user-config', '--skip-git-repo-check', '--json', id, 'Reply exactly BG-EXEC-RESUMED. Do not use tools.']));
  } else if (phase === 'exec-tui-conflict') {
    const id = manifest.threads.find(t => t.label === 'exec-standalone').id;
    note('exec-resume-tui-hosted', await command(['exec', 'resume', '--ignore-user-config', '--skip-git-repo-check', '--json', id, 'Reply exactly BG-EXEC-TUI-CHECK. Do not use tools.'], 30000));
  } else if (phase === 'approval-no-client') {
    const id = manifest.threads.filter(t => t.label === 'approval').at(-1).id;
    await client.rpc('thread/resume', { threadId: id, excludeTurns: true });
    const begin = Date.now();
    const turn = await client.rpc('turn/start', { threadId: id, input: input(`Run PowerShell Set-Content -LiteralPath '${path.join(root, 'approval-marker-2.txt')}' -Value 'BG-APPROVED-2'. This is a second approval probe. Request permission; do not bypass a denial.`) });
    const isApproval = m => m.id !== undefined && m.method && /requestApproval/.test(m.method) && m.params?.threadId === id;
    const pending = await client.wait(isApproval, 60000, begin);
    note('approval-before-all-disconnect', { pending });
    if (!pending) throw new Error('No approval request');
    client.close(); await delay(10000);
    const reconnect = await new Client('approval-reconnect').connect();
    try {
      note('approval-no-clients-10s', { status: await reconnect.rpc('thread/read', { threadId: id }), markerExists: fs.existsSync(path.join(root, 'approval-marker-2.txt')) });
      await reconnect.rpc('thread/resume', { threadId: id, excludeTurns: true });
      const replay = await reconnect.wait(isApproval, 5000, begin);
      note('approval-replay-on-resume', { replay });
      if (replay) reconnect.send({ id: replay.msg.id, result: { decision: 'cancel' } });
      else await reconnect.rpc('turn/interrupt', { threadId: id, turnId: turn.turn.id });
      note('approval-after-reconnect-resolution', { event: await reconnect.wait(completion(id, turn.turn.id), 30000, begin) });
    } finally { reconnect.close(); }
  } else if (phase === 'adopt') {
    const id = manifest.threads.find(t => t.label === 'exec-standalone').id;
    const adopted = await client.rpc('thread/resume', { threadId: id, excludeTurns: true, approvalPolicy: 'never', sandbox: 'read-only' });
    manifest.threads.find(t => t.id === id).path = adopted.thread.path; save();
    note('daemon-adopt-saved-thread', { id: adopted.thread.id, status: adopted.thread.status });
    const begin = Date.now();
    note('adopted-queue', await command(['queue', '--thread', id, '--message', 'Reply exactly BG-ADOPTED-PONG. Do not use tools.']));
    note('adopted-completed', { event: await client.wait(completion(id), 60000, begin) });
  } else if (phase === 'cleanup') {
    for (const thread of manifest.threads) {
      if (thread.path && fs.existsSync(thread.path)) {
        const lines = fs.readFileSync(thread.path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
        const counts = {};
        for (const row of lines) { const type = `${row.type}/${row.payload?.type ?? ''}`; counts[type] = (counts[type] || 0) + 1; }
        log('rollout-summary', { threadId: thread.id, bytes: fs.statSync(thread.path).size, counts });
        fs.copyFileSync(thread.path, path.join(root, `${thread.id}.rollout.jsonl`));
      }
      try {
        await client.rpc('thread/delete', { threadId: thread.id });
        thread.cleanedUp = true; save(); note('deleted-probe-thread', { id: thread.id });
      } catch (error) { note('cleanup-error', { id: thread.id, error: error.message }); }
    }
  }
} catch (e) { note('failure', { error: e.stack }); process.exitCode = 1; }
finally { client.close(); }
