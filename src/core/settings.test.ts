import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RoomSettings } from './settings.js';

test('a startup file that conflicts with a valid env falls back, while an invalid env fails startup',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'room-settings-'));
 t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5}));
 const dir=path.join(root,'.roundtable');await mkdir(dir);
 const file=path.join(dir,'settings.json');
 await writeFile(file,JSON.stringify({version:1,batchMaxHoldMs:1000}));
 const settings=new RoomSettings(root,{ROUNDTABLE_DELIVERY_HOLD_MS:'1500'});
 const fallback=await settings.get();
 assert.equal(fallback.problem?.fallback,'defaults');
 assert.equal(fallback.effective.deliveryHoldMs,1500);
 assert.equal(fallback.effective.batchMaxHoldMs,2000);
 assert.deepEqual(fallback.overridden,['deliveryHoldMs']);
 const repaired=await settings.update({});
 assert.equal(repaired.problem,undefined);
 assert.equal(repaired.configured.batchMaxHoldMs,2000);
 assert.equal(JSON.parse(await readFile(file,'utf8')).batchMaxHoldMs,2000);
 assert.throws(()=>new RoomSettings(root,{ROUNDTABLE_DELIVERY_HOLD_MS:'3000'}));
});

test('bad runtime file retains good values, cold fallback uses defaults, repair backs up raw bytes',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'room-settings-'));
 t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5}));
 const settings=new RoomSettings(root,{});await settings.update({deliveryHoldMs:700});
 const dir=path.join(root,'.roundtable'),file=path.join(dir,'settings.json');
 await writeFile(file,'broken-json');
 const fallback=await settings.get();assert.equal(fallback.effective.deliveryHoldMs,700);assert.equal(fallback.problem?.fallback,'last_good');
 const cold=new RoomSettings(root,{});assert.equal((await cold.get()).problem?.fallback,'defaults');
 const repaired=await settings.update({deliveryHoldMs:600});assert.equal(repaired.problem,undefined);
 const backup=(await readdir(dir)).find(n=>n.startsWith('settings.backup.'))!;
 assert.equal(await readFile(path.join(dir,backup),'utf8'),'broken-json');
 await writeFile(file,JSON.stringify({version:2,future:true}));
 assert.equal((await settings.get()).effective.deliveryHoldMs,600);
 await assert.rejects(settings.update({}),/newer version/);
 assert.equal(JSON.parse(await readFile(file,'utf8')).version,2);
});

test('deleted companion policy can be repaired and oversized startup files do not seed fallback',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'room-settings-'));
 t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5}));
 const dir=path.join(root,'.roundtable');await mkdir(dir);
 const file=path.join(dir,'settings.json');await writeFile(file,JSON.stringify({version:1,batchMaxHoldMs:5000}));
 const settings=new RoomSettings(root,{ROUNDTABLE_DELIVERY_HOLD_MS:'3000'});
 await rm(file);assert.equal((await settings.get()).effective.deliveryHoldMs,3000);
 assert.equal((await settings.update({})).effective.batchMaxHoldMs,5000);
 await writeFile(file,JSON.stringify({version:1,deliveryHoldMs:1500,extra:'x'.repeat(1024*1024)}));
 const cold=new RoomSettings(root,{});const view=await cold.get();
 assert.equal(view.problem?.fallback,'defaults');assert.equal(view.effective.deliveryHoldMs,500);
});

test('live settings preserve unknown keys, reset saved values, and retain environment precedence',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'room-settings-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5}));
  const settings=new RoomSettings(root,{ROUNDTABLE_DELIVERY_HOLD_MS:'700'});
  assert.equal((await settings.get()).effective.deliveryHoldMs,700);
  await mkdir(path.join(root,'.roundtable'));
  const file=path.join(root,'.roundtable','settings.json');
  await writeFile(file,JSON.stringify({version:1,anotherFeature:{enabled:true}}));
  const changed=await settings.update({deliveryHoldMs:900});
  assert.equal(changed.configured.deliveryHoldMs,900);
  assert.equal(changed.effective.deliveryHoldMs,700);
  assert.deepEqual(changed.overridden,['deliveryHoldMs']);
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')).anotherFeature,{enabled:true});
  const reset=await settings.update({deliveryHoldMs:null});
  assert.equal(reset.configured.deliveryHoldMs,500);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(file,'utf8')),'deliveryHoldMs'),false);
  await writeFile(file,JSON.stringify({version:1,batchHeld:false}));
  assert.equal((await settings.get()).effective.batchHeld,false);
});

test('concurrent patches merge and invalid policies never replace the saved file',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'room-settings-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5}));
  const a=new RoomSettings(root,{}),b=new RoomSettings(root,{});
  await Promise.all([a.update({deliveryHoldMs:800}),b.update({batchHeld:false})]);
  assert.equal((await a.get()).configured.deliveryHoldMs,800);
  assert.equal((await a.get()).configured.batchHeld,false);
  await assert.rejects(a.update({batchMaxHoldMs:700}));
  await assert.rejects(a.update({deliveryHoldMs:-1}));
  await assert.rejects(a.update({deliveryHoldMs:Infinity}));
  await assert.rejects(a.update({surprise:true}));
  assert.equal((await a.get()).configured.batchMaxHoldMs,2000);
  assert.throws(()=>new RoomSettings(root,{ROUNDTABLE_DELIVERY_HOLD_MS:'2500'}));
});
