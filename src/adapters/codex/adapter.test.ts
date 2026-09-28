import assert from 'node:assert/strict';import{test,type TestContext}from'node:test';
import{mkdtemp,writeFile,readFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import path from'node:path';
import{CodexAdapter,quoteWindowsArgument,windowsCommandLineLength,resolveCodexExecutable,type CodexOptions}from'./adapter.js';
import type{SubmitRequest}from'../../contracts/adapter.js';import{buildEnvelope}from'../../core/dispatch/envelope.js';
const thread='00000000-0000-4000-8000-000000000001',queue='00000000-0000-4000-8000-000000000099';
const request=(envelope='double " single \' `tick` $VAR ✓\nline2'):SubmitRequest=>({target:{harness:'codex',sessionId:thread},messageId:'m-test',recipient:'astra',attempt:1,envelope});
async function fixture(t:TestContext,mode='ok'){
 const root=await mkdtemp(path.join(tmpdir(),'room-codex adapter '));t.after(()=>rm(root,{recursive:true,force:true}));
 const script=path.join(root,'fake codex.mjs'),capture=path.join(root,'argv.json');
 await writeFile(script,`import fs from 'node:fs';const args=process.argv.slice(2);fs.writeFileSync(process.env.CAPTURE,JSON.stringify(args));const mode=process.env.MODE;
 if(mode==='timeout')await new Promise(r=>setTimeout(r,2000));
 if(mode==='deleted'){console.error('thread was deleted');process.exit(1);}
 if(mode==='usage'){console.error('Usage: codex queue');process.exit(2);}
 if(mode==='failure'){console.error('unexpected internal failure');process.exit(1);}
 if(mode==='wrong')console.log('Queued message ${queue} for thread 00000000-0000-4000-8000-000000000002.');
 else if(mode!=='silent')console.log('Queued message ${queue} for thread '+args[args.indexOf('--thread')+1]+'.');`);
 const options:CodexOptions={executable:process.execPath,cwd:root,prefixArgs:[script],env:{...process.env,CAPTURE:capture,MODE:mode},timeoutMs:mode==='timeout'?50:3000,maxEnvelopeChars:24000,commandLineBudget:30000,maxOutputBytes:65536};
 return{root,capture,options,adapter:new CodexAdapter(options)};
}
test('native argv transports quotes/newlines/Unicode exactly and captures matching receipt',async t=>{
 const{adapter,capture}=await fixture(t);const req=request();
 assert.deepEqual(await adapter.submit(req),{status:'submitted',evidence:{kind:'codex-queue',nativeId:queue}});
 assert.deepEqual(JSON.parse(await readFile(capture,'utf8')),['queue','--thread',thread,'--message',req.envelope]);
 assert.equal((await adapter.probe(req.target)).liveness,'unknown');
});
test('timeout, unknown failure and absent/wrong receipts are uncertain, never silently retried',async t=>{
 for(const mode of ['timeout','failure','silent','wrong']){const{adapter}=await fixture(t,mode);assert.equal((await adapter.submit(request())).status,'uncertain',mode);}
});
test('positive CLI rejection maps to failed or held rebind-needed',async t=>{
 const gone=await fixture(t,'deleted');assert.deepEqual(await gone.adapter.submit(request()),{status:'unavailable',reason:'rebind_needed',detail:'Codex rejected the original thread identity as missing, deleted or archived. Verify its configured home and rebind explicitly.'});
 const usage=await fixture(t,'usage');const result=await usage.adapter.submit(request());assert.equal(result.status,'failed');
});
test('bad native identity, NUL, shell wrapper and missing executable fail before spawning',async t=>{
 const f=await fixture(t);assert.equal((await f.adapter.submit({...request(),target:{harness:'codex',sessionId:'friendly-name'}})).status,'failed');
 assert.equal((await f.adapter.submit(request('a\0b'))).status,'failed');
 const missing=new CodexAdapter({...f.options,executable:path.join(f.root,'missing.exe')});assert.equal((await missing.submit(request())).status,'failed');
 if(process.platform==='win32')assert.equal(resolveCodexExecutable('codex.cmd',f.root,{PATH:f.root}),null);
 await assert.rejects(readFile(f.capture),{code:'ENOENT'});
});
test('Windows command quoting accounts for embedded quotes and trailing backslashes',()=>{
 assert.equal(quoteWindowsArgument('plain'),'plain');assert.equal(quoteWindowsArgument('a b'),'"a b"');
 assert.equal(quoteWindowsArgument('a"b'),'"a\\"b"');assert.equal(quoteWindowsArgument('a b\\'),'"a b\\\\"');
 assert.equal(windowsCommandLineLength('x',['a b']),8);
});
test('effective envelope cap fits worst-case quoted text and reference fallback retains original body',async t=>{
 const{adapter,options,root}=await fixture(t);const message={id:'m-long',seq:1,createdAt:'now',from:{name:'human',kind:'human' as const,identity:{mode:'human' as const,source:'tui' as const}},to:['astra'],addressing:'direct' as const,replyTo:null,kind:'chat' as const,body:'"\\'.repeat(24000),clientMessageId:null};
 const envelope=buildEnvelope(root,message,'astra',adapter.maxEnvelopeChars);
 assert.equal(envelope.referenced,true);assert.ok(envelope.text.length<=adapter.maxEnvelopeChars);
 assert.ok(windowsCommandLineLength(adapter.executable!,[...options.prefixArgs!,'queue','--thread',thread,'--message',envelope.text])<=30000);
 assert.equal((await adapter.submit(request(envelope.text))).status,'submitted');assert.equal(message.body.length,48000);
});
