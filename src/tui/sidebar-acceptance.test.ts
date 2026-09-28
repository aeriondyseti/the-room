// Independent sidebar acceptance checks (Astra); no renderer implementation lives in this component.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {demoSource} from './demo.js';
import {sidePanelLines} from './sidepanel.js';
import {lineCols,lineText} from './format.js';

test('sidebar acceptance: bounded dimensions across narrow/wide and short/tall panes',async()=>{
  const {participants,accounts=[]}=await demoSource().request('who',{});
  for(const width of [24,30,38,48])for(const height of [8,12,18,24,32,48]) {
    const lines=sidePanelLines(participants,accounts,{width,height,stale:false,mono:false,humanName:'Kevin'});
    assert.equal(lines.length,height,`${width}x${height}: row budget`);
    assert.ok(lines.every(l=>lineCols(l)<=width),`${width}x${height}: no horizontal overflow`);
  }
});

test('sidebar acceptance: disconnected and stale readings never acquire fresh colored fill',async()=>{
  const {participants,accounts=[]}=await demoSource().request('who',{});
  for(const disconnected of [true,false]) {
    const readings=accounts.map(a=>({...a,status:'stale' as const}));
    const lines=sidePanelLines(participants,readings,{width:38,height:48,stale:disconnected,mono:false,humanName:'Kevin'});
    const text=lines.map(lineText).join('\n');
    assert.match(text,disconnected?/last known/:/stale/);
    // Restrict to account area: fresh participant context is independent of subscription freshness.
    const firstAccount=lines.findIndex(l=>/^Claude/.test(lineText(l)));
    assert.ok(firstAccount>=0);
    for(const seg of lines.slice(firstAccount).flat()) {
      if(seg.surface?.kind==='fill')assert.equal(seg.surface.color,undefined,'last-known quotas have neutral fill');
    }
  }
});

test('sidebar acceptance: more agents on one subscription never multiply account rows',async()=>{
  const {participants,accounts=[]}=await demoSource().request('who',{});
  const many=[...participants,...participants.map((p,i)=>({...p,name:`extra_${i}`,sessionId:`other-${i}`}))];
  const lines=sidePanelLines(many,accounts,{width:38,height:64,stale:false,mono:true,humanName:'Kevin'}).map(lineText);
  assert.equal(lines.filter(l=>/^Claude(?:\s|$)/.test(l)).length,1);
  assert.equal(lines.filter(l=>/^Codex(?:\s|$)/.test(l)).length,1);
  assert.ok(lines.some(l=>l.includes('—')),'unknown 5h quota remains visibly missing');
});
