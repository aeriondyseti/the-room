import { Dispatcher } from '../dispatch/dispatcher.js';
import type { DeliveryAdapter } from '../../contracts/adapter.js';
import { Ledger } from '../ledger/ledger.js';
import { joinParticipant, readRegistry } from '../registry/registry.js';
import { HUMAN, isValidParticipantName, type ParticipantState, type TargetSnapshot } from '../../contracts/domain.js';
import { MAX_FRAME_BYTES, type ClientKind, type RequestFrame, type RoomEvent } from '../../contracts/ipc.js';
import { RoomError } from '../../contracts/errors.js';
import { loadConfig } from '../config.js';
import { integer, nativeEvidence, optionalText, record, requireHuman, resolveCaller, text } from './validation.js';

export class RoomService {
  readonly ledger: Ledger;
  readonly dispatcher: Dispatcher;
  private listeners = new Set<(event: RoomEvent)=>void>();
  constructor(readonly root: string, adapters:DeliveryAdapter[] = []) { this.ledger = new Ledger(root);this.dispatcher=new Dispatcher(root,this.ledger,adapters,event=>this.publish(event)); }
  start():void{this.dispatcher.start();}
  async close():Promise<void>{await this.dispatcher.stop();this.ledger.close();}
  onEvent(listener: (event:RoomEvent)=>void): ()=>void { this.listeners.add(listener);return ()=>this.listeners.delete(listener); }
  publish(event:RoomEvent): void { for(const listener of this.listeners)listener(event); }
  async handle(request:RequestFrame, client:ClientKind): Promise<unknown> {
    const p=record(request.params);
    switch(request.method) {
      case 'send': {
        const registry=await readRegistry(this.root);const caller=resolveCaller(p.caller,client,registry);
        const body=text(p.body,'body');
        if(Buffer.byteLength(JSON.stringify(body),'utf8')>MAX_FRAME_BYTES/2)throw new RoomError('message_too_large','Message exceeds the room IPC body budget.');
        if(p.to!==null && p.to!==undefined && (!Array.isArray(p.to)||p.to.some(v=>typeof v!=='string')))throw new RoomError('bad_request','Recipients must be a string array.');
        const to=(p.to??[]) as string[];const requested=[...new Set(to.map(n=>n.replace(/^@/,'')))];
        if(!requested.length && caller.sender.kind==='agent')throw new RoomError('no_recipients','Agent messages require explicit recipients.');
        const broadcast=!requested.length || requested.includes('all');
        if(requested.includes('all') && requested.length!==1)throw new RoomError('bad_request','Use all alone or list specific names.');
        const identity={sender:caller.sender,senderScope:caller.scope,body,requestedRecipients:broadcast?null:requested,
          addressing:broadcast?'broadcast' as const:'direct' as const,replyTo:optionalText(p.replyTo,'replyTo'),clientMessageId:optionalText(p.clientMessageId,'clientMessageId')};
        const retry=this.ledger.findRetry(identity);if(retry)return retry;
        const recipients=broadcast ? Object.keys(registry).filter(n=>n!==caller.sender.name) : requested;
        if(!recipients.length)throw new RoomError('no_recipients','No participants are enrolled for this message.');
        const targets=recipients.map(name=>{
          if(name===HUMAN)return {name,target:null};
          const binding=Object.hasOwn(registry,name)?registry[name]:undefined;
          if(!binding)throw new RoomError('unknown_recipient',`Unknown participant: ${name}`);
          return {name,target:{harness:binding.harness,sessionId:binding.session_id}};
        });
        const saved=this.ledger.transaction(()=>{
          const result=this.ledger.enqueue({sender:caller.sender,senderScope:caller.scope,body,requestedRecipients:broadcast?null:requested,
            recipients:targets,addressing:broadcast?'broadcast':'direct',replyTo:optionalText(p.replyTo,'replyTo'),
            clientMessageId:optionalText(p.clientMessageId,'clientMessageId'),held:this.ledger.roomState().paused});
          let replyDelivery=null;
          if(!result.deduplicated&&result.message.replyTo&&caller.sender.kind==='agent'){
            const prior=this.ledger.deliveries(result.message.replyTo).find(d=>d.recipient===caller.sender.name&&`${d.target.harness}:${d.target.sessionId}`===caller.scope);
            if(prior)replyDelivery=this.ledger.updateDelivery(prior.messageId,prior.recipient,d=>{d.state='replied';d.repliedBy=result.message.id;d.held=false;d.waiting=null;});
          }
          return{result,replyDelivery};
        });
        const {result,replyDelivery}=saved;
        if(!result.deduplicated){
          this.publish({type:'message.created',message:result.message,deliveries:result.deliveries});
          if(replyDelivery)this.publish({type:'delivery.updated',delivery:replyDelivery});
          void this.dispatcher.kick();
        }
        return result;
      }
      case 'read': {
        const id=optionalText(p.messageId,'messageId');
        if(id){const item=this.ledger.read(id);return {items:[item],lastSeq:item.message.seq,hasMore:false};}
        const after=p.afterSeq===undefined||p.afterSeq===null?null:integer(p.afterSeq,'afterSeq',0);
        return this.ledger.list(after,Math.min(integer(p.limit,'limit',loadConfig().readPageSize,1),loadConfig().readPageSize));
      }
      case 'who': return {participants:await this.participants(),room:this.ledger.roomState()};
      case 'join': {
        const name=text(p.name,'name');if(!isValidParticipantName(name))throw new RoomError('bad_request','Choose a valid lowercase participant name.');
        const native=nativeEvidence(p.native);const prior=await readRegistry(this.root);
        const expected=p.expectedPrevious===undefined||p.expectedPrevious===null?undefined:record(p.expectedPrevious);
        if(expected && (expected.harness!=='codex'&&expected.harness!=='claude'||typeof expected.sessionId!=='string'))throw new RoomError('bad_request','expectedPrevious must include harness and sessionId.');
        const registry=await joinParticipant(this.root,name,{harness:native.harness,session_id:native.sessionId},expected?{expectedPrevious:{harness:expected.harness as TargetSnapshot['harness'],session_id:expected.sessionId as string}}:{});
        const binding=registry[name]!;const registration={name,harness:binding.harness,sessionId:binding.session_id};
        const state=(await this.participants()).find(participant=>participant.name===name)!;
        this.ledger.putParticipant(state);this.publish({type:'participant.updated',participant:state});void this.dispatcher.kick();
        return {registration,created:!prior[name],rebound:!!prior[name]&&(prior[name].harness!==binding.harness||prior[name].session_id!==binding.session_id)};
      }
      case 'deliveries': return {deliveries:this.ledger.read(text(p.messageId,'messageId')).deliveries};
      case 'shutdown': requireHuman(p.caller,client);return {stopping:true};
      case 'pause': {
        requireHuman(p.caller,client);
        if(p.resendStopRequest!==undefined&&typeof p.resendStopRequest!=='boolean')throw new RoomError('bad_request','resendStopRequest must be boolean.');
        if(p.stopRequestBody!==undefined&&p.stopRequestBody!==null&&Buffer.byteLength(JSON.stringify(text(p.stopRequestBody,'stopRequestBody')))>MAX_FRAME_BYTES/2)throw new RoomError('message_too_large','Stop request exceeds the room IPC body budget.');
        const registry=await readRegistry(this.root);const existing=this.ledger.roomState();
        if(existing.paused&&!p.resendStopRequest)return{room:existing,stopRequest:null};
        const result=this.ledger.transaction(()=>{
          const held=[];
          for(const d of this.ledger.queued())if(d.attempts.at(-1)?.outcome!=='in_flight'&&this.ledger.read(d.messageId).message.kind!=='stop_request')held.push(this.ledger.updateDelivery(d.messageId,d.recipient,value=>{value.held=true;}));
          const stopRequest=this.ledger.enqueue({sender:{name:HUMAN,kind:'human',identity:{mode:'human',source:'tui'}},senderScope:HUMAN,
            body:optionalText(p.stopRequestBody,'stopRequestBody')??'The human paused this room. Please stop work at the next safe opportunity and report your status. This is a cooperative request, not forced interruption.',
            requestedRecipients:null,recipients:Object.entries(registry).map(([name,b])=>({name,target:{harness:b.harness,sessionId:b.session_id}})),addressing:'broadcast',kind:'stop_request',held:false});
          const room={paused:true,pausedAt:new Date().toISOString(),stopRequestId:stopRequest.message.id};this.ledger.setRoomState(room);return{room,stopRequest,held};
        });
        this.publish({type:'room.updated',room:result.room});for(const d of result.held)this.publish({type:'delivery.updated',delivery:d});
        this.publish({type:'message.created',message:result.stopRequest.message,deliveries:result.stopRequest.deliveries});void this.dispatcher.kick();
        return{room:result.room,stopRequest:result.stopRequest};
      }
      case 'resume': {
        requireHuman(p.caller,client);const released=this.ledger.transaction(()=>{
          const changed=[];for(const d of this.ledger.queued())if(d.held&&d.waiting!=='rebind_needed')changed.push(this.ledger.updateDelivery(d.messageId,d.recipient,v=>{v.held=false;}));
          const state=this.ledger.roomState();this.ledger.setRoomState({...state,paused:false,pausedAt:null});return changed;
        });
        const room=this.ledger.roomState();this.publish({type:'room.updated',room});for(const d of released)this.publish({type:'delivery.updated',delivery:d});void this.dispatcher.kick();return{room,released:released.length};
      }
      case 'retry': {
        requireHuman(p.caller,client);const id=text(p.messageId,'messageId');const recipient=text(p.recipient,'recipient');
        const prior=this.ledger.delivery(id,recipient);
        if(!['failed','uncertain'].includes(prior.state))throw new RoomError('invalid_state','Only failed or uncertain deliveries can be explicitly retried.');
        const registry=await readRegistry(this.root);const target=registry[recipient];
        if(!target||target.harness!==prior.target.harness||target.session_id!==prior.target.sessionId)throw new RoomError('rebind_conflict','The original recipient binding changed; send a new linked message instead of redirecting this delivery.');
        const delivery=this.ledger.updateDelivery(id,recipient,d=>{if(!['failed','uncertain'].includes(d.state)||d.attempts.length!==prior.attempts.length)throw new RoomError('invalid_state','Delivery changed while retry was being prepared; refresh its state.');d.state='queued';d.waiting=null;d.held=this.ledger.roomState().paused&&this.ledger.read(id).message.kind!=='stop_request';});
        this.publish({type:'delivery.updated',delivery});void this.dispatcher.kick();return{delivery};
      }
      default:throw new RoomError('bad_request','This request is handled by the IPC connection.');
    }
  }
  async participants():Promise<ParticipantState[]> {
    const registry=await readRegistry(this.root);const previous=this.ledger.participants();const queued=this.ledger.queued();
    return Object.entries(registry).map(([name,binding])=>{
      const saved=previous.find(p=>p.name===name&&p.harness===binding.harness&&p.sessionId===binding.session_id);
      return {name,harness:binding.harness,sessionId:binding.session_id,liveness:saved?.liveness??'unknown',livenessCheckedAt:saved?.livenessCheckedAt??null,
        activity:saved?.activity??'unknown',pending:queued.filter(d=>d.recipient===name).length,usage:saved?.usage??null};
    });
  }
}
