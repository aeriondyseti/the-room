import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CodexAccountProvider,type CodexAccountOptions} from './codex-account.js';
const time=Date.parse('2026-09-28T15:00:00Z');
const options:CodexAccountOptions={executable:'codex.exe',cwd:process.cwd(),home:process.cwd(),timeoutMs:100,maxBytes:65536,now:()=>time};
const weekly={usedPercent:16,windowDurationMins:10080,resetsAt:1791058177};
const short={usedPercent:7,windowDurationMins:300,resetsAt:1790608177};
const provider=(value:unknown)=>new CodexAccountProvider({...options,read:async()=>({ok:true,value})});

test('Codex account source preserves reported durations, deduplicates mirror and pins missing 5h honestly',async()=>{
 const snapshot={limitId:'codex',primary:weekly,secondary:null,planType:'pro'};
 const r=await provider({accountId:'account-secret-id',ordinaryUsageAllowed:false,rateLimits:snapshot,rateLimitsByLimitId:{codex:snapshot}}).sample();
 assert.equal(r.status,'ok');assert.equal(r.buckets.length,1);assert.equal(r.account.scope,'account');
 assert.doesNotMatch(JSON.stringify(r),/account-secret-id/);assert.equal(r.ordinaryUsageAllowed,false,'permission is independent of low usage');
 const week=r.buckets[0]!.windows.find(w=>w.durationMinutes===10080)!;
 const five=r.buckets[0]!.windows.find(w=>w.durationMinutes===300)!;
 assert.equal(week.kind,'primary');assert.equal(week.usedPercent,16);assert.equal(five.usedPercent,null);
 assert.match(five.reason!,/no 5h/);assert.equal(five.resetsAt,null);assert.equal(five.observedAt,null);
 assert.equal(r.observedAt,new Date(time).toISOString());
});

test('multiple buckets remain separate; both duration orders work and percentages are not summed',async()=>{
 const r=await provider({rateLimits:{limitId:'codex',primary:weekly},rateLimitsByLimitId:{codex:{primary:short,secondary:weekly},model:{limitName:'Model quota',primary:{...weekly,usedPercent:40}}}}).sample();
 assert.equal(r.buckets.length,2);assert.equal(r.account.scope,'profile');
 assert.deepEqual(r.buckets[0]!.windows.map(w=>w.usedPercent),[7,16]);
 assert.equal(r.buckets[1]!.windows[0]!.usedPercent,40);
 assert.equal(r.ordinaryUsageAllowed,null);
});

test('account switches change account key without changing source identity; different profiles stay distinct',async()=>{
 let account='one';
 const a=new CodexAccountProvider({...options,read:async()=>({ok:true,value:{accountId:account,rateLimits:{primary:short}}})});
 const first=await a.sample();account='two';const second=await a.sample();
 assert.notEqual(first.account.key,second.account.key);assert.equal(first.account.sourceKey,second.account.sourceKey);
 const other=new CodexAccountProvider({...options,home:options.home+'/another',read:async()=>({ok:true,value:{rateLimits:{primary:short}}})});
 assert.notEqual(a.id,other.id);
 const noWindows=await provider({accountId:'different',ordinaryUsageAllowed:false,rateLimits:{}}).sample();
 assert.equal(noWindows.status,'unavailable');assert.equal(noWindows.account.scope,'account');
 assert.notEqual(noWindows.account.key,first.account.key);assert.equal(noWindows.ordinaryUsageAllowed,false);
});

test('malformed or missing values never become zero; a valid sibling window survives',async()=>{
 const r=await provider({rateLimits:{primary:{...short,usedPercent:'0'},secondary:weekly}}).sample();
 assert.equal(r.status,'ok');assert.equal(r.buckets[0]!.windows[0]!.usedPercent,null);
 for(const value of [null,{}, {rateLimits:{primary:{...weekly,usedPercent:NaN}}}, {rateLimits:{primary:{...weekly,usedPercent:101}}}]){
  const bad=await provider(value).sample();assert.equal(bad.status,'unavailable');assert.deepEqual(bad.buckets,[]);assert.equal(bad.observedAt,null);
 }
 const invalidReset=await provider({rateLimits:{primary:{...weekly,resetsAt:1e100}}}).sample();
 assert.equal(invalidReset.buckets[0]!.windows[0]!.resetsAt,null);
});

test('transport failures and absent executable return unavailable without throwing or leaking exceptions',async()=>{
 const missing=await new CodexAccountProvider({...options,executable:null,read:async()=>{throw Error('must not call');}}).sample();
 assert.equal(missing.status,'unavailable');assert.match(missing.reason!,/executable/);
 const thrown=await new CodexAccountProvider({...options,read:async()=>{throw Error('secret-token-in-error');}}).sample();
 assert.equal(thrown.status,'unavailable');assert.doesNotMatch(JSON.stringify(thrown),/secret-token-in-error/);
 assert.equal(thrown.checkedAt,new Date(time).toISOString());assert.equal(thrown.observedAt,null);
 const denied=await new CodexAccountProvider({...options,read:async()=>({ok:false,reason:'Usage read timed out.'})}).sample();
 assert.equal(denied.status,'unavailable');assert.match(denied.reason!,/timed out/);
});
