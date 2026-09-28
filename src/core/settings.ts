import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { DeliverySettings, RoomSettingsView } from '../contracts/settings.js';
import { RoomError } from '../contracts/errors.js';
import { renameWithRetry } from './registry/registry.js';

export const DELIVERY_DEFAULTS: Readonly<DeliverySettings> = Object.freeze({deliveryHoldMs:500,batchHeld:true,batchMaxHoldMs:2000});
const envNames = {deliveryHoldMs:'ROOM_DELIVERY_HOLD_MS',batchHeld:'ROOM_BATCH_HELD',batchMaxHoldMs:'ROOM_BATCH_MAX_HOLD_MS'} as const;
const keys = Object.keys(envNames) as Array<keyof DeliverySettings>;
const isObject = (v:unknown):v is Record<string,unknown> => !!v && typeof v==='object' && !Array.isArray(v);
const code = (e:unknown) => (e as NodeJS.ErrnoException).code;
function validate(value:DeliverySettings):void {
  if(typeof value.batchHeld!=='boolean')throw new RoomError('bad_request','batchHeld must be boolean.');
  for(const key of ['deliveryHoldMs','batchMaxHoldMs'] as const)if(!Number.isSafeInteger(value[key])||value[key]<0||value[key]>60000)throw new RoomError('bad_request',`${key} must be an integer from 0 to 60000.`);
  if(value.batchMaxHoldMs<value.deliveryHoldMs)throw new RoomError('bad_request','batchMaxHoldMs must be at least deliveryHoldMs.');
}
/** File reads are live; environment is captured for this service instance. */
export class RoomSettings {
  private readonly env:NodeJS.ProcessEnv;
  constructor(private readonly root:string,env:NodeJS.ProcessEnv=process.env){this.env={...env};}
  private async document():Promise<Record<string,unknown>> {
    try {
      const raw=await readFile(path.join(this.root,'.room','settings.json'),'utf8');
      if(Buffer.byteLength(raw)>1024*1024)throw new RoomError('invalid_state','Room settings file exceeds 1 MiB.');
      const doc:unknown=JSON.parse(raw);
      if(!isObject(doc)||doc.version!==1)throw new RoomError('invalid_state','Room settings requires schema version 1.');
      return doc;
    }catch(e){if(code(e)==='ENOENT')return {version:1};if(e instanceof RoomError)throw e;throw new RoomError('invalid_state','Could not read room settings; check .room/settings.json.');}
  }
  private view(doc:Record<string,unknown>):RoomSettingsView {
    const configured={...DELIVERY_DEFAULTS};
    for(const key of keys)if(Object.hasOwn(doc,key))Object.assign(configured,{[key]:doc[key]});
    validate(configured);
    const effective={...configured};const overridden:Array<keyof DeliverySettings>=[];
    for(const key of keys){
      const raw=this.env[envNames[key]];if(raw===undefined)continue;
      let value:number|boolean;
      if(key==='batchHeld'){
        if(!['true','false','1','0'].includes(raw))throw new RoomError('invalid_state',`${envNames[key]} must be true, false, 1 or 0.`);
        value=raw==='true'||raw==='1';
      }else{
        if(!/^\d+$/.test(raw))throw new RoomError('invalid_state',`${envNames[key]} must be decimal milliseconds.`);
        value=Number(raw);
      }
      Object.assign(effective,{[key]:value});overridden.push(key);
    }
    validate(effective);return {defaults:{...DELIVERY_DEFAULTS},configured,effective,overridden};
  }
  async get():Promise<RoomSettingsView>{return this.view(await this.document());}
  async update(patch:unknown):Promise<RoomSettingsView>{
    if(!isObject(patch)||Object.keys(patch).some(k=>!keys.includes(k as keyof DeliverySettings)))throw new RoomError('bad_request','Unknown room delivery setting.');
    const dir=path.join(this.root,'.room');await mkdir(dir,{recursive:true});
    const lock=path.join(dir,'settings.lock');const owner=JSON.stringify({pid:process.pid,nonce:randomUUID()});
    const deadline=Date.now()+2000;let handle;
    for(;;){try{handle=await open(lock,'wx');break;}catch(e){if(code(e)!=='EEXIST')throw e;if(Date.now()>=deadline)throw new RoomError('invalid_state','Settings are locked; retry or inspect .room/settings.lock.');await new Promise(r=>setTimeout(r,20));}}
    let temp:string|undefined;
    try {
      await handle.writeFile(owner);
      const doc=await this.document();
      for(const [key,value] of Object.entries(patch)){if(value===null)delete doc[key];else doc[key]=value;}
      const view=this.view(doc);
      temp=path.join(dir,`settings.${randomUUID()}.tmp`);
      const file=await open(temp,'wx');
      try{await file.writeFile(JSON.stringify(doc,null,2)+'\n');await file.sync();}finally{await file.close();}
      await renameWithRetry(temp,path.join(dir,'settings.json'));
      return view;
    }finally{
      try{await handle.close();}finally{
        if(temp)await unlink(temp).catch(e=>{if(code(e)!=='ENOENT')throw e;});
        if(await readFile(lock,'utf8')===owner)await unlink(lock);
      }
    }
  }
}
