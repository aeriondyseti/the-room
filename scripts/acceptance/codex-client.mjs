// Qualification fixture only: native proxy WebSocket transport adapted from the bounded background probe.
import {Duplex} from 'node:stream';
import {randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export class ProbeClient {
  constructor({executable,socketPath,log=()=>{}}) { this.executable=executable; this.socketPath=socketPath; this.log=log; this.owned=new Set(); this.label = 'acceptance'; this.pending = new Map(); this.events = []; this.seq = 0; this.buffer = Buffer.alloc(0); this.parts = []; }
  async connect() {
    // Node's Windows pipe transport does not open AF_UNIX socket files. The
    // native Codex proxy supplies a raw byte tunnel; WebSocket framing is ours.
    this.proxy = spawn(this.executable, ['app-server', 'proxy', '--sock', this.socketPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proxy.stderr.on('data', d => this.log('proxy-stderr', { client: this.label, text: d.toString() }));
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
    this.socket.on('error', error => this.log('socket-error', {error:error.message}));
    this.parse();
    const init = await this.rpc('initialize', { clientInfo: { name: 'vibe_background_probe', version: '0.1' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
    this.log('connected',{platform:init.platformOs});
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
  send(msg) { this.log('send', { client: this.label, msg }); this.frame(Buffer.from(JSON.stringify(msg))); }
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
      const event = { at: Date.now(), msg }; if(!msg.method || ['turn/started','turn/completed'].includes(msg.method)) this.events.push(event);
      // Log only events for probe threads, request responses, and targeted server requests.
      const threadId = msg.params?.threadId ?? msg.params?.thread?.id;
      if ((!threadId || this.owned.has(threadId)) && (!msg.method || ['turn/started','turn/completed'].includes(msg.method))) this.log('receive', {client:this.label,msg});
      if (!msg.method && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
    }
  }
  async rpc(method, params = {}) {
    if (params.threadId && !this.owned.has(params.threadId)) throw new Error('Not a probe thread');
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
