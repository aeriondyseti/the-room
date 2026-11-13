import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { constants, readFileSync } from 'node:fs';
import type { DeliverySettings, RoomSettingsView } from '../contracts/settings.js';
import { RoomError } from '../contracts/errors.js';
import { renameWithRetry } from './registry/registry.js';

export const DELIVERY_DEFAULTS: Readonly<DeliverySettings> = Object.freeze({deliveryHoldMs:500,batchHeld:true,batchMaxHoldMs:2000});
const envNames = {deliveryHoldMs:'ROUNDTABLE_DELIVERY_HOLD_MS',batchHeld:'ROUNDTABLE_BATCH_HELD',batchMaxHoldMs:'ROUNDTABLE_BATCH_MAX_HOLD_MS'} as const;
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
  private lastGood:RoomSettingsView;
  private observedGood=false;
  constructor(private readonly root:string,env:NodeJS.ProcessEnv=process.env){
    this.env={...env};
    // Validate the captured environment before a service can accept requests.
    // A valid room file may supply the companion cap for a larger env hold.
    let initial:Record<string,unknown>={version:1};
    try{const raw=readFileSync(path.join(root,'.roundtable','settings.json'),'utf8');if(Buffer.byteLength(raw)>1024*1024)throw new Error('Oversized settings');const parsed:unknown=JSON.parse(raw);
      if(isObject(parsed)&&parsed.version===1){const values={...DELIVERY_DEFAULTS};for(const key of keys)if(Object.hasOwn(parsed,key))Object.assign(values,{[key]:parsed[key]});validate(values);initial=parsed;this.observedGood=true;}
    }catch{/* A bad file is recoverable; environment validation below is not. */}
    try{this.lastGood=this.view(initial);}
    catch{
      // A file and an environment override can each be valid yet conflict together.
      // In that case the file is recoverable; an invalid environment on its own
      // still fails construction so the service cannot start with a bad policy.
      this.observedGood=false;
      this.lastGood=this.view({version:1});
    }
  }
  private async document():Promise<Record<string,unknown>> {
    try {
      const raw=await readFile(path.join(this.root,'.roundtable','settings.json'),'utf8');
      if(Buffer.byteLength(raw)>1024*1024)throw new RoomError('invalid_state','Room settings file exceeds 1 MiB.');
      const doc:unknown=JSON.parse(raw);
      if(!isObject(doc)||doc.version!==1)throw new RoomError('invalid_state','Room settings requires schema version 1.');
      return doc;
    }catch(e){if(code(e)==='ENOENT')return {version:1};if(e instanceof RoomError)throw e;throw new RoomError('invalid_state','Could not read room settings; check .roundtable/settings.json.');}
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
  async get():Promise<RoomSettingsView>{
    try{const view=this.view(await this.document());this.lastGood=view;this.observedGood=true;return structuredClone(view);}
    catch{return {...structuredClone(this.lastGood),problem:{source:'file',code:'invalid_state',message:'Room settings file is unreadable, unsupported, or invalid for this service environment.',fallback:this.observedGood?'last_good':'defaults'}};}
  }
  async update(patch:unknown):Promise<RoomSettingsView>{
    if(!isObject(patch)||Object.keys(patch).some(k=>!keys.includes(k as keyof DeliverySettings)))throw new RoomError('bad_request','Unknown room delivery setting.');
    const dir=path.join(this.root,'.roundtable');await mkdir(dir,{recursive:true});
    const lock=path.join(dir,'settings.lock');const owner=JSON.stringify({pid:process.pid,nonce:randomUUID()});
    const deadline=Date.now()+2000;let handle;
    for(;;){try{handle=await open(lock,'wx');break;}catch(e){if(code(e)!=='EEXIST')throw e;if(Date.now()>=deadline)throw new RoomError('invalid_state','Settings are locked; retry or inspect .roundtable/settings.lock.');await new Promise(r=>setTimeout(r,20));}}
    let temp:string|undefined;
    try {
      await handle.writeFile(owner);
      let doc:Record<string,unknown>;
      let repair=false;
      try{doc=await this.document();try{this.view(doc);}catch{repair=true;doc={...doc,...this.lastGood.configured};}}
      catch{
        const file=path.join(dir,'settings.json');
        // Never downgrade a schema owned by a future binary.
        let parsed:unknown;try{parsed=JSON.parse(await readFile(file,'utf8'));}catch{/* Back up the raw file below. */}
        if(isObject(parsed)&&typeof parsed.version==='number'&&parsed.version>1)throw new RoomError('unsupported_version','Settings were created by a newer version; repair with that version.');
        doc={...(isObject(parsed)?parsed:{}),version:1,...this.lastGood.configured};repair=true;
      }
      for(const [key,value] of Object.entries(patch)){if(value===null)delete doc[key];else doc[key]=value;}
      const view=this.view(doc);
      if(repair)await copyFile(path.join(dir,'settings.json'),path.join(dir,`settings.backup.${randomUUID()}.json`),constants.COPYFILE_EXCL).catch(e=>{if(code(e)!=='ENOENT')throw e;});
      temp=path.join(dir,`settings.${randomUUID()}.tmp`);
      const file=await open(temp,'wx');
      try{await file.writeFile(JSON.stringify(doc,null,2)+'\n');await file.sync();}finally{await file.close();}
      await renameWithRetry(temp,path.join(dir,'settings.json'));
      this.lastGood=view;this.observedGood=true;return structuredClone(view);
    }finally{
      try{await handle.close();}finally{
        if(temp)await unlink(temp).catch(e=>{if(code(e)!=='ENOENT')throw e;});
        let stillOwned=false;
        try{stillOwned=(await readFile(lock,'utf8'))===owner;}
        catch(e){if(code(e)!=='ENOENT')throw e;}
        if(!stillOwned)throw new RoomError('invalid_state','Settings lock disappeared or ownership changed; inspect .roundtable/settings.lock before retrying.');
        await unlink(lock);
      }
    }
  }
}
