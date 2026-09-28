import { connect, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { FrameDecoder, encodeFrame, PROTOCOL_VERSION, type ClientKind, type Frame, type Method, type Params, type Result, type RoomEvent } from '../contracts/ipc.js';
import { RoomError, fromErrorInfo } from '../contracts/errors.js';
import { loadConfig } from '../core/config.js';
import { VERSION } from '../version.js';
import { endpointFor } from './endpoint.js';

export interface ConnectOptions {client:ClientKind;autoStart?:boolean;timeoutMs?:number}
export class RoomClient {
  private pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  private listeners=new Set<(event:RoomEvent)=>void>();
  private constructor(private socket:Socket,private timeoutMs:number) {
    socket.setEncoding('utf8');const decoder=new FrameDecoder();
    socket.on('data',(data:string)=>{
      try {for(const frame of decoder.push(data)){
        if(frame.type==='event'){for(const listener of this.listeners)listener(frame.event);}
        else if(frame.type==='response'){
          const waiter=this.pending.get(frame.id);if(!waiter)continue;
          clearTimeout(waiter.timer);this.pending.delete(frame.id);
          if(frame.ok)waiter.resolve(frame.result);else waiter.reject(fromErrorInfo(frame.error));
        } else throw new Error('Unexpected server request.');
      }}catch(error){this.fail(new RoomError('service_unavailable',`Invalid service response: ${(error as Error).message}`));socket.destroy();}
    });
    socket.on('error',()=>this.fail(new RoomError('service_unavailable','Connection to room service failed.')));
    socket.on('close',()=>this.fail(new RoomError('service_unavailable','Connection to room service closed.')));
  }
  private fail(error:Error):void{for(const waiter of this.pending.values()){clearTimeout(waiter.timer);waiter.reject(error);}this.pending.clear();}
  static async connect(root:string,options:ConnectOptions):Promise<RoomClient>{
    root=await realpath(root);
    if(options.autoStart!==false)await ensureService(root);
    const client=await this.open(root,options.timeoutMs??loadConfig().ipcRequestTimeoutMs);
    try{await client.request('hello',{client:options.client,clientVersion:VERSION,protocolVersion:PROTOCOL_VERSION});return client;}
    catch(error){client.close();throw error;}
  }
  private static open(root:string,timeoutMs:number):Promise<RoomClient>{
    return new Promise((resolve,reject)=>{
      const socket=connect(endpointFor(root));
      const timer=setTimeout(()=>{socket.destroy();reject(new RoomError('service_unavailable','Timed out connecting to room service.'));},timeoutMs);
      socket.once('error',error=>{clearTimeout(timer);reject(error);});
      socket.once('connect',()=>{clearTimeout(timer);resolve(new RoomClient(socket,timeoutMs));});
    });
  }
  request<M extends Method>(method:M,params:Params<M>):Promise<Result<M>>{
    if(this.socket.destroyed)return Promise.reject(new RoomError('service_unavailable','Room client is closed.'));
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new RoomError('service_unavailable','Request timed out; preserve client_message_id when retrying a send.'));},this.timeoutMs);
      this.pending.set(id,{resolve:value=>resolve(value as Result<M>),reject,timer});
      try{this.socket.write(encodeFrame({v:1,type:'request',id,method,params} as Frame));}
      catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  onEvent(listener:(event:RoomEvent)=>void):()=>void{this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  close():void{this.fail(new RoomError('service_unavailable','Room client closed.'));this.socket.destroy();}
}

const starting=new Map<string,Promise<void>>();
export async function ensureService(root:string):Promise<void>{
  const key=endpointFor(root);const previous=starting.get(key);if(previous)return previous;
  const task=(async()=>{
    const deadline=Date.now()+loadConfig().serviceStartTimeoutMs;
    const probe=async()=>{const client=await RoomClient.connect(root,{client:'cli',autoStart:false,timeoutMs:Math.max(1,deadline-Date.now())});client.close();};
    try{await probe();return;}catch(error){if(error instanceof RoomError && error.code==='unsupported_version')throw error;}
    const child=spawn(process.execPath,[fileURLToPath(new URL('../core/service/main.js',import.meta.url)),root],{detached:true,windowsHide:true,stdio:'ignore'});
    let spawnError:Error|undefined;child.on('error',error=>{spawnError=error;});child.unref();
    do {
      if(spawnError)throw new RoomError('service_unavailable',`Could not start room service: ${spawnError.message}`);
      try{await probe();return;}catch(error){if(error instanceof RoomError && error.code==='unsupported_version')throw error;}
      await new Promise(resolve=>setTimeout(resolve,loadConfig().servicePollMs));
    }while(Date.now()<deadline);
    throw new RoomError('service_unavailable','Room service did not become ready before the startup deadline.');
  })();
  starting.set(key,task);try{await task;}finally{starting.delete(key);}
}
