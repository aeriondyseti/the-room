// TD-0008 qualification probe: what does a Claude messaging pipe send back after auth + a user frame?
// THROWAWAY FIXTURES ONLY: refuses any session whose registry name doesn't start with "vpfix-".
// Logs frame types/keys and non-secret values; the peer token is never printed.
//   node scripts/probes/pipe-frames.mjs <sessionId> <case: idle|burst|badtoken> [listenMs]
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [sessionId, which = 'idle', listenArg = '8000'] = process.argv.slice(2);
const listenMs = Number(listenArg);
const reg = await import(pathToFileURL(resolve('dist/adapters/claude/registry.js')).href);
const deps = reg.defaultRegistryDeps(reg.resolveClaudeConfigDir(null), 5000);
const found = await reg.lookupSession(sessionId, deps);
if (found.status !== 'live') throw new Error(`session ${sessionId}: ${found.status} ${found.detail ?? ''}`);
const record = found.record;
if (!String(record.name ?? '').startsWith('vpfix-')) throw new Error(`refusing: ${record.name} is not a vpfix-* throwaway fixture`);
const token = which === 'badtoken' ? 'not-the-token' : await reg.readPeerToken(record, deps);
if (!token) throw new Error('no peer token');

const redact = (v) => JSON.parse(JSON.stringify(v, (k, x) => (/token/i.test(k) ? '<redacted>' : x)));
const t0 = Date.now();
const log = (...a) => console.log(`+${String(Date.now() - t0).padStart(5)}ms`, ...a);

const socket = connect(record.messagingSocketPath);
let buf = '';
socket.setEncoding('utf8');
socket.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try { log('FRAME', JSON.stringify(redact(JSON.parse(line)))); } catch { log('RAW', line.slice(0, 300)); }
  }
});
socket.on('close', () => log('CLOSE'));
socket.on('error', (e) => log('ERROR', e.code ?? e.message));
socket.on('connect', () => {
  log('connected');
  socket.write(JSON.stringify({ type: 'auth', token }) + '\n');
  const frame = (n) => JSON.stringify({ type: 'user', message: { content: `pipe-frames probe ${which} ${n}: reply ack` }, from: 'pipe-probe', priority: 'next', msg_id: `probe-${t0}-${n}` }) + '\n';
  socket.write(frame(1));
  log('wrote user frame 1');
  if (which === 'burst') { socket.write(frame(2)); log('wrote user frame 2'); }
});
setTimeout(() => { log('done listening'); socket.end(); setTimeout(() => process.exit(0), 300); }, listenMs);
