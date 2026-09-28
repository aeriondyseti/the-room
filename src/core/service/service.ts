import { randomBytes } from 'node:crypto';
import type { KickOutcome, KickProposal } from '../../contracts/lifecycle.js';
import { RoomSettings } from '../settings.js';
import { InboxStore } from '../ledger/inbox.js';
import type { GuardedSendOutcome, InboxRequest } from '../../contracts/crossing.js';
import { Dispatcher } from '../dispatch/dispatcher.js';
import type { DeliveryAdapter } from '../../contracts/adapter.js';
import { Ledger, type HumanKickIntent } from '../ledger/ledger.js';
import { joinParticipant, readRegistry, renameParticipant, removeRegistryParticipant, type Registry } from '../registry/registry.js';
import { HUMAN, SYSTEM, isValidParticipantName, type MessageWithDeliveries, type ParticipantRegistration, type ParticipantState, type TargetSnapshot } from '../../contracts/domain.js';
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
import { openKickProposal, voteKickProposal } from './kick-vote.js';

const OBSERVER_CURSORS='usage-observer';
const ACTIVITY_CURSORS='activity-reader';

export class RoomService {
  readonly ledger: Ledger;
  readonly settings: RoomSettings;
  readonly inbox: InboxStore;
  readonly dispatcher: Dispatcher;
  private listeners = new Set<(event: RoomEvent)=>void>();
  private requestTail:Promise<void>=Promise.resolve();
  private kickTimer:NodeJS.Timeout|null=null;
  private serviceStarted=false;
  private monitor: ParticipantMonitor|null=null;
  private activity: ActivityService|null=null;
  private accounts: AccountMonitor|null=null;
  constructor(readonly root: string, private readonly adapters:DeliveryAdapter[] = [],private readonly options:{sendHoldMs?:number}={}) { this.settings=new RoomSettings(root);this.ledger = new Ledger(root);this.inbox=new InboxStore(this.ledger);this.dispatcher=new Dispatcher(root,this.ledger,adapters,event=>this.publish(event),(scope,messageId)=>this.inbox.envelopeToken(scope,messageId)); }
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
  /**
   * 8.1: repair labels after a rename that did not finish, or a manual registry edit. A queued delivery whose recipient
   * name left the registry, but whose target binding is registered under another name, is relabelled to that name.
   * Nothing is redirected: the target is the same session. Returns how many deliveries moved.
   */
  async reconcile():Promise<number>{
    const registry=await readRegistry(this.root);const paused=this.ledger.roomState().paused;let moved=0;
    const byBinding=new Map(Object.entries(registry).map(([name,b])=>[`${b.harness}:${b.session_id}`,name] as const));
    for(const d of this.ledger.queued()){
      if(Object.hasOwn(registry,d.recipient))continue;
      const name=byBinding.get(`${d.target.harness}:${d.target.sessionId}`);if(!name)continue;
      for(const delivery of this.ledger.relabelQueued(d.recipient,name,d.target,paused)){this.publish({type:'delivery.updated',delivery});moved++;}
    }
    return moved;
  }
  async start():Promise<void>{await this.reconcile();await this.recoverKickProposals();this.serviceStarted=true;this.dispatcher.start();this.monitor?.start();this.activity?.start();this.accounts?.start();}
  async close():Promise<void>{this.serviceStarted=false;if(this.kickTimer)clearTimeout(this.kickTimer);await Promise.all([this.accounts?.stop(),this.activity?.stop(),this.monitor?.stop()]);await this.dispatcher.stop();this.ledger.close();}
  onEvent(listener: (event:RoomEvent)=>void): ()=>void { this.listeners.add(listener);return ()=>this.listeners.delete(listener); }
  publish(event:RoomEvent): void { for(const listener of this.listeners)listener(event); }
  /** Rename spans a registry write and a ledger relabel. Serialize room requests
   * that can observe or mutate that boundary so a send cannot enqueue an old
   * recipient after the final relabel pass.
   */
  async handle(request:RequestFrame, client:ClientKind): Promise<unknown> {
    if(!['send','guarded_send','rename','kick','join','retry','pause','resume','withdraw','inbox','who'].includes(request.method))return this.handleOne(request,client);
    return this.serialized(()=>this.handleOne(request,client));
  }
  private async serialized<T>(work:()=>Promise<T>):Promise<T> {
    const previous=this.requestTail;let release!:()=>void;
    this.requestTail=new Promise<void>(resolve=>{release=resolve;});
    await previous;
    try{return await work();}finally{release();}
  }
  private async handleOne(request:RequestFrame, client:ClientKind): Promise<unknown> {
    const p=record(request.params);
    switch(request.method) {
      case 'settings_get': return this.settings.get();
      case 'settings_update': requireHuman(p.caller,client);return this.settings.update(p.patch);
      case 'withdraw': {
        const registry=await readRegistry(this.root);const caller=resolveCaller(p.caller,client,registry);
        const messageId=text(p.messageId,'messageId');
        if(p.recipients!==undefined&&(!Array.isArray(p.recipients)||p.recipients.some(n=>typeof n!=='string')))throw new RoomError('bad_request','Withdraw recipients must be strings.');
        const result=this.ledger.withdraw(caller.scope,messageId,p.recipients as string[]|undefined);
        for(const r of result.recipients)if(r.disposition==='withdrawn')this.publish({type:'delivery.updated',delivery:this.ledger.delivery(messageId,r.recipient)});
        // Pending counts and inbox coverage for CURRENT participants only (7.8).
        await this.syncDisplay(registry,{pending:false});
        return result;
      }
      case 'inbox': {
        const registry=await readRegistry(this.root);const caller=resolveCaller(p.caller,client,registry);
        if(caller.sender.kind!=='agent')throw new RoomError('bad_request','Inbox snapshots belong to agent bindings.');
        const options:Omit<InboxRequest,'caller'>={};
        if(p.snapshot!==undefined)options.snapshot=text(p.snapshot,'snapshot');
        if(p.cursor!==undefined)options.cursor=text(p.cursor,'cursor');
        if(p.limit!==undefined)options.limit=integer(p.limit,'limit',20,1);
        if(p.baseline!==undefined)options.baseline={reason:text(record(p.baseline).reason,'baseline.reason')};
        const page=this.inbox.review(caller.scope,options);await this.syncDisplay(registry,{pending:false});return page;
      }
      case 'guarded_send':
      case 'send': {
        const registry=await readRegistry(this.root);const caller=resolveCaller(p.caller,client,registry);
        const deliverySettings=(await this.settings.get()).effective;
        const guarded=request.method==='guarded_send';
        if(!guarded&&caller.sender.kind==='agent')throw new RoomError('bad_request','Agent sends require guarded_send with an inbox snapshot.');
        const urgent=p.urgent===undefined?null:{reason:text(record(p.urgent).reason,'urgent.reason')};
        if(urgent&&urgent.reason.length>loadConfig().urgentReasonMaxChars)throw new RoomError('bad_request',`Urgency reason exceeds ${loadConfig().urgentReasonMaxChars} characters.`);
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
          if(!binding){
            const scope=this.ledger.participantAlias(name);
            const renamed=scope?Object.entries(registry).find(([,b])=>`${b.harness}:${b.session_id}`===scope)?.[0]:null;
            throw new RoomError('unknown_recipient',renamed?`${name} was renamed to ${renamed}; address the new name.`:`Unknown participant: ${name}`);
          }
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
            clientMessageId:optionalText(p.clientMessageId,'clientMessageId'),holdMs:this.options.sendHoldMs??deliverySettings.deliveryHoldMs,batchHeld:deliverySettings.batchHeld,batchMaxHoldMs:Math.max(deliverySettings.batchMaxHoldMs,this.options.sendHoldMs??0),held:this.ledger.roomState().paused});
          let replyDelivery=null;
          if(!result.deduplicated&&result.message.replyTo&&caller.sender.kind==='agent'){
            const prior=this.ledger.deliveries(result.message.replyTo).find(d=>d.recipient===caller.sender.name&&`${d.target.harness}:${d.target.sessionId}`===caller.scope);
            if(prior&&prior.state!=='withdrawn')replyDelivery=this.ledger.updateDelivery(prior.messageId,prior.recipient,d=>{d.state='replied';d.repliedBy=result.message.id;d.held=false;d.waiting=null;});
          }
          return{result,replyDelivery,rejected:null};
        });
        if(saved.rejected){await this.syncDisplay(registry,{pending:false});return saved.rejected;}
        const {result,replyDelivery}=saved;
        if(!result.deduplicated){
          await this.syncDisplay(registry,{pending:false});
          this.publish({type:'message.created',message:result.message,deliveries:result.deliveries});
          for(const delivery of result.updatedDeliveries??[])this.publish({type:'delivery.updated',delivery});
          if(replyDelivery)this.publish({type:'delivery.updated',delivery:replyDelivery});
          void this.dispatcher.kick();
        }
        const {updatedDeliveries:_,...publicResult}=result;
        return guarded?{status:'sent',result:publicResult,attemptId:crossing.attemptId,guard:crossing.guard,newSinceSnapshot:crossing.newSinceSnapshot}:publicResult;
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
      case 'rename': {
        const registry=await readRegistry(this.root);
        const caller=resolveCaller(p.caller,client,registry);
        if(caller.sender.kind==='agent'&&caller.sender.identity.mode!=='verified')throw new RoomError('identity_unresolved','Renaming requires verified native session identity.');
        const oldName=caller.sender.kind==='human'?text(p.oldName,'oldName'):caller.sender.name;
        if(caller.sender.kind==='agent'&&p.oldName!==undefined&&p.oldName!==null)throw new RoomError('bad_request','Agents rename only their own binding; omit oldName.');
        const newName=text(p.newName,'newName');
        if(!isValidParticipantName(newName))throw new RoomError('bad_request','Choose a valid, unreserved participant name.');
        const binding=registry[oldName];
        if(!binding)throw new RoomError('not_registered','The participant is no longer registered; refresh room who.');
        const target={harness:binding.harness,sessionId:binding.session_id};
        if(oldName===newName)return{oldName,registration:{name:newName,...target},relabeled:0,noticeId:null};
        const conflicts=this.ledger.relabelConflicts(oldName,newName,target);
        if(conflicts.length)throw new RoomError('invalid_state',`Rename would collide with an existing delivery for ${newName}; resolve message ${conflicts[0]} before retrying.`);
        const renamed=await renameParticipant(this.root,oldName,newName,binding);
        const moved=this.ledger.transaction(()=>{
          const previous=this.ledger.participants().find(row=>row.name===oldName&&row.harness===target.harness&&row.sessionId===target.sessionId);
          const deliveries=this.ledger.relabelQueued(oldName,newName,target,this.ledger.roomState().paused);
          if(previous)this.ledger.putParticipant({...previous,name:newName,pending:this.ledger.queued(newName).length});
          this.ledger.recordParticipantAlias(oldName,target);
          return deliveries;
        });
        const participant=(await this.participants(renamed)).find(row=>row.name===newName)!;
        this.ledger.putParticipant(participant);this.publish({type:'participant.updated',participant});
        for(const delivery of moved)this.publish({type:'delivery.updated',delivery});
        void this.dispatcher.kick();
        const noticeId=this.postSystemNotice(`${oldName} is now ${newName}.`,renamed,caller.sender.kind==='agent'?newName:null);
        return{oldName,registration:{name:newName,...target},relabeled:moved.length,noticeId};
      }
      case 'kick': {
        const registry=await readRegistry(this.root);
        const caller=resolveCaller(p.caller,client,registry);
        const name=text(p.name,'name');const reason=p.reason===undefined?null:text(p.reason,'reason');
        if(reason&&reason.length>500)throw new RoomError('bad_request','Kick reason must be 1–500 characters.');
        const binding=registry[name];if(!binding)throw new RoomError('unknown_recipient',`No registered agent named ${name}.`);
        const target={harness:binding.harness,sessionId:binding.session_id};
        const registration={name,...target};
        if(caller.sender.kind==='human'){
          const intent:HumanKickIntent={id:randomBytes(16).toString('hex'),target:registration,reason:text(reason,'reason'),createdAt:new Date().toISOString()};
          this.ledger.putHumanKickIntent(intent);
          this.scheduleKickExpiry();
          return await this.executeKick(null,registration,intent.reason,intent.id);
        }
        if(caller.sender.identity.mode!=='verified')throw new RoomError('identity_unresolved','Kick votes require verified native session identity.');
        const own=registry[caller.sender.name]!;const voter={harness:own.harness,sessionId:own.session_id};
        let proposal=this.ledger.openKickProposal(target);
        if(proposal&&proposal.voters.every(v=>v.votedAt!==null))return await this.executeKick(proposal,proposal.target,proposal.reason);
        if(proposal&&Date.parse(proposal.expiresAt)<=Date.now()){await this.expireKickProposal(proposal);proposal=null;}
        if(!proposal){
          if(!reason)throw new RoomError('bad_request','Opening a kick proposal requires a reason; later votes may omit it.');
          proposal=openKickProposal(registry,await this.participants(registry),name,voter,reason,new Date(),loadConfig().participantRefreshMs,loadConfig().kickProposalTtlMs);
          const opening=`${caller.sender.name} proposes removing ${name}: ${proposal.reason}. Voters: ${proposal.voters.map(v=>v.name).join(', ')}. ${proposal.excluded.length?`Not qualified as online: ${proposal.excluded.map(v=>`${v.name} (${v.reason})`).join(', ')}. `:''}Other listed voters may call room_kick for ${name}; expires ${proposal.expiresAt}.`;
          const notice=this.ledger.transaction(()=>{this.ledger.putKickProposal(proposal!);return this.enqueueSystemNotice(opening,registry);});
          this.publishSystemNotice(notice);this.scheduleKickExpiry();
          if(proposal.voters.every(v=>v.votedAt!==null))return await this.executeKick(proposal,registration,proposal.reason);
          return{status:'open',proposal,vote:'recorded'} satisfies KickOutcome;
        }
        const voted=voteKickProposal(proposal,voter,new Date());
        if(voted.vote!=='recorded')return{status:'open',proposal:voted.proposal,vote:voted.vote} satisfies KickOutcome;
        proposal=voted.proposal;
        const count=proposal.voters.filter(v=>v.votedAt!==null).length;
        const notice=this.ledger.transaction(()=>{this.ledger.putKickProposal(proposal!);return this.enqueueSystemNotice(`${caller.sender.name} agreed to remove ${name} (${count}/${proposal!.voters.length} votes).`,registry);});
        this.publishSystemNotice(notice);
        if(voted.unanimous)return await this.executeKick(proposal,proposal.target,proposal.reason);
        return{status:'open',proposal,vote:'recorded'} satisfies KickOutcome;
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
  /** The caller can commit this together with a proposal before publishing it. */
  private enqueueSystemNotice(body:string,registry:Registry,exclude:string|null=null):MessageWithDeliveries {
    const names=Object.keys(registry).filter(name=>name!==exclude);
    return this.ledger.enqueue({sender:{name:SYSTEM,kind:'system',identity:{mode:'system',source:'service'}},senderScope:SYSTEM,
      body,requestedRecipients:[...names,HUMAN],recipients:[...names.map(name=>({name,target:{harness:registry[name]!.harness,sessionId:registry[name]!.session_id}})),{name:HUMAN,target:null}],
      addressing:'direct',kind:'system',held:this.ledger.roomState().paused});
  }
  private publishSystemNotice(result:MessageWithDeliveries):void {
    this.publish({type:'message.created',message:result.message,deliveries:result.deliveries});
    if(this.serviceStarted)void this.dispatcher.kick();
  }
  /** Renames remain valid if their informational notice fails after registry commit. */
  private postSystemNotice(body:string,registry:Registry,exclude:string|null=null):string|null {
    try{const result=this.enqueueSystemNotice(body,registry,exclude);this.publishSystemNotice(result);return result.message.id;}
    catch{return null;}
  }
  private scheduleKickExpiry():void {
    if(this.kickTimer)clearTimeout(this.kickTimer);
    const now=Date.now();
    const retryAt=now+Math.max(1000,loadConfig().dispatchPollMs);
    const next=this.ledger.openKickProposals().reduce((min,p)=>Math.min(min,p.voters.every(v=>v.votedAt!==null)?retryAt:Date.parse(p.expiresAt)),this.ledger.humanKickIntents().length?retryAt:Number.POSITIVE_INFINITY);
    if(!Number.isFinite(next)){this.kickTimer=null;return;}
    this.kickTimer=setTimeout(()=>{this.kickTimer=null;void this.serialized(()=>this.recoverKickProposals()).catch(()=>this.scheduleKickExpiry());},Math.min(2_147_483_647,Math.max(1,next-Date.now())));
    this.kickTimer.unref();
  }
  private async expireKickProposal(proposal:KickProposal):Promise<void> {
    if(proposal.status!=='open')return;
    const registry=await readRegistry(this.root);
    const expired:KickProposal={...proposal,status:'expired'};
    const notice=this.ledger.transaction(()=>{this.ledger.putKickProposal(expired);return this.enqueueSystemNotice(`Kick proposal for ${proposal.target.name} expired without every listed vote.`,registry);});
    this.publishSystemNotice(notice);
    this.scheduleKickExpiry();
  }
  private async recoverKickProposals():Promise<void> {
    for(const intent of this.ledger.humanKickIntents()){
      try{await this.executeKick(null,intent.target,intent.reason,intent.id);}catch{/* Keep the intent for the next recovery attempt. */}
    }
    for(const proposal of this.ledger.openKickProposals()){
      if(proposal.voters.every(v=>v.votedAt!==null)){
        try{await this.executeKick(proposal,proposal.target,proposal.reason);}catch{/* Keep the approved proposal for the next recovery attempt. */}
      }
      else if(Date.parse(proposal.expiresAt)<=Date.now())await this.expireKickProposal(proposal);
    }
    this.scheduleKickExpiry();
  }
  private async executeKick(proposal:KickProposal|null,target:ParticipantRegistration,reason:string,humanIntentId:string|null=null):Promise<KickOutcome> {
    const superseded=proposal?null:this.ledger.openKickProposal({harness:target.harness,sessionId:target.sessionId});
    let registry=await readRegistry(this.root);
    const same=(b:{harness:string;session_id:string})=>b.harness===target.harness&&b.session_id===target.sessionId;
    // An explicit human decision follows the native binding if it was renamed
    // while the service was down; a proposal's frozen target does not.
    const currentName=Object.entries(registry).find(([,b])=>same(b))?.[0];
    if(humanIntentId&&currentName)target={...target,name:currentName};
    let bound=registry[target.name];
    if(bound&&!same(bound)){
      if(proposal)await this.expireKickProposal(proposal);
      if(!humanIntentId)throw new RoomError('rebind_conflict','Target binding changed during voting; open a new proposal.');
      bound=undefined; // The intended binding is already absent; never remove its replacement.
    }
    if(!bound){
      if(!proposal&&!humanIntentId)throw new RoomError('not_registered','The target is no longer registered.');
      if(Object.values(registry).some(same)){
        if(proposal)await this.expireKickProposal(proposal);
        throw new RoomError('rebind_conflict','Target changed its name during voting; open a new proposal.');
      }
    }else registry=await removeRegistryParticipant(this.root,target.name,{harness:target.harness,session_id:target.sessionId});
    // The native handoff may already be underway. It settles under the old label;
    // only rows still queued afterward can receive a broker cancellation tombstone.
    if(this.serviceStarted)await this.dispatcher.settleRecipient(target.name);
    const cancelled=this.ledger.transaction(()=>{
      const rows=this.ledger.kickQueued({harness:target.harness,sessionId:target.sessionId});
      if(proposal)this.ledger.putKickProposal({...proposal,status:'executed'});
      if(superseded)this.ledger.putKickProposal({...superseded,status:'executed'});
      if(humanIntentId)this.ledger.deleteHumanKickIntent(humanIntentId);
      return rows;
    });
    await this.participants(registry);
    for(const delivery of cancelled)this.publish({type:'delivery.updated',delivery});
    const voters=proposal?proposal.voters.filter(v=>v.votedAt!==null).map(v=>v.name).join(', '):'human';
    const noticeId=this.postSystemNotice(`${target.name} was removed from the room by ${voters}. Reason: ${reason.replace(/\s+/g,' ').trim()}. Queued deliveries cancelled: ${cancelled.length}.`,registry);
    this.scheduleKickExpiry();
    return{status:'executed',proposal:proposal?{...proposal,status:'executed'}:null,removed:target,cancelled:cancelled.length,noticeId,vote:proposal?'recorded':'human'};
  }
  private inboxDisplay(scope:string) {
    const display=this.ledger.inboxDisplay(scope);if(!display)return null;
    const uncovered=this.inbox.uncovered(scope,display.snapshot);
    return uncovered===null?null:{...display,uncovered};
  }
  /**
   * Publish participant rows whose derived display (inbox coverage, pending count) changed. Only CURRENT registry
   * participants are considered (7.8): a name that left the registry is never republished, so it cannot come back
   * as a ghost after a TUI restart. New or rebound rows are introduced by the monitor, not here.
   */
  private async syncDisplay(registry:Registry|undefined,fields:{pending:boolean}):Promise<void> {
    const saved=new Map(this.ledger.participants().map(p=>[p.name,p] as const));
    for(const participant of await this.participants(registry)){
      const prev=saved.get(participant.name);
      if(!prev||prev.harness!==participant.harness||prev.sessionId!==participant.sessionId)continue;
      // Pending is otherwise the dispatcher's to publish (as it claims and settles), so only withdraw recomputes it here.
      const pending=fields.pending?participant.pending:prev.pending;
      if(JSON.stringify(prev.inbox??null)===JSON.stringify(participant.inbox)&&prev.pending===pending)continue;
      const updated={...prev,inbox:participant.inbox,pending};
      this.ledger.putParticipant(updated);this.publish({type:'participant.updated',participant:updated});
    }
  }
  /**
   * Registry-driven participant states: the registry is the truth for WHO is in the room. Ledger rows for names no
   * longer in it (a rename, a removed section) are pruned here and announced once with `participant.removed` (7.8);
   * this is the only emitter of that event. A rebound name is not "removed": its row is simply superseded.
   */
  async participants(registry?:Registry):Promise<ParticipantState[]> {
    registry??=await readRegistry(this.root);const previous=this.ledger.participants();const queued=this.ledger.queued();
    for(const stale of previous){
      if(Object.hasOwn(registry,stale.name))continue;
      this.ledger.removeParticipant(stale.name);this.publish({type:'participant.removed',name:stale.name});
    }
    return Object.entries(registry).map(([name,binding])=>{
      const saved=previous.find(p=>p.name===name&&p.harness===binding.harness&&p.sessionId===binding.session_id);
      return {name,harness:binding.harness,sessionId:binding.session_id,inbox:this.inboxDisplay(`${binding.harness}:${binding.session_id}`),liveness:saved?.liveness??'unknown',livenessCheckedAt:saved?.livenessCheckedAt??null,
        activity:saved?.activity??'unknown',pending:queued.filter(d=>d.recipient===name).length,usage:saved?.usage??null,...(this.workspaceEnabled?{workspace:saved?.workspace??null}:saved?.workspace!==undefined?{workspace:saved.workspace}:{})};
    });
  }
}
