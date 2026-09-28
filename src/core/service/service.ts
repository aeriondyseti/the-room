import { randomBytes } from 'node:crypto';
import { InboxStore } from '../ledger/inbox.js';
import type { GuardedSendOutcome, InboxRequest } from '../../contracts/crossing.js';
import { Dispatcher } from '../dispatch/dispatcher.js';
import type { DeliveryAdapter } from '../../contracts/adapter.js';
import { Ledger } from '../ledger/ledger.js';
import { joinParticipant, readRegistry } from '../registry/registry.js';
import { HUMAN, isValidParticipantName, type ParticipantState, type TargetSnapshot } from '../../contracts/domain.js';
import { MAX_FRAME_BYTES, type ClientKind, type RequestFrame, type RoomEvent } from '../../contracts/ipc.js';
import { RoomError } from '../../contracts/errors.js';
import { loadConfig } from '../config.js';
import { integer, nativeEvidence, optionalText, record, requireHuman, resolveCaller, text } from './validation.js';
import { ParticipantMonitor, type MonitorDeps } from './monitor.js';
import { ActivityService } from './activity.js';
import { AccountMonitor } from './accounts.js';
import type { AccountUsageProvider } from '../../contracts/account.js';
import type { ActivityCursorState, ActivityReader } from '../../observer/activity-reader.js';
import type { ActivityRequest } from '../../contracts/activity.js';
import type { UsageCursor as ObserverCursor } from '../../observer/observer.js';

const OBSERVER_CURSORS='usage-observer';
const ACTIVITY_CURSORS='activity-reader';

export class RoomService {
  readonly ledger: Ledger;
  readonly inbox: InboxStore;
  readonly dispatcher: Dispatcher;
  private listeners = new Set<(event: RoomEvent)=>void>();
  private monitor: ParticipantMonitor|null=null;
  private activity: ActivityService|null=null;
  private accounts: AccountMonitor|null=null;
  constructor(readonly root: string, private readonly adapters:DeliveryAdapter[] = []) { this.ledger = new Ledger(root);this.inbox=new InboxStore(this.ledger);this.dispatcher=new Dispatcher(root,this.ledger,adapters,event=>this.publish(event),(scope,messageId)=>this.inbox.envelopeToken(scope,messageId)); }
  /** Keep participant liveness/activity/usage current (opt-in: production enables it; tests stay hermetic). */
  /** With a workspace provider, every participant reports workspace (null = not observed yet), so /who can say so. */
  private workspaceEnabled=false;
  enableMonitor(observer:MonitorDeps['observer'],intervalMs:number,workspace?:MonitorDeps['workspace'],stopGraceMs?:number):void{
    this.workspaceEnabled=!!workspace;
    this.monitor=new ParticipantMonitor({participants:()=>this.participants(),adapters:this.adapters,observer,...(workspace?{workspace}:{}),
      save:state=>this.ledger.putParticipant(state),publish:participant=>this.publish({type:'participant.updated',participant}),
      loadCursors:()=>this.ledger.cursor<ObserverCursor[]>(OBSERVER_CURSORS)??[],saveCursors:cursors=>this.ledger.putCursor(OBSERVER_CURSORS,cursors),intervalMs,...(stopGraceMs!==undefined?{stopGraceMs}:{})});
  }
  /** Observe each participant's transcript activity (6.1; presentation only, never feeds delivery or state). */
  enableActivity(reader:ActivityReader,intervalMs:number):void{
    this.activity=new ActivityService({reader,participants:()=>this.participants(),publish:event=>this.publish(event),
      loadCursors:()=>this.ledger.cursor<ActivityCursorState[]>(ACTIVITY_CURSORS)??[],saveCursors:cursors=>this.ledger.putCursor(ACTIVITY_CURSORS,cursors),intervalMs});
  }
  /** Subscription usage once per account (6.6; presentation only, read-only providers). */
  enableAccounts(providers:AccountUsageProvider[],intervalMs:number,staleAfterMs:number,stopGraceMs?:number):void{
    this.accounts=new AccountMonitor({providers,publish:event=>this.publish(event),intervalMs,staleAfterMs,...(stopGraceMs!==undefined?{stopGraceMs}:{})});
  }
  start():void{this.dispatcher.start();this.monitor?.start();this.activity?.start();this.accounts?.start();}
  async close():Promise<void>{await Promise.all([this.accounts?.stop(),this.activity?.stop(),this.monitor?.stop()]);await this.dispatcher.stop();this.ledger.close();}
  onEvent(listener: (event:RoomEvent)=>void): ()=>void { this.listeners.add(listener);return ()=>this.listeners.delete(listener); }
  publish(event:RoomEvent): void { for(const listener of this.listeners)listener(event); }
  async handle(request:RequestFrame, client:ClientKind): Promise<unknown> {
    const p=record(request.params);
    switch(request.method) {
      case 'inbox': {
        const registry=await readRegistry(this.root);const caller=resolveCaller(p.caller,client,registry);
        if(caller.sender.kind!=='agent')throw new RoomError('bad_request','Inbox snapshots belong to agent bindings.');
        const options:Omit<InboxRequest,'caller'>={};
        if(p.snapshot!==undefined)options.snapshot=text(p.snapshot,'snapshot');
        if(p.cursor!==undefined)options.cursor=text(p.cursor,'cursor');
        if(p.limit!==undefined)options.limit=integer(p.limit,'limit',20,1);
        if(p.baseline!==undefined)options.baseline={reason:text(record(p.baseline).reason,'baseline.reason')};
        const page=this.inbox.review(caller.scope,options);this.refreshInboxDisplay();return page;
      }
      case 'guarded_send':
      case 'send': {
        const registry=await readRegistry(this.root);const caller=resolveCaller(p.caller,client,registry);
        const guarded=request.method==='guarded_send';
        if(!guarded&&caller.sender.kind==='agent')throw new RoomError('bad_request','Agent sends require guarded_send with an inbox snapshot.');
        const urgent=p.urgent===undefined?null:{reason:text(record(p.urgent).reason,'urgent.reason')};
        if(urgent&&urgent.reason.length>1000)throw new RoomError('bad_request','Urgency reason exceeds 1000 characters.');
        const snapshot=optionalText(p.snapshot,'snapshot')??undefined;
        const revisesAttemptId=optionalText(p.revisesAttemptId,'revisesAttemptId');
        if(revisesAttemptId&&!this.ledger.crossing(revisesAttemptId,caller.scope,'blocked_send'))throw new RoomError('bad_request','Revised attempt does not belong to this sender.');
        const crossing={attemptId:randomBytes(24).toString('base64url'),guard:(caller.sender.kind==='human'?'human':urgent?'urgent':'current') as 'human'|'urgent'|'current',urgent,newSinceSnapshot:caller.sender.kind==='agent'?this.inbox.uncovered(caller.scope,snapshot):null,revisesAttemptId};
        const body=text(p.body,'body');
        if(Buffer.byteLength(JSON.stringify(body),'utf8')>MAX_FRAME_BYTES/2)throw new RoomError('message_too_large','Message exceeds the room IPC body budget.');
        if(p.to!==null && p.to!==undefined && (!Array.isArray(p.to)||p.to.some(v=>typeof v!=='string')))throw new RoomError('bad_request','Recipients must be a string array.');
        const to=(p.to??[]) as string[];const requested=[...new Set(to.map(n=>n.replace(/^@/,'')))];
        if(!requested.length && caller.sender.kind==='agent')throw new RoomError('no_recipients','Agent messages require explicit recipients.');
        const broadcast=!requested.length || requested.includes('all');
        if(requested.includes('all') && requested.length!==1)throw new RoomError('bad_request','Use all alone or list specific names.');
        const identity={sender:caller.sender,senderScope:caller.scope,crossing,body,requestedRecipients:broadcast?null:requested,
          addressing:broadcast?'broadcast' as const:'direct' as const,replyTo:optionalText(p.replyTo,'replyTo'),clientMessageId:optionalText(p.clientMessageId,'clientMessageId')};
        const retry=this.ledger.findRetry(identity);if(retry){
          if(!guarded)return retry;
          const meta=retry.message.crossing;
          return {status:'sent',result:retry,attemptId:meta?.attemptId??retry.message.id,guard:meta?.guard??'legacy',newSinceSnapshot:meta?.newSinceSnapshot??null};
        }
        const recipients=broadcast ? Object.keys(registry).filter(n=>n!==caller.sender.name) : requested;
        if(!recipients.length)throw new RoomError('no_recipients','No participants are enrolled for this message.');
        const targets=recipients.map(name=>{
          if(name===HUMAN)return {name,target:null};
          const binding=Object.hasOwn(registry,name)?registry[name]:undefined;
          if(!binding)throw new RoomError('unknown_recipient',`Unknown participant: ${name}`);
          return {name,target:{harness:binding.harness,sessionId:binding.session_id}};
        });
        const saved=this.ledger.transaction(()=>{
          if(guarded&&caller.sender.kind==='agent'&&!urgent){
            const uncovered=this.inbox.uncovered(caller.scope,snapshot);
            if(uncovered!==0){
              const reason=snapshot===undefined?'snapshot_required':uncovered===null?'snapshot_invalid':'snapshot_stale';
              const inbox=this.inbox.review(caller.scope,uncovered===null?{}:{snapshot});
              const rejected:GuardedSendOutcome={status:'not_sent',reason,attemptId:crossing.attemptId,inbox,guidance:''};
              this.ledger.putCrossing(crossing.attemptId,caller.scope,'blocked_send',{reason,at:new Date().toISOString(),revisesAttemptId,remaining:inbox.remaining});
              return {result:null,replyDelivery:null,rejected};
            }
          }
          const result=this.ledger.enqueue({sender:caller.sender,senderScope:caller.scope,crossing,body,requestedRecipients:broadcast?null:requested,
            recipients:targets,addressing:broadcast?'broadcast':'direct',replyTo:optionalText(p.replyTo,'replyTo'),
            clientMessageId:optionalText(p.clientMessageId,'clientMessageId'),held:this.ledger.roomState().paused});
          let replyDelivery=null;
          if(!result.deduplicated&&result.message.replyTo&&caller.sender.kind==='agent'){
            const prior=this.ledger.deliveries(result.message.replyTo).find(d=>d.recipient===caller.sender.name&&`${d.target.harness}:${d.target.sessionId}`===caller.scope);
            if(prior)replyDelivery=this.ledger.updateDelivery(prior.messageId,prior.recipient,d=>{d.state='replied';d.repliedBy=result.message.id;d.held=false;d.waiting=null;});
          }
          return{result,replyDelivery,rejected:null};
        });
        if(saved.rejected){this.refreshInboxDisplay();return saved.rejected;}
        const {result,replyDelivery}=saved;
        if(!result.deduplicated){
          this.refreshInboxDisplay();
          this.publish({type:'message.created',message:result.message,deliveries:result.deliveries});
          if(replyDelivery)this.publish({type:'delivery.updated',delivery:replyDelivery});
          void this.dispatcher.kick();
        }
        return guarded?{status:'sent',result,attemptId:crossing.attemptId,guard:crossing.guard,newSinceSnapshot:crossing.newSinceSnapshot}:result;
      }
      case 'read': {
        const id=optionalText(p.messageId,'messageId');
        if(id){const item=this.ledger.read(id);return {items:[item],lastSeq:item.message.seq,hasMore:false};}
        const after=p.afterSeq===undefined||p.afterSeq===null?null:integer(p.afterSeq,'afterSeq',0);
        return this.ledger.list(after,Math.min(integer(p.limit,'limit',loadConfig().readPageSize,1),loadConfig().readPageSize));
      }
      case 'who': return {participants:await this.participants(),room:this.ledger.roomState(),...(this.accounts?{accounts:this.accounts.snapshot()}:{})};
      case 'join': {
        const name=text(p.name,'name');if(!isValidParticipantName(name))throw new RoomError('bad_request','Choose a valid lowercase participant name.');
        const native=nativeEvidence(p.native);const prior=await readRegistry(this.root);
        const expected=p.expectedPrevious===undefined||p.expectedPrevious===null?undefined:record(p.expectedPrevious);
        if(expected && (expected.harness!=='codex'&&expected.harness!=='claude'||typeof expected.sessionId!=='string'))throw new RoomError('bad_request','expectedPrevious must include harness and sessionId.');
        const registry=await joinParticipant(this.root,name,{harness:native.harness,session_id:native.sessionId},expected?{expectedPrevious:{harness:expected.harness as TargetSnapshot['harness'],session_id:expected.sessionId as string}}:{});
        const binding=registry[name]!;const registration={name,harness:binding.harness,sessionId:binding.session_id};
        const state=(await this.participants()).find(participant=>participant.name===name)!;
        this.ledger.putParticipant(state);this.publish({type:'participant.updated',participant:state});void this.dispatcher.kick();void this.monitor?.refresh(name);
        return {registration,created:!prior[name],rebound:!!prior[name]&&(prior[name].harness!==binding.harness||prior[name].session_id!==binding.session_id)};
      }
      case 'deliveries': return {deliveries:this.ledger.read(text(p.messageId,'messageId')).deliveries};
      case 'activity': {
        const req:ActivityRequest={participant:text(p.participant,'participant')};
        const after=p.afterSeq===undefined||p.afterSeq===null?null:integer(p.afterSeq,'afterSeq',0);
        const before=p.beforeSeq===undefined||p.beforeSeq===null?null:integer(p.beforeSeq,'beforeSeq',0);
        if(after!==null&&before!==null)throw new RoomError('bad_request','Use afterSeq or beforeSeq, not both.');
        if(after!==null)req.afterSeq=after;if(before!==null)req.beforeSeq=before;
        if(p.limit!==undefined&&p.limit!==null)req.limit=integer(p.limit,'limit',50,1);
        if(p.stream!==undefined&&p.stream!==null){const s=record(p.stream);req.stream={participant:text(s.participant,'stream.participant'),harness:s.harness==='codex'?'codex':'claude',sessionId:text(s.sessionId,'stream.sessionId'),generation:integer(s.generation,'stream.generation',1)};}
        if(!this.activity)return{stream:null,items:[],earliestSeq:null,lastSeq:null,hasMore:false,olderEvicted:false,reset:false,coverage:'unavailable',reason:'activity observation is not enabled in this service',checkedAt:null,backlog:false};
        return this.activity.page(req);
      }
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
  private inboxDisplay(scope:string) {
    const display=this.ledger.inboxDisplay(scope);if(!display)return null;
    const uncovered=this.inbox.uncovered(scope,display.snapshot);
    return uncovered===null?null:{...display,uncovered};
  }
  private refreshInboxDisplay():void {
    for(const participant of this.ledger.participants()){
      const inbox=this.inboxDisplay(`${participant.harness}:${participant.sessionId}`);
      if(JSON.stringify(participant.inbox??null)===JSON.stringify(inbox))continue;
      const updated={...participant,inbox};this.ledger.putParticipant(updated);this.publish({type:'participant.updated',participant:updated});
    }
  }
  async participants():Promise<ParticipantState[]> {
    const registry=await readRegistry(this.root);const previous=this.ledger.participants();const queued=this.ledger.queued();
    return Object.entries(registry).map(([name,binding])=>{
      const saved=previous.find(p=>p.name===name&&p.harness===binding.harness&&p.sessionId===binding.session_id);
      return {name,harness:binding.harness,sessionId:binding.session_id,inbox:this.inboxDisplay(`${binding.harness}:${binding.session_id}`),liveness:saved?.liveness??'unknown',livenessCheckedAt:saved?.livenessCheckedAt??null,
        activity:saved?.activity??'unknown',pending:queued.filter(d=>d.recipient===name).length,usage:saved?.usage??null,...(this.workspaceEnabled?{workspace:saved?.workspace??null}:saved?.workspace!==undefined?{workspace:saved.workspace}:{})};
    });
  }
}
