import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RoomSettings } from './settings.js';

test('live settings preserve unknown keys, reset saved values, and retain environment precedence',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'room-settings-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5}));
  const settings=new RoomSettings(root,{ROOM_DELIVERY_HOLD_MS:'700'});
  assert.equal((await settings.get()).effective.deliveryHoldMs,700);
  await mkdir(path.join(root,'.room'));
  const file=path.join(root,'.room','settings.json');
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
  const overridden=new RoomSettings(root,{ROOM_DELIVERY_HOLD_MS:'2500'});
  await assert.rejects(overridden.get());
});
