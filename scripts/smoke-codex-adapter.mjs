#!/usr/bin/env node
// Live adapter smoke: target only an explicitly chosen throwaway thread. No automatic retry.
import { CodexAdapter,codexOptionsFrom } from '../dist/adapters/codex/index.js';
import { loadConfig } from '../dist/core/config.js';
const [sessionId]=process.argv.slice(2);
if(!sessionId){console.error('Usage: node scripts/smoke-codex-adapter.mjs <throwaway-thread-uuid>');process.exit(2);}
const adapter=new CodexAdapter(codexOptionsFrom(loadConfig(),process.cwd()));
const tag=`CODEX-ADAPTER-${Date.now().toString(36)}`;
const started=Date.now();const result=await adapter.submit({target:{harness:'codex',sessionId},messageId:tag,recipient:'smoke',attempt:1,envelope:`[roundtable smoke ${tag}] Adapter qualification message. Reply exactly ${tag}. Do not use tools.`});
console.log(JSON.stringify({tag,executable:adapter.executable,effectiveEnvelopeChars:adapter.maxEnvelopeChars,elapsedMs:Date.now()-started,result}));
process.exitCode=result.status==='submitted'?0:1;
