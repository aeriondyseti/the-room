import type {Delivery,MessageWithDeliveries} from '../contracts/domain.js';
import type {Result} from '../contracts/ipc.js';
import {deliveryDetail} from '../presentation/delivery.js';
import {sanitize} from '../tui/format.js';

const state=(d:Delivery)=>`${d.recipient}: ${deliveryDetail(d)}`;
function message(item:MessageWithDeliveries):string {
 const m=item.message;
 return `#${m.seq} ${m.from.name}${m.from.identity.mode==='declared'?' (declared)':''} → ${m.to.join(', ')||'room'}${m.kind==='stop_request'?' [STOP REQUEST]':''}\nid: ${m.id}${m.replyTo?` · reply to ${m.replyTo}`:''}\n${m.body}${item.deliveries.length?'\nDelivery: '+item.deliveries.map(state).join('; '):''}`;
}
/** Human-readable default; --json retains the complete unchanged IPC result. */
export function formatResult(command:string,value:unknown):string {
 let text:string;
 if(command==='send'||command==='reply'){
  const r=value as Result<'send'>;const m=r.message;
  text=`${r.deduplicated?'Already recorded':'Recorded'} #${m.seq} (${m.id}) to ${m.to.join(', ')||'room'}.\nSender: ${m.from.name} (${m.from.identity.mode}; ${m.from.identity.source}).`;
  if(r.deliveries.length)text+='\nDelivery: '+r.deliveries.map(state).join('; ')+'.\nSubmitted means transport acceptance; replied means a matching room reply.';
 }else if(command==='read'){
  const r=value as Result<'read'>;text=r.items.length?r.items.map(message).join('\n\n'):'No messages.';
  if(r.hasMore)text+='\nMore history exists; use --after <message-number> to page forward.';
 }else if(command==='who'){
  const r=value as Result<'who'>;text=`Room ${r.room.paused?'PAUSED (future deliveries held)':'active'} · ${r.participants.length} agents\n`+r.participants.map(p=>`${p.name} (${p.harness}) · ${p.liveness} / ${p.activity} · ${p.pending} queued\n  ${p.sessionId}`).join('\n');
  text+='\nhuman: address the room operator as human.';
 }else if(command==='join'){
  const r=value as Result<'join'>;text=`${r.created?'Joined':r.rebound?'Rebound':'Already joined'} as ${r.registration.name} (${r.registration.harness}, ${r.registration.sessionId}).`;
 }else if(command==='pause'){
  const r=value as Result<'pause'>;text='Room paused: future deliveries are held. Stop is a request, not an enforced interrupt; a busy Codex reads it after its current turn.';
  text+=r.stopRequest?`\nStop request #${r.stopRequest.message.seq}: ${r.stopRequest.deliveries.map(state).join('; ')}`:'\nNo duplicate stop request was sent.';
 }else if(command==='resume')text=`Room resumed; ${(value as Result<'resume'>).released} held deliveries released. Rebind-needed targets remain held.`;
 else if(command==='retry')text=`Explicit retry recorded. ${state((value as Result<'retry'>).delivery)}`;
 else if(command==='shutdown')text='Room service is stopping; agents themselves are unchanged.';
 else text=JSON.stringify(value,null,2);
 return sanitize(text);
}
