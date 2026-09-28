// Shared bounded read-only connection to an existing Codex daemon. Never starts a daemon or thread.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

export interface DaemonReadOptions {
  executable: string; home: string; cwd: string; env?: NodeJS.ProcessEnv;
  timeoutMs: number; maxBytes: number;
}
export type DaemonReadRequest = {method:'thread/read'; threadId:string} | {method:'account/rateLimits/read'};
export type DaemonReadResult = {ok:true;value:unknown} | {ok:false;reason:string};
export type DaemonLaunch = (options:DaemonReadOptions) => ChildProcessWithoutNullStreams;

/** A bounded one-shot WebSocket reader over `codex app-server proxy`'s byte tunnel.
 * Native Windows Node net cannot connect to the daemon's AF_UNIX socket directly.
 * Only initialize and an allowlisted read endpoint are sent. No raw payloads or stderr are logged.
 */
export function readCodexDaemon(options: DaemonReadOptions, request: DaemonReadRequest,
  launch: DaemonLaunch = o => spawn(o.executable,
    ['app-server', 'proxy', '--sock', path.join(o.home, 'app-server-control', 'app-server-control.sock')],
    { cwd: o.cwd, env: o.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }),
): Promise<DaemonReadResult> {
  if (!['thread/read', 'account/rateLimits/read'].includes(request.method)) return Promise.resolve({ok:false, reason:'Unsupported observer endpoint.'});
  // Construct params ourselves: no experiment-capability or control fields can be forwarded.
  const params = request.method === 'thread/read' ? {threadId: request.threadId, includeTurns:false} : {excludeResetCreditDetails:true};
  return new Promise(resolve => {
    let child: ChildProcessWithoutNullStreams;
    try { child = launch(options); } catch { resolve({ok:false,reason:'Codex proxy could not be started.'}); return; }
    let done = false, upgraded = false, received = 0, buffer: Buffer = Buffer.alloc(0);
    let fragments: Buffer[] = [], fragmentBytes = 0, fragmented = false;
    const key = randomBytes(16).toString('base64');
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const finish = (result: DaemonReadResult = {ok:false,reason:'Codex app-server unavailable or response unsupported.'}) => {
      if (done) return;
      done = true; clearTimeout(timer);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ok:false,reason:'Codex app-server read timed out.'}), options.timeoutMs);
    child.on('error', () => finish()); child.on('close', () => finish());
    child.stdin.on('error', () => finish()); child.stdout.on('error', () => finish()); child.stderr.on('error', () => finish());
    child.stderr.on('data', (data: Buffer) => { received += data.length; if (received > options.maxBytes) finish(); });
    const frame = (body: Buffer, opcode = 1) => {
      const mask = randomBytes(4), n = body.length;
      // Observer requests are tiny. Reject instead of ever encoding a 64-bit outgoing frame.
      if(n>65535){finish({ok:false,reason:'Codex observer request exceeds frame limit.'});return;}
      const header = Buffer.alloc(n < 126 ? 2 : 4);
      header[0] = 0x80 | opcode; header[1] = 0x80 | (n < 126 ? n : 126);
      if (n >= 126) header.writeUInt16BE(n, 2);
      const masked = Buffer.from(body);
      for (let i = 0; i < n; i++) masked[i] = masked[i]! ^ mask[i % 4]!;
      child.stdin.write(Buffer.concat([header, mask, masked]));
    };
    const send = (value: unknown) => frame(Buffer.from(JSON.stringify(value)));
    const message = (body: Buffer) => {
      const msg = JSON.parse(body.toString('utf8'));
      if (!msg || typeof msg !== 'object' || msg.method) return;
      if (msg.id === 1) {
        if (msg.error || !msg.result) { finish(); return; }
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: request.method, params });
      } else if (msg.id === 2) {
        finish(!msg.error && msg.result !== undefined ? {ok:true,value:msg.result} : {ok:false,reason:'Codex app-server rejected the usage/status read.'});
      }
    };
    child.stdout.on('data', (data: Buffer) => {
      if (done) return;
      try {
        received += data.length;
        if (received > options.maxBytes) { finish(); return; }
        buffer = Buffer.concat([buffer, data]);
        if (!upgraded) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) return;
          const lines = buffer.subarray(0, end).toString('ascii').split('\r\n');
          const headers = new Map(lines.slice(1).map(line => { const colon = line.indexOf(':'); return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()]; }));
          if (!/^HTTP\/1\.1 101(?: |$)/.test(lines[0]!) || headers.get('sec-websocket-accept') !== accept) { finish(); return; }
          buffer = buffer.subarray(end + 4); upgraded = true;
          send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'vibe_room_observer', version: '1' } } });
        }
        while (!done && buffer.length >= 2) {
          const first = buffer[0]!, second = buffer[1]!, opcode = first & 15, final = !!(first & 128);
          if ((first & 112) || (second & 128)) { finish(); return; }
          let size = second & 127, offset = 2;
          if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
          else if (size === 127) {
            if (buffer.length < 10) return;
            const big = buffer.readBigUInt64BE(2);
            if (big > BigInt(options.maxBytes)) { finish(); return; }
            size = Number(big); offset = 10;
          }
          if (size + fragmentBytes > options.maxBytes) { finish(); return; }
          if (buffer.length < offset + size) return;
          const body = buffer.subarray(offset, offset + size); buffer = buffer.subarray(offset + size);
          if (opcode >= 8) {
            if (!final || size > 125) { finish(); return; }
            if (opcode === 8) { finish(); return; }
            if (opcode === 9) frame(body, 10);
            else if (opcode !== 10) { finish(); return; }
            continue;
          }
          if ((opcode !== 0 && opcode !== 1) || (opcode === 0) !== fragmented) { finish(); return; }
          fragments.push(body); fragmentBytes += size; fragmented = !final;
          if (final) { const all = Buffer.concat(fragments); fragments = []; fragmentBytes = 0; message(all); }
        }
      } catch { finish(); }
    });
    child.stdin.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
}
