import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {start} from './codex-fixture.mjs';
const dist=path.resolve(process.argv[2]??'dist/cli/main.js');
const {RoomClient}=await import(pathToFileURL(path.resolve(path.dirname(dist),'../ipc/client.js')).href);
const root=await fs.mkdtemp(path.join(tmpdir(),'vpfix-codex-wake-'));
console.log(JSON.stringify({root}));
let fixture,room;
try{
 fixture=await start({name:'codex_trial',root,dist});
 room=await RoomClient.connect(root,{client:'tui'});
 const sent=await room.request('send',{caller:{kind:'human'},to:['codex_trial'],body:'QUALIFICATION TRIAL: reply ACK through roundtable_send to human with this message id as reply_to.'});
 const deadline=Date.now()+90000;let reply;
 while(Date.now()<deadline){reply=(await room.request('read',{afterSeq:sent.message.seq})).items.find(x=>x.message.replyTo===sent.message.id);if(reply)break;await new Promise(r=>setTimeout(r,100));}
 const turnStartedAt=await fixture.turnStartedAt(sent.message.id,Date.parse(sent.message.createdAt));
 const result={sessionId:fixture.sessionId,sentId:sent.message.id,createdAt:sent.message.createdAt,turnStartedAt,reply:reply?.message,delivery:(await room.request('deliveries',{messageId:sent.message.id})).deliveries[0]};
 await fs.writeFile(path.join(root,'smoke-results.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));if(!reply||!turnStartedAt)process.exitCode=1;
}finally{
 try{await fixture?.stop();}finally{
  room??=await RoomClient.connect(root,{client:'cli',autoStart:false}).catch(()=>null);
  if(room){try{await room.request('shutdown',{caller:{kind:'human'}});}finally{room.close();}}
 }
}
