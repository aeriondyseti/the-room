import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openKickProposal, voteKickProposal } from './kick-vote.js';
import type { ParticipantState } from '../../contracts/domain.js';

const astra={harness:'codex' as const,session_id:'00000000-0000-4000-8000-000000000001'};
const fable={harness:'claude' as const,session_id:'00000000-0000-4000-8000-000000000002'};
const target={harness:'claude' as const,session_id:'00000000-0000-4000-8000-000000000003'};
const registry={astra,fable,target};
const now=new Date('2026-09-28T22:00:00Z');
const observed=(name:string,liveness:ParticipantState['liveness'],checkedAt:string):ParticipantState=>({name,harness:registry[name as keyof typeof registry]!.harness,sessionId:registry[name as keyof typeof registry]!.session_id,liveness,livenessCheckedAt:checkedAt,activity:'unknown',pending:0,usage:null,inbox:null});

test('online electorate is frozen by binding; unknown and stale are shown as excluded',()=>{
  const proposal=openKickProposal(registry,[observed('astra','unknown',now.toISOString()),observed('fable','online',now.toISOString())], 'target',{harness:'codex',sessionId:astra.session_id},'stale binding',now,15_000,600_000);
  assert.deepEqual(proposal.voters.map(v=>v.name),['astra','fable']);
  assert.ok(proposal.voters[0]!.votedAt,'the authenticated proposer votes even with unknown monitor status');
  assert.equal(proposal.voters[1]!.votedAt,null);
  const voted=voteKickProposal(proposal,{harness:'claude',sessionId:fable.session_id},new Date(now.getTime()+1000));
  assert.equal(voted.voteRecorded,true);assert.equal(voted.unanimous,true);
  assert.equal(voteKickProposal(voted.proposal,{harness:'claude',sessionId:fable.session_id},new Date(now.getTime()+2000)).voteRecorded,false);
  assert.throws(()=>voteKickProposal(proposal,{harness:'claude',sessionId:target.session_id},now),{code:'identity_mismatch'});

  const excluded=openKickProposal(registry,[observed('fable','unknown',now.toISOString())], 'target',{harness:'codex',sessionId:astra.session_id},'reason',now,15_000,600_000);
  assert.deepEqual(excluded.excluded,[{name:'fable',reason:'unknown'}]);
  assert.equal(excluded.voters.length,1);
  const stale=openKickProposal(registry,[observed('fable','online',new Date(now.getTime()-31_000).toISOString())], 'target',{harness:'codex',sessionId:astra.session_id},'reason',now,15_000,600_000);
  assert.deepEqual(stale.excluded,[{name:'fable',reason:'stale'}]);
});

test('kick rejects self-target, vanished proposer, nonvoters and expired proposals',()=>{
  assert.throws(()=>openKickProposal(registry,[],'astra',{harness:'codex',sessionId:astra.session_id},'reason',now,15_000,600_000),{code:'bad_request'});
  assert.throws(()=>openKickProposal(registry,[],'target',{harness:'codex',sessionId:'00000000-0000-4000-8000-000000000099'},'reason',now,15_000,600_000),{code:'not_registered'});
  const proposal=openKickProposal(registry,[],'target',{harness:'codex',sessionId:astra.session_id},'reason',now,15_000,1000);
  assert.throws(()=>voteKickProposal(proposal,{harness:'codex',sessionId:astra.session_id},new Date(now.getTime()+1000)),{code:'invalid_state'});
});
