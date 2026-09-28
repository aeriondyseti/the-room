import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from './ledger.js';
import {InboxStore} from './inbox.js';

test('inbox coverage has holes, survives restart, and is isolated by room and binding',t=>{
  const root=mkdtempSync(join(tmpdir(),'vp-inbox-'));let ledger=new Ledger(root);
  t.after(()=>{ledger.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const post=(body:string)=>ledger.enqueue({sender:{name:'human',kind:'human',identity:{mode:'human',source:'tui'}},senderScope:'human',body,requestedRecipients:['a'],recipients:[{name:'a',target:{harness:'codex',sessionId:'one'}}],addressing:'direct'});
  const a=post('old'),b=post('new');let store=new InboxStore(ledger);
  const token=store.envelopeToken('codex:one',b.message.id);
  assert.equal(store.uncovered('codex:one',token),1);
  assert.equal(store.uncovered('codex:two',token),null);
  const page=store.review('codex:one',{snapshot:token});
  assert.equal(page.items.length,1);assert.equal(page.items[0]?.kind,'full_message');
  if(page.items[0]?.kind==='full_message')assert.equal(page.items[0].value.message.id,a.message.id);
  assert.equal(page.remaining,0);assert.ok(page.snapshot.length<=40);
  ledger.close();ledger=new Ledger(root);store=new InboxStore(ledger);
  assert.equal(store.uncovered('codex:one',page.snapshot),0);
  post('arrived later');assert.equal(store.uncovered('codex:one',page.snapshot),1);
  const otherRoot=mkdtempSync(join(tmpdir(),'vp-inbox-other-'));const other=new Ledger(otherRoot);
  try{assert.equal(new InboxStore(other).uncovered('codex:one',page.snapshot),null);}finally{other.close();rmSync(otherRoot,{recursive:true,force:true,maxRetries:10});}
});

test('oversized Unicode bodies need every part; continuation is snapshot-bound; baseline is explicit exemption',t=>{
  const root=mkdtempSync(join(tmpdir(),'vp-inbox-'));const ledger=new Ledger(root);
  t.after(()=>{ledger.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const body='😀\n"\\'.repeat(12000);
  ledger.enqueue({sender:{name:'human',kind:'human',identity:{mode:'human',source:'tui'}},senderScope:'human',body,requestedRecipients:['a'],recipients:[{name:'a',target:{harness:'codex',sessionId:'one'}}],addressing:'direct'});
  const store=new InboxStore(ledger,8192,512);let page=store.review('codex:one',{limit:1});let reconstructed='';let count=0;
  while(true){
    for(const item of page.items){assert.equal(item.kind,'message_part');if(item.kind==='message_part'){reconstructed+=item.text;assert.equal(item.partIndex,++count);assert.ok(!item.text.includes('\ufffd'));}}
    if(!page.hasMore)break;
    assert.equal(store.uncovered('codex:one',page.snapshot),1);
    assert.throws(()=>store.review('codex:one',{cursor:page.nextCursor!}),/does not match/);
    page=store.review('codex:one',{snapshot:page.snapshot,cursor:page.nextCursor!,limit:1});
  }
  assert.equal(reconstructed,body);assert.equal(store.uncovered('codex:one',page.snapshot),0);
  const baseline=store.review('codex:one',{baseline:{reason:'Deliberate migration of old history'}});
  assert.equal(baseline.items.length,0);assert.equal(baseline.baseline?.exemptedCount,1);
  assert.equal(store.uncovered('codex:one',baseline.snapshot),0);
  assert.throws(()=>store.review('codex:one',{snapshot:baseline.snapshot,baseline:{reason:'x'}}),/cannot be combined/);
});

test('partial coverage keeps original chunk boundaries after restart/config changes',t=>{
 const root=mkdtempSync(join(tmpdir(),'vp-inbox-'));let ledger=new Ledger(root);
 t.after(()=>{ledger.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
 const body='A'.repeat(512)+'B'.repeat(512)+'C'.repeat(8000);
 ledger.enqueue({sender:{name:'human',kind:'human',identity:{mode:'human',source:'tui'}},senderScope:'human',body,requestedRecipients:['a'],recipients:[{name:'a',target:{harness:'codex',sessionId:'one'}}],addressing:'direct'});
 let store=new InboxStore(ledger,8192,512);let page=store.review('codex:one',{limit:1});let text='';
 for(const item of page.items)if(item.kind==='message_part')text+=item.text;
 ledger.close();ledger=new Ledger(root);store=new InboxStore(ledger,8192,1024);
 while(page.hasMore){page=store.review('codex:one',{snapshot:page.snapshot,cursor:page.nextCursor!,limit:1});for(const item of page.items)if(item.kind==='message_part')text+=item.text;}
 assert.equal(text,body);assert.equal(store.uncovered('codex:one',page.snapshot),0);
});
