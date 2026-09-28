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
test('outside separator occupies the final full cell row or column, including narrow fallback',async()=>{
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
   const bottom=layout==='left'&&width>=90;
   const mark=mono?'\x1b[7m':'\x1b[46m';
   if(bottom){assert.ok(lines.at(-1)!.includes(mark));assert.equal(plain(lines.at(-1)!), ' '.repeat(width));}
   else for(const line of lines){assert.ok(line.includes(mark),JSON.stringify(line));assert.equal(cols(plain(line)),width,JSON.stringify(line));assert.match(line,new RegExp(mono?'\\x1b\\[7m \\x1b\\[27m$':'\\x1b\\[46m \\x1b\\[49m$'));}
  };
  check();ui.stdin.write('/help');await tick();ui.stdin.write('\r');await tick();check();
  ui.stdin.write('\x1b');await tick();ui.stdin.write('long draft '.repeat(100));await tick();check();
  ui.unmount();
 }
});


