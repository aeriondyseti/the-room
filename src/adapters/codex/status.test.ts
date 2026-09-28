import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { probeCodexStatus, statusEvidence, type StatusOptions } from './status.js';

const options: StatusOptions = { executable: process.execPath, cwd: process.cwd(), home: process.cwd(), timeoutMs: 2000, maxBytes: 65536 };
const id = '00000000-0000-4000-8000-000000000001';
const unknown = { liveness: 'unknown', activity: 'unknown' };
// A subprocess byte tunnel, not a live harness. It rejects every method except initialize/thread/read.
const script = String.raw`
import {createHash} from 'node:crypto';
let buf=Buffer.alloc(0), upgraded=false;
const mode=process.env.STATUS_TEST_MODE;
function frame(body,op=1,final=true){body=Buffer.from(body);const h=Buffer.alloc(body.length<126?2:4);h[0]=(final?128:0)|op;h[1]=body.length<126?body.length:126;if(body.length>=126)h.writeUInt16BE(body.length,2);return Buffer.concat([h,body]);}
function send(msg){const b=Buffer.from(JSON.stringify(msg));if(mode==='fragment'){const cut=Math.floor(b.length/2);process.stdout.write(frame(b.subarray(0,cut),1,false));process.stdout.write(frame('ping',9));const f=frame(b.subarray(cut),0);process.stdout.write(f.subarray(0,1));setTimeout(()=>process.stdout.write(f.subarray(1)),5);}else process.stdout.write(frame(b));}
process.stdin.on('data',d=>{buf=Buffer.concat([buf,d]);if(!upgraded){const end=buf.indexOf('\r\n\r\n');if(end<0)return;const key=/Sec-WebSocket-Key: (.+)\r\n/.exec(buf.toString())[1];const accept=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');process.stdout.write('HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: '+(mode==='handshake'?'bad':accept)+'\r\n\r\n');buf=buf.subarray(end+4);upgraded=true;}
while(buf.length>=2){const op=buf[0]&15;let n=buf[1]&127,off=2;if(n===126){if(buf.length<4)return;n=buf.readUInt16BE(2);off=4;}if(buf.length<off+4+n)return;const mask=buf.subarray(off,off+4),b=Buffer.from(buf.subarray(off+4,off+4+n));for(let i=0;i<n;i++)b[i]^=mask[i%4];buf=buf.subarray(off+4+n);if(op===10)continue;const m=JSON.parse(b);if(m.method==='initialize')send({id:m.id,result:{}});else if(m.method==='initialized')continue;else if(m.method==='thread/read'&&m.params.threadId==='${id}'&&m.params.includeTurns===false){
if(mode==='timeout')continue;
if(mode==='close'){process.exit(0);}
if(mode==='huge'){process.stdout.write(Buffer.from([129,127,0,0,0,1,0,0,0,0]));continue;}
if(mode==='invalid'){process.stdout.write(frame('{'));continue;}
if(mode==='error'){send({id:m.id,error:{message:'missing'}});continue;}
send({id:m.id,result:{thread:{id:mode==='wrong'?'wrong':m.params.threadId,status:{type:'active',activeFlags:[]}}}});
}else {send({id:m.id,error:{message:'unexpected method'}});process.exitCode=7;}}
});
`;

test('native status maps only understood evidence; unloaded is not offline', () => {
  assert.deepEqual(statusEvidence({ type: 'idle' }), { liveness: 'online', activity: 'idle' });
  assert.deepEqual(statusEvidence({ type: 'active', activeFlags: [] }), { liveness: 'online', activity: 'busy' });
  assert.deepEqual(statusEvidence({ type: 'active', activeFlags: ['waitingOnApproval'] }), { liveness: 'online', activity: 'waiting_permission' });
  assert.deepEqual(statusEvidence({ type: 'active', activeFlags: ['future'] }), { liveness: 'online', activity: 'unknown' });
  for (const s of [null, {}, { type: 'notLoaded' }, { type: 'systemError' }, { type: 'active' }, { type: 'active', activeFlags: [1] }]) assert.deepEqual(statusEvidence(s), unknown);
});
test('read-only native tunnel handles fragmented frames and ping without persisting payloads', async () => {
  for (const mode of ['ok', 'fragment']) {
    const result = await probeCodexStatus(options, id, () => spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe','pipe','pipe'], env: {...process.env, STATUS_TEST_MODE: mode}, windowsHide: true }));
    assert.deepEqual(result, { liveness: 'online', activity: 'busy' }, mode);
  }
});
test('malformed, wrong-thread, unavailable and timed-out probes fail closed', async () => {
  for (const mode of ['handshake', 'close', 'huge', 'invalid', 'error', 'wrong', 'timeout']) {
    const result = await probeCodexStatus({...options, timeoutMs: 500}, id, () => spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe','pipe','pipe'], env: {...process.env, STATUS_TEST_MODE: mode}, windowsHide: true }));
    assert.deepEqual(result, unknown, mode);
  }
  assert.deepEqual(await probeCodexStatus({...options, executable: 'no-such-codex-status.exe'}, id), unknown);
  assert.deepEqual(await probeCodexStatus(options, id, () => {throw new Error('spawn failed');}), unknown);
});
