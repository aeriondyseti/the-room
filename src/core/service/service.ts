import { Ledger } from '../ledger/ledger.js';
import { joinParticipant, readRegistry } from '../registry/registry.js';
import { HUMAN, isValidParticipantName, type ParticipantState, type TargetSnapshot } from '../../contracts/domain.js';
import { MAX_FRAME_BYTES, type ClientKind, type RequestFrame, type RoomEvent } from '../../contracts/ipc.js';
import { RoomError } from '../../contracts/errors.js';
import { loadConfig } from '../config.js';
import { integer, nativeEvidence, optionalText, record, requireHuman, resolveCaller, text } from './validation.js';

export class RoomService {
  readonly ledger: Ledger;
  private listeners = new Set<(event: RoomEvent)=>void>();
  constructor(readonly root: string) { this.ledger = new Ledger(root); }
  close(): void { this.ledger.close(); }
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
        const result=this.ledger.enqueue({sender:caller.sender,senderScope:caller.scope,body,requestedRecipients:broadcast?null:requested,
          recipients:targets,addressing:broadcast?'broadcast':'direct',replyTo:optionalText(p.replyTo,'replyTo'),
          clientMessageId:optionalText(p.clientMessageId,'clientMessageId'),held:this.ledger.roomState().paused});
        if(!result.deduplicated)this.publish({type:'message.created',message:result.message,deliveries:result.deliveries});
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
        this.publish({type:'participant.updated',participant:state});
        return {registration,created:!prior[name],rebound:!!prior[name]&&(prior[name].harness!==binding.harness||prior[name].session_id!==binding.session_id)};
      }
      case 'deliveries': return {deliveries:this.ledger.read(text(p.messageId,'messageId')).deliveries};
      case 'shutdown': requireHuman(p.caller,client);return {stopping:true};
      case 'pause':case 'resume':case 'retry':requireHuman(p.caller,client);throw new RoomError('invalid_state','Dispatcher control is not installed yet.');
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
