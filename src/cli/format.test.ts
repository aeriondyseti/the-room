import{test}from'node:test';import assert from'node:assert/strict';
import{formatResult}from'./format.js';import{ERROR_HINTS}from'../contracts/errors.js';
const item={message:{id:'m1',seq:1,from:{name:'peer',identity:{mode:'declared',source:'declared'}},to:['human'],kind:'chat',body:'first line\nsecond "quoted" ✓\u001b[2J',replyTo:null},deliveries:[]};
test('CLI reads preserve readable multiline text and visibly neutralize terminal controls',()=>{
 const out=formatResult('read',{items:[item],hasMore:false});assert.match(out,/peer \(declared\)/);assert.match(out,/first line\nsecond "quoted" ✓/);assert.ok(!out.includes('\u001b'));assert.ok(out.includes('␛'));
});
test('CLI summaries keep declared identity and honest queued/accepted distinctions',()=>{
 const out=formatResult('send',{...item,deduplicated:false,deliveries:[{recipient:'astra',state:'submitted',held:false,waiting:null}]});
 assert.match(out,/declared/);assert.match(out,/transport acceptance/);assert.ok(!out.includes(item.message.body));
 const held=formatResult('send',{...item,deduplicated:false,deliveries:[{recipient:'astra',state:'queued',held:true,waiting:'rebind_needed'}]});assert.match(held,/rebind needed/);assert.doesNotMatch(held,/room paused/);
});
test('every agent-facing error code includes actionable remediation',()=>{
 for(const[code,hint]of Object.entries(ERROR_HINTS))assert.match(hint,/Check|Run|Register|Re-run|choose|use|move|Shorten|Address|Start|Upgrade|see|refresh|request|participant/i,code);
});
