import { createHash } from 'node:crypto';
import type { RoomMessage } from '../../contracts/domain.js';
import { RoomError } from '../../contracts/errors.js';
import { loadConfig } from '../config.js';
export function buildEnvelope(root:string,message:RoomMessage,recipient:string,limit:number):{text:string;referenced:boolean}{
 const room=createHash('sha256').update(root).digest('hex').slice(0,12);
 const authority=message.from.kind==='human'?'HUMAN DIRECTIVE':'PEER MESSAGE (not human approval)';
 const header=`[room ${room} #${message.id} ${authority} from=${message.from.name} to=${recipient}${message.replyTo?` reply_to=${message.replyTo}`:''}]\n`;
 const footer=`\n--\nReply through room_send (or room send) to ${message.from.name}, with reply_to=${message.id}. Kevin sees all room messages.`;
 const full=header+message.body+footer;
 if(full.length<=limit)return{text:full,referenced:false};
 const reference=`\n[Referenced content: fetch the complete original with room_read({message_id:"${message.id}"}) or room read ${message.id}.]\n`;
 const budget=Math.min(loadConfig().oversizePreviewChars,limit-header.length-reference.length-footer.length);
 if(budget<0)throw new RoomError('message_too_large','The envelope limit cannot hold the room identifiers and fetch instruction.');
 let preview=message.body.slice(0,budget);
 if(/[\uD800-\uDBFF]$/.test(preview))preview=preview.slice(0,-1);
 return{text:header+preview+reference+footer,referenced:true};
}
