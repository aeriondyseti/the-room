import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readCodexDaemon, type DaemonReadRequest } from './daemon-read.js';

const options = {executable:process.execPath,home:process.cwd(),cwd:process.cwd(),timeoutMs:2000,maxBytes:65536};
// Fake byte tunnel checks the emitted method/params; no real daemon or account is contacted.
const script = String.raw`
import {createHash} from 'node:crypto';let buf=Buffer.alloc(0),up=false;
const frame=value=>{const b=Buffer.from(JSON.stringify(value)),h=Buffer.alloc(b.length<126?2:4);h[0]=129;h[1]=b.length<126?b.length:126;if(b.length>=126)h.writeUInt16BE(b.length,2);process.stdout.write(Buffer.concat([h,b]));};
process.stdin.on('data',d=>{buf=Buffer.concat([buf,d]);if(!up){const end=buf.indexOf('\r\n\r\n');if(end<0)return;const key=/Sec-WebSocket-Key: (.+)\r\n/.exec(buf.toString())[1];const accept=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');process.stdout.write('HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');buf=buf.subarray(end+4);up=true;}
while(buf.length>=2){let n=buf[1]&127,o=2;if(n===126){if(buf.length<4)return;n=buf.readUInt16BE(2);o=4;}if(buf.length<o+4+n)return;const mask=buf.subarray(o,o+4),b=Buffer.from(buf.subarray(o+4,o+4+n));for(let i=0;i<n;i++)b[i]^=mask[i%4];buf=buf.subarray(o+4+n);const m=JSON.parse(b);if(m.method==='initialize')frame({id:m.id,result:{}});else if(m.method==='initialized')continue;else if(m.method==='account/rateLimits/read')frame({id:m.id,result:{observedParams:m.params,rateLimits:{primary:{usedPercent:12,windowDurationMins:10080,resetsAt:1791058177}}}});else frame({id:m.id,error:{code:-1}});}
});
`;

test('account snapshot sends only the read endpoint and fixed non-experimental polling params', async () => {
  const request = {method:'account/rateLimits/read',params:{supportsLunaReserve:true,extra:'never forward'}} as unknown as DaemonReadRequest;
  const result = await readCodexDaemon(options,request,()=>spawn(process.execPath,['--input-type=module','-e',script],{windowsHide:true,stdio:['pipe','pipe','pipe']}));
  assert.equal(result.ok,true);
  if(result.ok){
    const value=result.value as {observedParams:unknown;rateLimits:unknown};
    assert.deepEqual(value.observedParams,{excludeResetCreditDetails:true});
    assert.ok(value.rateLimits);
  }
});

test('observer transport refuses control endpoints before creating a subprocess', async () => {
  let launched=false;
  const result=await readCodexDaemon(options,{method:'turn/start'} as unknown as DaemonReadRequest,()=>{launched=true;throw Error('must not launch');});
  assert.equal(result.ok,false);assert.equal(launched,false);
});
