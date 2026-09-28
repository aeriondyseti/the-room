import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger,type EnqueueInput} from './ledger.js';
const input:EnqueueInput={sender:{name:'a',kind:'agent',identity:{mode:'verified',source:'codex-env'}},senderScope:'codex:one',body:'pending',requestedRecipients:['b'],recipients:[{name:'b',target:{harness:'codex',sessionId:'two'}}],addressing:'direct',clientMessageId:'same'};

test('version1 deliveries migrate atomically; withdrawal survives reopen and preserves dedup',t=>{
 const root=mkdtempSync(join(tmpdir(),'vp-withdraw-'));let ledger=new Ledger(root);const saved=ledger.enqueue(input);const file=ledger.file;ledger.close();
 const old=new DatabaseSync(file);old.exec(`BEGIN;
 ALTER TABLE deliveries RENAME TO deliveries_new;
 CREATE TABLE deliveries(message_id TEXT NOT NULL REFERENCES messages(id),recipient TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('queued','submitted','replied','failed','uncertain')),held INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(message_id,recipient));
 INSERT INTO deliveries SELECT * FROM deliveries_new;DROP TABLE deliveries_new;PRAGMA user_version=1;COMMIT;`);old.close();
 ledger=new Ledger(root);t.after(()=>{ledger.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
 assert.equal(ledger.withdraw('codex:one',saved.message.id).recipients[0]?.disposition,'withdrawn');
 const original=ledger.delivery(saved.message.id,'b');assert.ok(original.withdrawnAt);
 ledger.close();ledger=new Ledger(root);assert.deepEqual(ledger.delivery(saved.message.id,'b'),original);
 const retry=ledger.enqueue(input);assert.equal(retry.deduplicated,true);assert.equal(retry.deliveries[0]?.state,'withdrawn');assert.equal(ledger.queued().length,0);
 assert.throws(()=>ledger.withdraw('codex:different',saved.message.id),{code:'identity_mismatch'});
});

test('withdraw treats historical uncertain attempts conservatively and selected recipients atomically',t=>{
 const root=mkdtempSync(join(tmpdir(),'vp-withdraw-'));const ledger=new Ledger(root);t.after(()=>{ledger.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
 const saved=ledger.enqueue(input);const now=new Date().toISOString();
 ledger.updateDelivery(saved.message.id,'b',d=>{d.state='failed';d.attempts.push({n:1,startedAt:now,finishedAt:now,outcome:'uncertain',evidence:null,error:null},{n:2,startedAt:now,finishedAt:now,outcome:'failed',evidence:null,error:null});});
 assert.equal(ledger.withdraw('codex:one',saved.message.id).recipients[0]?.disposition,'uncertain');
 assert.equal(ledger.delivery(saved.message.id,'b').state,'failed');
 assert.throws(()=>ledger.withdraw('codex:one',saved.message.id,['b','not-original']),{code:'bad_request'});
});
