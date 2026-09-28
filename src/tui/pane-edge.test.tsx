import './force-color.js';
import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {render, cleanup} from 'ink-testing-library';
import {App} from './app.js';
import {demoSource} from './demo.js';
import {MONO_THEME} from './theme.js';
import {cols} from './format.js';
afterEach(cleanup);
const tick=()=>new Promise(r=>setTimeout(r,60));
const plain=(s:string)=>s.replace(/\x1b\[[0-9;]*m/g,'');
test('outer divider is absent in both layouts and narrow fallback',async()=>{
 for(const [layout,width,mono] of [['left',120,false],['top',120,false],['left',80,false],['top',100,true]] as const){
  const source=demoSource();
  const ui=render(<App humanName="Kevin" source={source} layout={layout} width={width} height={30} theme={mono?MONO_THEME:undefined}/>);
  Object.defineProperty(ui.stdout, "columns", {get:()=>width});
  ui.rerender(<App humanName="Kevin" source={source} layout={layout} width={width} height={30} theme={mono?MONO_THEME:undefined}/>);
  await tick();
  const check=()=>{
   const lines=ui.lastFrame()!.split('\n');
   assert.equal(lines.length,30);
   assert.ok(lines.every(l=>cols(plain(l))<=width));
   assert.ok(!lines.some(l=>l.includes('\x1b[46m')), 'no cyan divider background');
   assert.ok(plain(lines.at(-1)!).trim().length>0, 'status retains the bottom row');
  };
  check();ui.stdin.write('/help');await tick();ui.stdin.write('\r');await tick();check();
  ui.stdin.write('\x1b');await tick();ui.stdin.write('long draft '.repeat(100));await tick();check();
  ui.unmount();
 }
});


