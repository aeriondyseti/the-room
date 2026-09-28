import { randomUUID } from 'node:crypto';
import type { ParticipantState, TargetSnapshot } from '../../contracts/domain.js';
import type { KickExclusion, KickProposal, KickVoter } from '../../contracts/lifecycle.js';
import { RoomError } from '../../contracts/errors.js';
import type { Registry } from '../registry/registry.js';

const same=(a:TargetSnapshot,b:TargetSnapshot)=>a.harness===b.harness&&a.sessionId===b.sessionId;
const targetOf=(harness:TargetSnapshot['harness'],sessionId:string):TargetSnapshot=>({harness,sessionId});

/** Freeze the qualified electorate at opening; unknown is excluded, never called offline. */
export function openKickProposal(registry:Registry,observed:readonly ParticipantState[],targetName:string,proposer:TargetSnapshot,reason:string,now:Date,refreshMs:number,ttlMs:number):KickProposal {
  const target=registry[targetName];
  if(!target)throw new RoomError('unknown_recipient','The target is not registered; refresh room who.');
  if(!reason.trim()||reason.length>500)throw new RoomError('bad_request','Kick reason must be 1–500 characters.');
  if(!Number.isSafeInteger(refreshMs)||refreshMs<1||!Number.isSafeInteger(ttlMs)||ttlMs<1)throw new RoomError('bad_request','Invalid kick timing configuration.');
  const targetBinding=targetOf(target.harness,target.session_id);
  if(same(targetBinding,proposer))throw new RoomError('bad_request','An agent cannot kick its own binding.');
  const voters:KickVoter[]=[],excluded:KickExclusion[]=[];
  let proposerFound=false;
  for(const [name,binding] of Object.entries(registry)){
    const native=targetOf(binding.harness,binding.session_id);
    if(same(native,targetBinding))continue;
    if(same(native,proposer)){
      voters.push({name,binding:native,votedAt:now.toISOString()});proposerFound=true;continue;
    }
    const participant=observed.find(p=>p.name===name&&p.harness===native.harness&&p.sessionId===native.sessionId);
    const checked=Date.parse(participant?.livenessCheckedAt??'');
    const fresh=Number.isFinite(checked)&&checked<=now.getTime()&&now.getTime()-checked<=2*refreshMs;
    if(!fresh){excluded.push({name,reason:'stale'});continue;}
    if(participant?.liveness==='online')voters.push({name,binding:native,votedAt:null});
    else excluded.push({name,reason:participant?.liveness==='offline'?'offline':participant?.liveness==='rebind_needed'?'rebind_needed':'unknown'});
  }
  if(!proposerFound)throw new RoomError('not_registered','The proposing binding is no longer registered.');
  return {id:randomUUID(),target:{name:targetName,harness:targetBinding.harness,sessionId:targetBinding.sessionId},reason:reason.replace(/\s+/g,' ').trim(),openedAt:now.toISOString(),expiresAt:new Date(now.getTime()+ttlMs).toISOString(),voters,excluded,status:'open'};
}

/** Count one native binding's vote; names can change without transferring votes. */
export function voteKickProposal(proposal:KickProposal,voter:TargetSnapshot,now:Date):{proposal:KickProposal;voteRecorded:boolean;unanimous:boolean} {
  if(proposal.status!=='open')throw new RoomError('invalid_state','The kick proposal is no longer open.');
  if(now.getTime()>=Date.parse(proposal.expiresAt))throw new RoomError('invalid_state','The kick proposal expired; open a new one.');
  const index=proposal.voters.findIndex(v=>same(v.binding,voter));
  if(index<0)throw new RoomError('identity_mismatch','This binding is not in the proposal electorate.');
  if(proposal.voters[index]!.votedAt!==null)return{proposal,voteRecorded:false,unanimous:proposal.voters.every(v=>v.votedAt!==null)};
  const voters=proposal.voters.map((v,i)=>i===index?{...v,votedAt:now.toISOString()}:v);
  return{proposal:{...proposal,voters},voteRecorded:true,unanimous:voters.every(v=>v.votedAt!==null)};
}
