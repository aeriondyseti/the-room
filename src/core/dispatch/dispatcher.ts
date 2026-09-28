import type { Delivery, Harness, RoomMessage, UnavailableReason } from '../../contracts/domain.js';
import { isSubmitResult, type DeliveryAdapter, type SubmitResult } from '../../contracts/adapter.js';
import type { RoomEvent } from '../../contracts/ipc.js';
import { RoomError } from '../../contracts/errors.js';
import { Ledger } from '../ledger/ledger.js';
import { readRegistry } from '../registry/registry.js';
import { loadConfig } from '../config.js';
import { buildEnvelope } from './envelope.js';

/** One worker per recipient. Adapter acceptance is never treated as proof of model processing. */
export class Dispatcher {
 private adapters=new Map<Harness,DeliveryAdapter>();private workers=new Map<string,Promise<void>>();
 private timer:NodeJS.Timeout|null=null;private stopped=false;private scheduling=false;private started=false;
 constructor(private root:string,private ledger:Ledger,adapters:DeliveryAdapter[],private emit:(event:RoomEvent)=>void){for(const adapter of adapters)this.adapters.set(adapter.harness,adapter);}
 start():void {
  if(this.started)return;this.started=true;this.recover();this.timer=setInterval(()=>{void this.kick();},loadConfig().dispatchPollMs);this.timer.unref();void this.kick();
 }
 async stop():Promise<void>{this.stopped=true;if(this.timer)clearInterval(this.timer);await Promise.allSettled(this.workers.values());}
 recover():void {
  for(const delivery of this.ledger.unfinishedAttempts()){
   if(delivery.attempts.at(-1)?.outcome!=='in_flight')continue;
   const changed=this.ledger.updateDelivery(delivery.messageId,delivery.recipient,d=>{
    if(d.state!=='replied')d.state='uncertain';d.held=false;const attempt=d.attempts.at(-1)!;attempt.outcome='uncertain';attempt.finishedAt=new Date().toISOString();
    attempt.error={code:'service_unavailable',message:'Service stopped during submission; delivery outcome is unknown.',hint:'Reconcile with the recipient before requesting a retry.'};
   });this.emit({type:'delivery.updated',delivery:changed});
  }
 }
 async kick():Promise<void>{
  if(this.stopped||this.scheduling)return;this.scheduling=true;
  try{
   for(const name of new Set(this.ledger.queued().filter(d=>!d.held).map(d=>d.recipient))){
    if(this.workers.has(name))continue;
    let processing:Delivery|undefined;
    const worker=this.run(name,d=>{processing=d;}).catch(()=>{
     if(!processing)return;
     const pending=this.ledger.delivery(processing.messageId,processing.recipient);
     if(pending.state!=='queued'||(pending.held&&pending.attempts.at(-1)?.outcome!=='in_flight'))return;
     const inFlight=pending.attempts.at(-1)?.outcome==='in_flight';
     this.change(pending,value=>{
      value.state=inFlight?'uncertain':'failed';
      const error={code:'internal',message:inFlight?'Dispatcher failed during submission; reconcile before retry.':'Dispatcher could not resolve this delivery; run room doctor and retry after correcting the configuration.'};
      if(inFlight){const a=value.attempts.at(-1)!;a.outcome='uncertain';a.finishedAt=new Date().toISOString();a.error=error;}
      else value.attempts.push({n:value.attempts.length+1,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),outcome:'failed',evidence:null,error});
     });
    }).finally(()=>this.workers.delete(name));
    this.workers.set(name,worker);
   }
  }finally{this.scheduling=false;}
 }
 /** Wait for current work, then perform a fresh scheduler pass (including changed reachability). */
 async idle():Promise<void>{await Promise.allSettled(this.workers.values());await this.kick();await Promise.allSettled(this.workers.values());}
 private change(delivery:Delivery,update:(d:Delivery)=>void):Delivery{
  const changed=this.ledger.updateDelivery(delivery.messageId,delivery.recipient,update);this.emit({type:'delivery.updated',delivery:changed});
  const previous=this.ledger.participants().find(p=>p.name===delivery.recipient&&p.harness===delivery.target.harness&&p.sessionId===delivery.target.sessionId);
  if(previous){const participant={...previous,pending:this.ledger.queued(delivery.recipient).length};this.ledger.putParticipant(participant);this.emit({type:'participant.updated',participant});}
  return changed;
 }
 private async run(name:string,selected:(d:Delivery)=>void):Promise<void>{
  while(!this.stopped){
   const next=this.ledger.queued(name).find(d=>!d.held);if(!next)return;selected(next);
   const registry=await readRegistry(this.root);const binding=registry[name];
   if(!binding||binding.harness!==next.target.harness||binding.session_id!==next.target.sessionId){
    this.change(next,d=>{d.held=true;d.waiting='rebind_needed';});continue;
   }
   const adapter=this.adapters.get(next.target.harness);if(!adapter)return;
   let probe;
   probe=await adapter.probe(next.target);
   if(this.stopped)return;
   const fresh=(await readRegistry(this.root))[name];
   if(!fresh||fresh.harness!==next.target.harness||fresh.session_id!==next.target.sessionId){this.change(next,d=>{d.held=true;d.waiting='rebind_needed';});continue;}
   const old=this.ledger.participants().find(p=>p.name===name&&p.sessionId===next.target.sessionId&&p.harness===next.target.harness);
   const participant={name,...next.target,liveness:probe.liveness,livenessCheckedAt:new Date().toISOString(),activity:probe.activity,pending:this.ledger.queued(name).length,usage:old?.usage??null};
   this.ledger.putParticipant(participant);this.emit({type:'participant.updated',participant});
   // Pause may have happened while a probe was awaiting the native process query.
   const current=this.ledger.delivery(next.messageId,name);if(current.state!=='queued'||current.held)continue;
   if(probe.liveness==='offline'||probe.liveness==='rebind_needed'){
    this.wait(current,probe.liveness==='offline'?'offline':'rebind_needed');return;
   }
   const message=this.ledger.read(current.messageId).message;
   let envelope;
   try{envelope=buildEnvelope(this.root,message,name,adapter.maxEnvelopeChars);}catch(error){
    this.change(current,d=>{d.state='failed';d.attempts.push({n:d.attempts.length+1,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),outcome:'failed',evidence:null,error:{code:'message_too_large',message:(error as Error).message}});});continue;
   }
   const attempting=this.change(current,d=>{d.waiting=null;d.referenced=envelope.referenced;d.attempts.push({n:d.attempts.length+1,startedAt:new Date().toISOString(),finishedAt:null,outcome:'in_flight',evidence:null,error:null});});
   let result:SubmitResult;
   try {
    const received=await adapter.submit({target:current.target,envelope:envelope.text,messageId:message.id,recipient:name,attempt:attempting.attempts.length});
    result=isSubmitResult(received)?received:{status:'uncertain',error:{code:'internal',message:'Adapter returned an invalid result; reconcile before retry.'}};
   }catch{result={status:'uncertain',error:{code:'internal',message:'Adapter failed after submission began; reconcile before retry.'}};}
   this.change(current,d=>{
    const a=d.attempts.at(-1)!;a.finishedAt=new Date().toISOString();
    if(result.status==='submitted'){a.outcome='submitted';a.evidence=result.evidence;if(d.state!=='replied')d.state='submitted';}
    else if(result.status==='unavailable'){a.outcome='failed';a.error={code:'service_unavailable',message:'No native message submitted: '+result.detail};if(d.state!=='replied'){d.waiting=result.reason;d.held=result.reason==='rebind_needed'||(this.ledger.roomState().paused&&message.kind!=='stop_request');}}
    else{a.outcome=result.status;a.error=result.error;if(d.state!=='replied')d.state=result.status;}
   });
   if(result.status==='unavailable')return;
  }
 }
 private wait(delivery:Delivery,reason:UnavailableReason):void {
  if(delivery.waiting===reason)return;
  this.change(delivery,d=>{d.waiting=reason;if(reason==='rebind_needed')d.held=true;});
 }
}
