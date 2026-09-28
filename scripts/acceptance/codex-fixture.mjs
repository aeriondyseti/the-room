// Disposable daemon-hosted Codex fixture. Not the product's parked background-hosting feature.
import fs from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import path from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {parse} from 'smol-toml';
import {ProbeClient} from './codex-client.mjs';

export async function start({name,root,dist}) {
  root=await fs.realpath(root);
  // Owned-root guard: a vpfix-* directory under the OS temp dir or under the explicitly configured fixture base
  // (VP_FIXTURE_BASE; shared rooms live there because `claude --bg` needs a pre-trusted, non-git location).
  const bases=[await fs.realpath(tmpdir())];
  if(process.env.VP_FIXTURE_BASE)bases.push(await fs.realpath(process.env.VP_FIXTURE_BASE));
  const under=b=>{const rel=path.relative(b,root);return rel&&!rel.startsWith('..')&&!path.isAbsolute(rel);};
  if(!path.basename(root).startsWith('vpfix-')||!bases.some(under))throw Error('Codex fixtures require a vpfix-* directory under the OS temp directory or VP_FIXTURE_BASE.');
  if(!/^[a-z][a-z0-9_-]{0,31}$/.test(name))throw Error('Invalid fixture name.');
  const home=process.env.CODEX_HOME||path.join(homedir(),'.codex');
  const {resolveCodexExecutable}=await import(pathToFileURL(path.resolve(path.dirname(dist),'../adapters/codex/adapter.js')).href);
  const {RoomClient}=await import(pathToFileURL(path.resolve(path.dirname(dist),'../ipc/client.js')).href);
  const executable=resolveCodexExecutable(process.env.ROOM_CODEX_EXECUTABLE??null,root);
  if(!executable)throw Error('Native Codex executable unavailable.');
  const evidence=path.join(root,`${name}-codex-events.jsonl`);
  const log=(kind,data)=>appendFileSync(evidence,JSON.stringify({at:Date.now(),kind,...data})+'\n');
  const client=await new ProbeClient({executable,socketPath:path.join(home,'app-server-control','app-server-control.sock'),log}).connect();
  let sessionId;let rollout;let room;let stopped=false;
  async function stop(){
    if(stopped)return;stopped=true;
    try {
      if(sessionId){
        const read=await client.rpc('thread/read',{threadId:sessionId,includeTurns:true});
        const active=read.thread?.turns?.find(t=>t.status==='inProgress');
        if(active)await client.rpc('turn/interrupt',{threadId:sessionId,turnId:active.id});
        if(rollout)await fs.copyFile(rollout,path.join(root,`${name}-rollout.jsonl`)).catch(()=>{});
        await client.rpc('thread/delete',{threadId:sessionId});
        log('cleanup',{sessionId,deleted:true});
      }
    }finally{room?.close();client.close();}
  }
  try {
    // Disable unrelated user MCP servers in this thread's configuration only; no user config writes.
    let user={};try{user=parse(await fs.readFile(path.join(home,'config.toml'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    const config={model_reasoning_effort:'low'};
    for(const server of Object.keys(user.mcp_servers??{}))config[`mcp_servers.${server}.enabled`]=false;
    // Kevin explicitly approved these four room tools in newly created disposable fixtures only.
    // This is a thread/start override: no user config writes, no approval changes for shell or other tools.
    const roomTools=['room_send','room_read','room_who','room_join'];
    config['mcp_servers.room']={command:process.execPath,args:[dist,'mcp'],env:{ROOM_ROOT:root},enabled:true,
      enabled_tools:roomTools,default_tools_approval_mode:'prompt',
      tools:Object.fromEntries(roomTools.map(tool=>[tool,{approval_mode:'approve'}]))};
    const created=await client.rpc('thread/start',{
      cwd:root,model:process.env.ROOM_ACCEPTANCE_CODEX_MODEL??'gpt-6-luna',sandbox:'read-only',approvalPolicy:'never',config,
      developerInstructions:`You are disposable room qualification participant ${name}. Use only the room MCP tools. Never use shell/file/network tools, access other repositories, modify global configuration or spawn agents. First call room_join with name ${name}. If an incoming room message body starts with "RELAY <name>", call room_send once with to equal that name and text "relay ping" (no reply_to) instead of replying to the sender. For each other incoming room trial message, call room_send with to equal its sender, reply_to equal its message id and text ACK. If it is already an ACK, do not reply (avoid loops). For oversized referenced content, room_read the referenced id first. Do not poll or wait for messages. Native queue starts later turns. Finish each turn after the required MCP call.`,
    });
    sessionId=created.thread.id;rollout=created.thread.path;client.owned.add(sessionId);
    await fs.writeFile(path.join(root,`${name}-codex-manifest.json`),JSON.stringify({sessionId,rollout,model:created.model,configuration:'daemon-hosted/read-only/MCP-only'},null,2));
    const since=Date.now();
    await client.rpc('turn/start',{threadId:sessionId,input:[{type:'text',text:`Join this fixture room as ${name} using room_join now. Do not send a greeting.`}]});
    room=await RoomClient.connect(root,{client:'cli'});
    const deadline=Date.now()+90000;
    for(;;){
      const registered=(await room.request('who',{})).participants.find(p=>p.name===name&&p.sessionId===sessionId);
      const complete=client.events.some(e=>e.at>=since&&e.msg.method==='turn/completed'&&e.msg.params.threadId===sessionId);
      if(registered&&complete)break;
      if(Date.now()>deadline)throw Error(`Codex fixture ${name} did not join/finish; inspect ${evidence}`);
      await new Promise(r=>setTimeout(r,100));
    }
    return {
      name,harness:'codex',sessionId,stop,
      /** 'idle' unless this thread's latest turn event is a start without a completion. */
      status(){const last=client.events.filter(e=>(e.msg.params?.threadId??e.msg.params?.turn?.threadId)===sessionId).at(-1);return !last||last.msg.method==='turn/completed'?'idle':'busy';},
      async turnStartedAt(messageId,sinceMs){
        if(!rollout){const read=await client.rpc('thread/read',{threadId:sessionId});rollout=read.thread?.path;}
        if(!rollout)return null;
        const text=await fs.readFile(rollout,'utf8');let started=null;
        for(const line of text.split('\n')){let row;try{row=JSON.parse(line);}catch{continue;}
          const at=Date.parse(row.timestamp);if(at<sinceMs)continue;
          if(row.type==='event_msg'&&row.payload?.type==='task_started')started=at;
          if(row.type==='event_msg'&&row.payload?.type==='user_message'&&String(row.payload.message).includes(messageId))return started??at;
          if(row.type==='response_item'&&row.payload?.type==='message'&&row.payload.role==='user'&&JSON.stringify(row.payload.content).includes(messageId))return started??at;
        }return null;
      },
    };
  }catch(error){await stop().catch(cleanup=>log('cleanup-error',{message:cleanup.message}));throw error;}
}
