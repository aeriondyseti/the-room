import { createHash, randomBytes } from 'node:crypto';
import type { InboxReviewPage, InboxReviewItem, InboxRequest } from '../../contracts/crossing.js';
import { RoomError } from '../../contracts/errors.js';
import { Ledger } from './ledger.js';
import { loadConfig } from '../config.js';

interface Snapshot {
  version: 1;
  covered: string[];
  exempted: string[];
  parts: Record<string, {next:number;chunkBytes:number;digest:string}>;
}
interface Cursor { snapshot: string }
type ReviewOptions = Pick<InboxRequest,'snapshot'|'cursor'|'limit'|'baseline'>;
const id=()=>randomBytes(24).toString('base64url');
const bytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v),'utf8');

/** Service-owned coverage evidence, independent of transcript observation. All
 * operations are synchronous so eligibility and send commit share a transaction.
 */
export class InboxStore {
  constructor(private ledger:Ledger, private pageBytes=loadConfig().inboxPageBytes, private partBytes=loadConfig().inboxPartBytes) {
    if(pageBytes<8192||partBytes<4||partBytes>pageBytes/8)throw new Error('Invalid inbox byte budgets');
  }
  snapshot(scope:string,token?:string):Snapshot|null {
    if(!token||token.length>40)return null;
    const state=this.ledger.crossing<Snapshot>(token,scope,'snapshot');
    return state?.version===1?state:null;
  }
  uncovered(scope:string,token?:string):number|null {
    const state=this.snapshot(scope,token);if(!state)return null;
    const done=new Set([...state.covered,...state.exempted]);
    return this.ledger.inbox(scope).filter(i=>!done.has(i.message.id)).length;
  }
  /** Only called when the service returns the complete immutable body. */
  envelopeToken(scope:string,messageId:string):string {
    if(!this.ledger.inbox(scope).some(i=>i.message.id===messageId))throw new RoomError('not_found','Message is not addressed to this binding.');
    return this.issue(scope,{version:1,covered:[messageId],exempted:[],parts:{}});
  }
  private issue(scope:string,state:Snapshot):string {
    const token=id();this.ledger.putCrossing(token,scope,'snapshot',state);return token;
  }
  review(scope:string,options:ReviewOptions={}):InboxReviewPage {
    return this.ledger.transaction(()=>{
      const page=this.page(scope,options);
      // Display-only pointer. Eligibility NEVER reads this; it always requires
      // the token explicitly supplied on that particular send.
      this.ledger.setInboxDisplay(scope,page.snapshot);
      return page;
    });
  }
  private page(scope:string,options:ReviewOptions):InboxReviewPage {
    if(options.baseline&&(options.snapshot!==undefined||options.cursor!==undefined))throw new RoomError('bad_request','Baseline cannot be combined with snapshot or cursor.');
    if(options.limit!==undefined&&(!Number.isSafeInteger(options.limit)||options.limit<1))throw new RoomError('bad_request','Inbox limit must be a positive integer.');
    const limit=Math.min(options.limit??20,100);
    let state:Snapshot={version:1,covered:[],exempted:[],parts:{}};
    if(options.snapshot!==undefined){const found=this.snapshot(scope,options.snapshot);if(!found)throw new RoomError('bad_request','Invalid inbox snapshot.');state=structuredClone(found);}
    if(options.cursor!==undefined){
      const cursor=this.ledger.crossing<Cursor>(options.cursor,scope,'cursor');
      if(!cursor||cursor.snapshot!==options.snapshot)throw new RoomError('bad_request','Inbox cursor does not match this snapshot.');
    }
    const history=this.ledger.inbox(scope);
    if(options.baseline){
      const reason=options.baseline.reason;
      if(typeof reason!=='string'||!reason.trim()||reason.length>1000)throw new RoomError('bad_request','Baseline requires a reason of 1–1000 characters.');
      state.exempted=history.map(i=>i.message.id);
      const attemptId=id();const baseline={attemptId,exemptedCount:history.length,reason};
      this.ledger.putCrossing(attemptId,scope,'baseline',{...baseline,at:new Date().toISOString(),description:'skipped without review'});
      return {items:[],snapshot:this.issue(scope,state),hasMore:false,nextCursor:null,remaining:0,baseline};
    }
    const done=new Set([...state.covered,...state.exempted]);
    const items:InboxReviewItem[]=[];let used=1024;
    outer:for(const value of history){
      const key=value.message.id;if(done.has(key))continue;
      const full:InboxReviewItem={kind:'full_message',value};
      if(!state.parts[key]&&bytes(full)<=this.pageBytes-1024){
        if(items.length>=limit||used+bytes(full)>this.pageBytes)break;
        items.push(full);used+=bytes(full);state.covered.push(key);done.add(key);continue;
      }
      const {body,...message}=value.message;
      const bodyDigest=createHash('sha256').update(body).digest('hex');
      const progress=state.parts[key]??{next:0,chunkBytes:this.partBytes,digest:bodyDigest};
      if(progress.digest!==bodyDigest)throw new RoomError('invalid_state','Inbox body changed during review.');
      const chunks=this.chunks(body,progress.chunkBytes);
      for(let index=progress.next;index<chunks.length;index++){
        const item:InboxReviewItem={kind:'message_part',message,bodyDigest,text:chunks[index]!,partIndex:index+1,partCount:chunks.length};
        const size=bytes(item);
        if(size>this.pageBytes-1024)throw new RoomError('message_too_large','Message metadata exceeds the inbox page budget.');
        if(items.length>=limit||used+size>this.pageBytes)break outer;
        items.push(item);used+=size;state.parts[key]={...progress,next:index+1};
      }
      if(state.parts[key]?.next===chunks.length){state.covered.push(key);done.add(key);delete state.parts[key];}
    }
    const remaining=history.filter(i=>!done.has(i.message.id)).length;
    const snapshot=this.issue(scope,state);
    let nextCursor:string|null=null;
    if(remaining){nextCursor=id();this.ledger.putCrossing(nextCursor,scope,'cursor',{snapshot});}
    return {items,snapshot,hasMore:remaining>0,nextCursor,remaining};
  }
  private chunks(text:string,chunkBytes:number):string[]{
    const result:string[]=[];let part='',size=0;
    for(const ch of text){const n=Buffer.byteLength(ch,'utf8');if(size+n>chunkBytes){result.push(part);part='';size=0;}part+=ch;size+=n;}
    if(part||!result.length)result.push(part);return result;
  }
}
