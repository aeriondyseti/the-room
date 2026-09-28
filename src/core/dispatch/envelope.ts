import { createHash } from 'node:crypto';
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
 const header=`[room ${room} #${message.id} ${authority} from=${message.from.name}${message.from.identity.mode==='declared'?'(declared)':''} to=${message.to.join(',')} delivery_to=${recipient} addressing=${message.addressing}${message.replyTo?` reply_to=${message.replyTo}`:''}]\n`;
 const tail=`Replies go to ${message.from.name}; don't reply just to acknowledge an acknowledgement. The human sees all room messages.`;
 const footer=`\n--\nReply via room_send({reply_to:"${message.id}",text:"..."}) or room reply ${message.id} --file <path>. ${tail}`;
 if(token!==undefined){
  const guarded=`\n--\nsnapshot: ${token} (covers this message only)\nReply via room_send({reply_to:"${message.id}",snapshot:"${token}",text:"..."}) or room reply ${message.id} --snapshot ${token} --file <path>. If anything else addressed to you is not covered, the reply comes back NOT SENT with it. ${tail}`;
  const withToken=header+message.body+guarded;
  if(withToken.length<=limit)return{text:withToken,referenced:false,snapshot:true};
 }
 const full=header+message.body+footer;
 if(full.length<=limit)return{text:full,referenced:false,snapshot:false};
 const reference=`\n[Referenced content: fetch the complete original with room_read({message_id:"${message.id}"}) or room read ${message.id}.]\n`;
 const budget=Math.min(loadConfig().oversizePreviewChars,limit-header.length-reference.length-footer.length);
 if(budget<0)throw new RoomError('message_too_large','The envelope limit cannot hold the room identifiers and fetch instruction.');
 let preview=message.body.slice(0,budget);
 if(/[\uD800-\uDBFF]$/.test(preview))preview=preview.slice(0,-1);
 return{text:header+preview+reference+footer,referenced:true,snapshot:false};
}
