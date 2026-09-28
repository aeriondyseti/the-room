import type { Delivery, Harness, RoomMessage, UnavailableReason } from '../../contracts/domain.js';
import { isSubmitResult, type DeliveryAdapter, type SubmitResult } from '../../contracts/adapter.js';
import type { RoomEvent } from '../../contracts/ipc.js';
import { RoomError } from '../../contracts/errors.js';
import { Ledger } from '../ledger/ledger.js';
import { readRegistry } from '../registry/registry.js';
import { loadConfig } from '../config.js';
import { buildBatchEnvelope, buildEnvelope } from './envelope.js';

/** One worker per recipient. Adapter acceptance is never treated as proof of model processing. */
export class Dispatcher {
 private adapters=new Map<Harness,DeliveryAdapter>();private workers=new Map<string,Promise<void>>();
 private timer:NodeJS.Timeout|null=null;private stopped=false;private scheduling=false;private started=false;
 private holdTimer:NodeJS.Timeout|null=null;private holdWakeAt=0;
 constructor(private root:string,private ledger:Ledger,adapters:DeliveryAdapter[],private emit:(event:RoomEvent)=>void,private snapshotFor?:(scope:string,messageId:string|string[])=>string){for(const adapter of adapters)this.adapters.set(adapter.harness,adapter);}
 start():void {
  if(this.started)return;this.started=true;this.recover();this.timer=setInterval(()=>{void this.kick();},loadConfig().dispatchPollMs);this.timer.unref();void this.kick();
 }
 async stop():Promise<void>{this.stopped=true;if(this.timer)clearInterval(this.timer);if(this.holdTimer)clearTimeout(this.holdTimer);await Promise.allSettled(this.workers.values());}
 private wakeAt(at:number):void {
  if(this.stopped||(this.holdTimer&&this.holdWakeAt<=at))return;
  if(this.holdTimer)clearTimeout(this.holdTimer);this.holdWakeAt=at;
  this.holdTimer=setTimeout(()=>{this.holdTimer=null;this.holdWakeAt=0;void this.kick();},Math.min(2_147_483_647,Math.max(1,at-Date.now())));
  this.holdTimer.unref();
 }
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
    let processing:Delivery[]=[];
    const worker=this.run(name,d=>{processing=d;}).catch(()=>{
     if(!processing.length)return;
     for(const selected of processing){
     const pending=this.ledger.findDelivery(selected.messageId,selected.recipient);
     if(!pending)continue;
     if(pending.state!=='queued'||(pending.held&&pending.attempts.at(-1)?.outcome!=='in_flight'))continue;
     const inFlight=pending.attempts.at(-1)?.outcome==='in_flight';
     this.change(pending,value=>{
      value.state=inFlight?'uncertain':'failed';
      const error={code:'internal',message:inFlight?'Dispatcher failed during submission; reconcile before retry.':'Dispatcher could not resolve this delivery; run room doctor and retry after correcting the configuration.'};
      if(inFlight){const a=value.attempts.at(-1)!;a.outcome='uncertain';a.finishedAt=new Date().toISOString();a.error=error;}
      else value.attempts.push({n:value.attempts.length+1,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),outcome:'failed',evidence:null,error});
     });
     }
    }).finally(()=>this.workers.delete(name));
    this.workers.set(name,worker);
   }
  }finally{this.scheduling=false;}
 }
 /** Wait for current work, then perform a fresh scheduler pass (including changed reachability). */
 async idle():Promise<void>{await Promise.allSettled(this.workers.values());await this.kick();await Promise.allSettled(this.workers.values());}
 /** A lifecycle removal waits only for this recipient's in-flight native handoff. */
 async settleRecipient(name:string):Promise<void>{const worker=this.workers.get(name);if(worker)await worker;}
 private change(delivery:Delivery,update:(d:Delivery)=>void):Delivery{
  const changed=this.ledger.updateDelivery(delivery.messageId,delivery.recipient,update);this.emit({type:'delivery.updated',delivery:changed});
  const previous=this.ledger.participants().find(p=>p.name===delivery.recipient&&p.harness===delivery.target.harness&&p.sessionId===delivery.target.sessionId);
  if(previous){const participant={...previous,pending:this.ledger.queued(delivery.recipient).length};this.ledger.putParticipant(participant);this.emit({type:'participant.updated',participant});}
  return changed;
 }
 private changeMany(deliveries:Delivery[],update:(d:Delivery)=>void):Delivery[]{
  const changed=this.ledger.transaction(()=>deliveries.map(d=>this.ledger.updateDelivery(d.messageId,d.recipient,update)));
  for(const delivery of changed)this.emit({type:'delivery.updated',delivery});
  const first=changed[0]!;
  const old=this.ledger.participants().find(p=>p.name===first.recipient&&p.harness===first.target.harness&&p.sessionId===first.target.sessionId);
  if(old){const participant={...old,pending:this.ledger.queued(first.recipient).length};this.ledger.putParticipant(participant);this.emit({type:'participant.updated',participant});}
  return changed;
 }
 private async run(name:string,selected:(d:Delivery[])=>void):Promise<void>{
  while(!this.stopped){
   const next=this.ledger.queued(name).find(d=>!d.held);if(!next)return;selected([next]);
   const eligibleAt=next.notBefore?Date.parse(next.notBefore):0;
   if(eligibleAt>Date.now()){this.wakeAt(eligibleAt);return;}
   const registry=await readRegistry(this.root);const binding=registry[name];
   if(this.ledger.findDelivery(next.messageId,name)?.state!=='queued')continue;
   if(!binding||binding.harness!==next.target.harness||binding.session_id!==next.target.sessionId){
    this.change(next,d=>{d.held=true;d.waiting='rebind_needed';});continue;
   }
   const adapter=this.adapters.get(next.target.harness);if(!adapter)return;
   let probe;
   probe=await adapter.probe(next.target);
   if(this.stopped)return;
   const fresh=(await readRegistry(this.root))[name];
   const afterProbe=this.ledger.findDelivery(next.messageId,name);if(!afterProbe||afterProbe.state!=='queued'||afterProbe.held)continue;
   if(!fresh||fresh.harness!==next.target.harness||fresh.session_id!==next.target.sessionId){this.change(next,d=>{d.held=true;d.waiting='rebind_needed';});continue;}
   const old=this.ledger.participants().find(p=>p.name===name&&p.sessionId===next.target.sessionId&&p.harness===next.target.harness);
   const participant={...old,name,...next.target,liveness:probe.liveness,livenessCheckedAt:new Date().toISOString(),activity:probe.activity,pending:this.ledger.queued(name).length,usage:old?.usage??null};
   this.ledger.putParticipant(participant);this.emit({type:'participant.updated',participant});
   // Pause may have happened while a probe was awaiting the native process query.
   const current=this.ledger.findDelivery(next.messageId,name);if(!current||current.state!=='queued'||current.held)continue;
   // Urgent work may have arrived during the asynchronous native probe. Claim
   // the current lane head, not the stale selection from before that await.
   if(this.ledger.queued(name).find(d=>!d.held)?.messageId!==current.messageId)continue;
   const refreshedDeadline=Date.parse(current.notBefore??'');
   if(refreshedDeadline>Date.now()){this.wakeAt(refreshedDeadline);return;}
   if(probe.liveness==='offline'||probe.liveness==='rebind_needed'){
    this.wait(current,probe.liveness==='offline'?'offline':'rebind_needed');return;
   }
   const message=this.ledger.read(current.messageId).message;
   let batch=[current];
   if(current.burst&&!current.attempts.length){
    const pending=this.ledger.queued(name);const start=pending.findIndex(d=>d.messageId===current.messageId);
    for(const candidate of pending.slice(start+1)){
     if(candidate.held||candidate.burst?.id!==current.burst.id||candidate.attempts.length||candidate.target.harness!==current.target.harness||candidate.target.sessionId!==current.target.sessionId)break;
     batch.push(candidate);
    }
   }
   const messages=batch.map(d=>this.ledger.read(d.messageId).message);
   const format=(items:RoomMessage[],options:{snapshot?:string}={})=>items.length>1?buildBatchEnvelope(this.root,items,name,adapter.maxEnvelopeChars,options):{...buildEnvelope(this.root,items[0]!,name,adapter.maxEnvelopeChars,options),included:1};
   let envelope;
   try{
    envelope=format(messages);
    batch=batch.slice(0,envelope.included);
   }catch(error){
    this.change(current,d=>{d.state='failed';d.attempts.push({n:d.attempts.length+1,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),outcome:'failed',evidence:null,error:{code:'message_too_large',message:(error as Error).message}});});continue;
   }
   // Snapshot issuance is optional assistance. A storage/read failure must not be
   // misreported as message_too_large or stop an otherwise valid native delivery.
   if(!envelope.referenced&&this.snapshotFor){
    const scope=`${current.target.harness}:${current.target.sessionId}`;let snapshot:string|undefined;
    try{
     snapshot=this.snapshotFor(scope,batch.length===1?message.id:batch.map(d=>d.messageId));
     const candidate=format(messages.slice(0,batch.length),{snapshot});
     if(candidate.snapshot&&candidate.included===batch.length)envelope=candidate;
     else this.ledger.discardCrossing(snapshot,scope,'snapshot');
    }catch{
     if(snapshot)try{this.ledger.discardCrossing(snapshot,scope,'snapshot');}catch{/* Best effort cleanup; use the plain envelope. */}
    }
   }
   selected(batch);
   const attempting=this.changeMany(batch,d=>{d.waiting=null;d.referenced=envelope.referenced;d.attempts.push({n:d.attempts.length+1,startedAt:new Date().toISOString(),finishedAt:null,outcome:'in_flight',evidence:null,error:null,...(adapter.runtimeContext?{runtimeContext:{...adapter.runtimeContext}}:{})});});
   let result:SubmitResult;
   try {
    const received=await adapter.submit({target:current.target,envelope:envelope.text,messageId:message.id,recipient:name,attempt:attempting[0]!.attempts.length});
    result=isSubmitResult(received)?received:{status:'uncertain',error:{code:'internal',message:'Adapter returned an invalid result; reconcile before retry.'}};
   }catch{result={status:'uncertain',error:{code:'internal',message:'Adapter failed after submission began; reconcile before retry.'}};}
   this.changeMany(batch,d=>{
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
