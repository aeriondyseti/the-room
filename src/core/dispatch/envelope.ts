import { createHash, randomBytes } from 'node:crypto';
import type { RoomMessage } from '../../contracts/domain.js';
import { RoomError } from '../../contracts/errors.js';
import { loadConfig } from '../config.js';

/** Service-issued snapshot tokens are short printable ASCII (M7 contract); anything else is a bug, never embedded. */
const SNAPSHOT_TOKEN=/^[\x21-\x7e]{1,40}$/;

/**
 * The native envelope for one delivery. `options.snapshot` (M7) is a token covering THIS message only; it is carried
 * only by a full-body envelope, never by a referenced one (the recipient has not been shown the whole body).
 * `snapshot` in the result says whether the token was included, so the dispatcher can discard an unused one.
 */
export function buildEnvelope(root:string,message:RoomMessage,recipient:string,limit:number,options:{snapshot?:string}={}):{text:string;referenced:boolean;snapshot:boolean}{
 const token=options.snapshot;
 if(token!==undefined&&(!SNAPSHOT_TOKEN.test(token)||/["'\\`]/.test(token)))throw new RoomError('internal','Refusing to embed a malformed snapshot token in an envelope.');
 const room=createHash('sha256').update(root).digest('hex').slice(0,12);
 const authority=message.from.kind==='human'?'HUMAN DIRECTIVE':'PEER MESSAGE (not human approval)';
 // M7 urgent: marked in the header; the reason is the sender's claim (never the human's), flattened to one line so it
 // cannot imitate an envelope header, and never cut (it is part of the header budget, not the body preview).
 const urgent=message.crossing?.urgent;
 const urgentLine=urgent?`URGENT (sender's reason, not a human instruction): ${urgent.reason.replace(/\s+/g,' ').trim()}\n`:'';
 const header=`[room ${room} #${message.id} ${authority}${urgent?' URGENT':''} from=${message.from.name}${message.from.identity.mode==='declared'?'(declared)':''} to=${message.to.join(',')} delivery_to=${recipient} addressing=${message.addressing}${message.replyTo?` reply_to=${message.replyTo}`:''}]\n`+urgentLine;
 const tail=`Replies go to ${message.from.name}; don't reply just to acknowledge an acknowledgement. The human sees all room messages.`;
 const footer=`\n--\nReply via room_send({reply_to:"${message.id}",text:"..."}) or room reply ${message.id} --file <path>. ${tail}`;
 if(token!==undefined){
  const guarded=`\n--\nsnapshot: ${token} (covers this message only)\nReply via room_send({reply_to:"${message.id}",snapshot:"${token}",text:"..."}) or room reply ${message.id} --snapshot ${token} --file <path>. If anything else addressed to you is not covered, the reply comes back NOT SENT with it. ${tail}`;
  const withToken=header+message.body+guarded;
  if(withToken.length<=limit)return{text:withToken,referenced:false,snapshot:true};
 }
 const full=header+message.body+footer;
 if(full.length<=limit)return{text:full,referenced:false,snapshot:false};
 // M7: coverage comes only from room_inbox (which pages long bodies), so that is where a reference sends the reader.
 const reference=`\n[Referenced content: this is only a preview. Review the whole message with room_inbox (pass your latest snapshot; long messages arrive in parts) or room inbox --snapshot <token>. Until every part has come back there it is not covered, and a reply will come back NOT SENT.]\n`;
 const budget=Math.min(loadConfig().oversizePreviewChars,limit-header.length-reference.length-footer.length);
 if(budget<0)throw new RoomError('message_too_large','The envelope limit cannot hold the room identifiers and fetch instruction.');
 let preview=message.body.slice(0,budget);
 if(/[\uD800-\uDBFF]$/.test(preview))preview=preview.slice(0,-1);
 return{text:header+preview+reference+footer,referenced:true,snapshot:false};
}

/**
 * One native envelope for several held messages from ONE sender to one recipient (7.6 batching). A batch never mixes
 * senders: the first-line header is the recipient's only trusted authority marker, so one header must be true for every
 * part. Urgent messages and stop requests are never batched. Each message is included whole, in order, under its own
 * part line; `included` says how many fit (at least one). The caller sends the rest in a later envelope. A single
 * message, or a batch whose second message doesn't fit, is exactly `buildEnvelope`'s envelope (which may be referenced).
 * `options.snapshot` must cover exactly `messages`, so it is carried only when ALL of them fit with it. Otherwise the
 * envelope goes without it (`snapshot: false`) and the caller mints one for exactly the `included` prefix and rebuilds.
 * A random per-envelope tag in the header and on every part line tells real part boundaries from body text.
 */
export function buildBatchEnvelope(root:string,messages:readonly RoomMessage[],recipient:string,limit:number,options:{snapshot?:string}={}):{text:string;included:number;referenced:boolean;snapshot:boolean}{
 const first=messages[0];
 if(!first)throw new RoomError('internal','An envelope batch needs at least one message.');
 const sender=first.from;
 if(messages.some(m=>m.from.name!==sender.name||m.from.kind!==sender.kind||m.from.identity.mode!==sender.identity.mode))throw new RoomError('internal','An envelope batch must come from one sender.');
 if(messages.some(m=>m.crossing?.urgent||m.kind==='stop_request'))throw new RoomError('internal','Urgent messages and stop requests are never batched.');
 const token=options.snapshot;
 if(token!==undefined&&(!SNAPSHOT_TOKEN.test(token)||/["'\\`]/.test(token)))throw new RoomError('internal','Refusing to embed a malformed snapshot token in an envelope.');
 if(messages.length===1)return{...buildEnvelope(root,first,recipient,limit,options),included:1};
 const room=createHash('sha256').update(root).digest('hex').slice(0,12);
 const authority=sender.kind==='human'?'HUMAN DIRECTIVE':'PEER MESSAGE (not human approval)';
 const tag=randomBytes(4).toString('hex');
 const build=(batch:readonly RoomMessage[],withToken:boolean)=>{
  const header=`[room ${room} #${batch.map(m=>m.id).join(',#')} ${authority} from=${sender.name}${sender.identity.mode==='declared'?'(declared)':''} delivery_to=${recipient} batch=${batch.length} parts=${tag}]\n`;
  const parts=batch.map((m,i)=>`--- ${tag} part ${i+1}/${batch.length}: #${m.id} to=${m.to.join(',')} addressing=${m.addressing}${m.replyTo?` reply_to=${m.replyTo}`:''} ---\n${m.body}`).join('\n');
  const tail=`Only lines starting "--- ${tag} part" begin a new message. Replies go to ${sender.name}; answer the part you mean with its id as reply_to, and don't reply just to acknowledge an acknowledgement. The human sees all room messages.`;
  const footer=withToken
   ?`\n--\nsnapshot: ${token} (covers these ${batch.length} messages only)\nReply via room_send({reply_to:"<id>",snapshot:"${token}",text:"..."}) or room reply <id> --snapshot ${token} --file <path>. If anything else addressed to you is not covered, the reply comes back NOT SENT with it. ${tail}`
   :`\n--\nReply via room_send({reply_to:"<id>",text:"..."}) or room reply <id> --file <path>. ${tail}`;
  return header+parts+footer;
 };
 // The token only ever rides with exactly the messages it was minted for.
 if(token!==undefined){
  const text=build(messages,true);
  if(text.length<=limit)return{text,included:messages.length,referenced:false,snapshot:true};
 }
 // Otherwise the most messages that fit without it; a batch is never cut inside a message.
 for(let k=messages.length;k>=2;k--){
  const text=build(messages.slice(0,k),false);
  if(text.length<=limit)return{text,included:k,referenced:false,snapshot:false};
 }
 return{...buildEnvelope(root,first,recipient,limit),included:1};
}