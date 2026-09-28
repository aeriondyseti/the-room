import type { DeliveryAdapter } from '../contracts/adapter.js';
import { createServer, type Socket } from 'node:net';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { FrameDecoder, FrameError, encodeFrame, MAX_FRAME_BYTES, PROTOCOL_VERSION, type ClientKind, type Frame, type RequestFrame, type RoomEvent } from '../contracts/ipc.js';
import { RoomError, toErrorInfo } from '../contracts/errors.js';
import { RoomService } from '../core/service/service.js';
import type { MonitorDeps } from '../core/service/monitor.js';
import type { ActivityReader } from '../observer/activity-reader.js';
import type { AccountUsageProvider } from '../contracts/account.js';
import { integer, record } from '../core/service/validation.js';
import { loadConfig } from '../core/config.js';
import { VERSION } from '../version.js';
import { endpointFor } from './endpoint.js';

export interface RunningServer { service:RoomService; pid:number; close():Promise<void> }
export async function startServer(root:string, options:{beforeReady?:()=>Promise<void>;/** Runs once the service has closed (ledger closed, lock and endpoint released), with the lock-cleanup error if any. */onClosed?:(cleanupError?:unknown)=>void;adapters?:DeliveryAdapter[];monitor?:{observer:MonitorDeps['observer'];intervalMs:number;workspace?:MonitorDeps['workspace'];stopGraceMs?:number};activity?:{reader:ActivityReader;intervalMs:number};accounts?:{providers:AccountUsageProvider[];intervalMs:number;staleAfterMs:number;stopGraceMs?:number}} = {}):Promise<RunningServer> {
  await mkdir(path.join(root,'.room'),{recursive:true});
  const endpoint=endpointFor(root);const nonce=randomUUID();const lock=path.join(root,'.room','service.lock');
  const sockets=new Set<Socket>();const active=new Set<Promise<unknown>>();const subscribed=new Set<Socket>();const replaying=new Map<Socket,RoomEvent[]>();let service:RoomService;let closing:Promise<void>|null=null;let stopping=false;let startupError:unknown;let signalReady!:()=>void;const ready=new Promise<void>(resolve=>{signalReady=resolve;});
  const send=(socket:Socket,frame:Frame)=>{
    if(socket.destroyed)return;
    const data=encodeFrame(frame);
    if(Buffer.byteLength(data)>MAX_FRAME_BYTES)throw new RoomError('message_too_large','Response exceeds the IPC frame budget; request a smaller page.');
    if(socket.writableLength+Buffer.byteLength(data)>MAX_FRAME_BYTES*2){socket.destroy();return;}
    socket.write(data);
  };
  const event=(socket:Socket,value:RoomEvent)=>{try{send(socket,{v:1,type:'event',event:value});}catch{socket.destroy();}};
  const server=createServer(socket=>{
    sockets.add(socket);socket.setEncoding('utf8');const decoder=new FrameDecoder();let client:ClientKind|null=null;let serial=Promise.resolve();
    socket.on('error',()=>{});socket.on('close',()=>{sockets.delete(socket);subscribed.delete(socket);replaying.delete(socket);});
    const process=async(frame:Frame)=>{
      if(frame.type!=='request'){socket.destroy();return;}
      try {
        await ready;if(startupError)throw startupError;
        if(stopping)throw new RoomError('service_unavailable','Room service is shutting down.');
        const p=record(frame.params);let result:unknown;
        if(frame.method==='hello') {
          if(client!==null)throw new RoomError('invalid_state','Connection already initialized.');
          if(p.protocolVersion!==PROTOCOL_VERSION)throw new RoomError('unsupported_version','Client protocol version is unsupported.');
          if(!['tui','cli','mcp'].includes(String(p.client))||typeof p.clientVersion!=='string')throw new RoomError('bad_request','Invalid hello parameters.');
          client=p.client as ClientKind;result={serviceVersion:VERSION,protocolVersion:PROTOCOL_VERSION,roomRoot:root,pid:globalThis.process.pid};
        } else {
          if(client===null)throw new RoomError('invalid_state','Send hello before room requests.');
          if(frame.method==='subscribe') {
            if(subscribed.has(socket))throw new RoomError('invalid_state','Connection is already subscribed.');
            let cursor=integer(p.afterSeq,'afterSeq',0);
            const cutoff=service.ledger.list(null,1).lastSeq;
            const buffered:RoomEvent[]=[];replaying.set(socket,buffered);
            const replay=async(value:RoomEvent)=>{
              event(socket,value);
              if(socket.destroyed)throw new RoomError('service_unavailable','Subscriber disconnected during replay.');
              if(socket.writableNeedDrain)await new Promise<void>((resolve,reject)=>{
                const closed=()=>{socket.removeListener('drain',drained);reject(new RoomError('service_unavailable','Subscriber closed during replay.'));};
                const drained=()=>{socket.removeListener('close',closed);resolve();};
                socket.once('close',closed);socket.once('drain',drained);
              });
            };
            try {
              while(cursor<cutoff&&!socket.destroyed){
                const page=service.ledger.list(cursor,loadConfig().readPageSize);
                if(!page.items.length)break;
                for(const item of page.items){if(item.message.seq>cutoff)break;await replay({type:'message.created',...item});cursor=item.message.seq;}
              }
              while(buffered.length&&!socket.destroyed){const next=buffered.shift()!;await replay(next);if(next.type==='message.created')cursor=Math.max(cursor,next.message.seq);}
              subscribed.add(socket);result={subscribed:true,lastSeq:Math.max(cursor,cutoff)};
            }finally{replaying.delete(socket);}
          } else {const operation=service.handle(frame as RequestFrame,client);active.add(operation);try{result=await operation;}finally{active.delete(operation);}}
        }
        send(socket,{v:1,type:'response',id:frame.id,ok:true,result} as Frame);
        if(frame.method==='shutdown')setImmediate(()=>{void close();});
      } catch(error) {send(socket,{v:1,type:'response',id:frame.id,ok:false,error:toErrorInfo(error)});}
    };
    socket.on('data',(data:string)=>{
      let frames:Frame[];
      try {frames=decoder.push(data);} catch(error) {
        if(error instanceof FrameError) {
          for(const frame of error.frames)serial=serial.then(()=>process(frame));
          serial=serial.then(()=>{
            if(error.requestId)send(socket,{v:1,type:'response',id:error.requestId,ok:false,error:new RoomError(error.kind==='unsupported_version'?'unsupported_version':'bad_request',error.message).toInfo()});
            socket.end();
          });
        } else socket.destroy();
        return;
      }
      for(const frame of frames)serial=serial.then(()=>process(frame));
      serial=serial.catch(()=>{socket.destroy();});
    });
  });
  // A successful exclusive OS bind is the lock. Acquire it before opening the writable database.
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,()=>{server.removeListener('error',reject);resolve();});});
  const close=():Promise<void>=>{
    if(closing)return closing;
    stopping=true;
    closing=(async()=>{
      for(const socket of subscribed)event(socket,{type:'service.stopping',reason:'shutdown'});
      // Keep the endpoint bound while old operations/storage still exist. New hello calls are refused.
      await Promise.allSettled(active);
      for(const socket of sockets)socket.destroySoon();
      await service?.close();
      let cleanupError:unknown;
      try {const owner=JSON.parse(await readFile(lock,'utf8')) as {nonce?:string};if(owner.nonce===nonce)await unlink(lock);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')cleanupError=error;}
      await new Promise<void>(resolve=>{server.close(()=>resolve());for(const socket of sockets)socket.destroy();});
      options.onClosed?.(cleanupError);
      if(cleanupError)throw cleanupError;
    })();return closing;
  };
  try {
    service=new RoomService(root,options.adapters);
    if(options.monitor)service.enableMonitor(options.monitor.observer,options.monitor.intervalMs,options.monitor.workspace,options.monitor.stopGraceMs);
    if(options.activity)service.enableActivity(options.activity.reader,options.activity.intervalMs);
    if(options.accounts)service.enableAccounts(options.accounts.providers,options.accounts.intervalMs,options.accounts.staleAfterMs,options.accounts.stopGraceMs);
    await options.beforeReady?.();
    await writeFile(lock,JSON.stringify({pid:process.pid,nonce,endpoint,startedAt:new Date().toISOString()}));
    service.onEvent(value=>{
      for(const [socket,buffer] of replaying){
        buffer.push(value);
        if(Buffer.byteLength(JSON.stringify(buffer))>MAX_FRAME_BYTES*2)socket.destroy();
      }
      for(const socket of subscribed)event(socket,value);
    });
    service.start();signalReady();
  }catch(error){startupError=error;signalReady();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));await service!?.close();throw error;}
  server.on('error',()=>{void close();});
  return {service,pid:process.pid,close};
}
