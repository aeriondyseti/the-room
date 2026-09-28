import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Delivery, DeliveryAttempt, MessageWithDeliveries, ParticipantRegistration, ParticipantState, RoomMessage, RoomState, Sender, TargetSnapshot } from '../../contracts/domain.js';
import { HUMAN } from '../../contracts/domain.js';
import { loadConfig } from '../config.js';
import type { WithdrawOutcome, WithdrawDisposition } from '../../contracts/crossing.js';
import type { KickProposal } from '../../contracts/lifecycle.js';
import { RoomError } from '../../contracts/errors.js';

export interface EnqueueInput {
  sender: Sender;
  /** Native identity (harness + session id), or human; never just the mutable participant name. */
  senderScope: string;
  body: string;
  /** Original addressing intent, before expanding the registry; stable across retries/rebinds. */
  requestedRecipients: string[] | null;
  /** Null target means the reserved human recipient only; offline agents retain their native target. */
  recipients: { name: string; target: TargetSnapshot | null }[];
  addressing: 'broadcast' | 'direct';
  replyTo?: string | null;
  kind?: RoomMessage['kind'];
  clientMessageId?: string | null;
  held?: boolean;
  holdMs?: number;
  batchHeld?: boolean;
  batchMaxHoldMs?: number;
  crossing?: RoomMessage['crossing'];
}
export interface UsageCursor { source: string; offset: number; identity: string; updatedAt: string }
/** A human removal survives a crash between the registry CAS and delivery tombstones. */
export interface HumanKickIntent { id:string; target:ParticipantRegistration; reason:string; createdAt:string }
interface MessageRow { seq: number; id: string; payload: string; fingerprint: string }
interface DeliveryRow { payload: string }

/** Synchronous storage owned by one service. No harness code or delivery side effects live here. */
export class Ledger {
  private readonly db: DatabaseSync;
  readonly file: string;
  private transactionDepth = 0;
  constructor(root: string) {
    mkdirSync(path.join(root, '.room'), { recursive: true });
    this.file = path.join(root, '.room', 'room.db');
    this.db = new DatabaseSync(this.file);
    try {
      const waitMs = loadConfig().sqliteBusyTimeoutMs;
      if (!Number.isSafeInteger(waitMs) || waitMs > 2_147_483_647) throw new RoomError('bad_request', 'SQLite busy timeout exceeds its supported range.');
      this.db.exec(`PRAGMA busy_timeout = ${waitMs}`);
      const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (version.user_version > 2) throw new RoomError('unsupported_version', 'Room database was created by a newer version.');
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      if(version.user_version===1){
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE deliveries_v2 (
            message_id TEXT NOT NULL REFERENCES messages(id), recipient TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('queued','submitted','replied','failed','uncertain','withdrawn')),
            held INTEGER NOT NULL CHECK(held IN (0,1)), payload TEXT NOT NULL, PRIMARY KEY(message_id,recipient));
          INSERT INTO deliveries_v2 SELECT * FROM deliveries;
          DROP TABLE deliveries;
          ALTER TABLE deliveries_v2 RENAME TO deliveries;
          PRAGMA user_version=2;
          COMMIT;`);
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          sender_scope TEXT NOT NULL, client_key TEXT, fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
          UNIQUE(sender_scope, client_key)
        );
        CREATE TABLE IF NOT EXISTS deliveries (
          message_id TEXT NOT NULL REFERENCES messages(id), recipient TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('queued','submitted','replied','failed','uncertain','withdrawn')),
          held INTEGER NOT NULL CHECK(held IN (0,1)), payload TEXT NOT NULL,
          PRIMARY KEY(message_id, recipient)
        );
        CREATE INDEX IF NOT EXISTS delivery_order ON deliveries(recipient,state);
        CREATE TABLE IF NOT EXISTS participants (name TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS participant_aliases (old_name TEXT PRIMARY KEY, native_scope TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS kick_proposals (id TEXT PRIMARY KEY, target_scope TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS kick_open_target ON kick_proposals(target_scope) WHERE status='open';
        CREATE TABLE IF NOT EXISTS human_kick_intents (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS usage_cursors (name TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS crossing_records (id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS crossing_display (scope TEXT PRIMARY KEY, snapshot TEXT NOT NULL, checked_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS room_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
        INSERT OR IGNORE INTO room_state VALUES(1,'{"paused":false,"pausedAt":null,"stopRequestId":null}');
        PRAGMA user_version = 2;
      `);
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }

  /** Persisted opaque capabilities and audit entries. Scope is a native binding,
   * never a mutable display name. Records are immutable once issued.
   */
  putCrossing(id: string, scope: string, kind: string, value: unknown): void {
    this.db.prepare('INSERT INTO crossing_records(id,scope,kind,payload) VALUES(?,?,?,?)').run(id,scope,kind,JSON.stringify(value));
  }
  crossing<T>(id: string, scope: string, kind: string): T | null {
    const row=this.db.prepare('SELECT payload FROM crossing_records WHERE id=? AND scope=? AND kind=?').get(id,scope,kind) as {payload:string}|undefined;
    return row ? JSON.parse(row.payload) as T : null;
  }
  discardCrossing(id:string,scope:string,kind:string):void {
    this.db.prepare('DELETE FROM crossing_records WHERE id=? AND scope=? AND kind=?').run(id,scope,kind);
  }
  /** Addressed history follows the frozen native target even after a name rebind. */
  inbox(scope: string): MessageWithDeliveries[] {
    const rows=this.db.prepare(`SELECT DISTINCT m.id,m.seq FROM messages m JOIN deliveries d ON d.message_id=m.id
      WHERE json_extract(d.payload,'$.target.harness') || ':' || json_extract(d.payload,'$.target.sessionId') = ? AND m.sender_scope<>? AND d.state<>'withdrawn' ORDER BY m.seq`).all(scope,scope) as {id:string;seq:number}[];
    return rows.map(row=>this.read(row.id));
  }
  setInboxDisplay(scope:string,snapshot:string):void {
    this.db.prepare('INSERT INTO crossing_display(scope,snapshot,checked_at) VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET snapshot=excluded.snapshot,checked_at=excluded.checked_at').run(scope,snapshot,new Date().toISOString());
  }
  inboxDisplay(scope:string):{snapshot:string;checkedAt:string}|null {
    const row=this.db.prepare('SELECT snapshot,checked_at FROM crossing_display WHERE scope=?').get(scope) as {snapshot:string;checked_at:string}|undefined;
    return row?{snapshot:row.snapshot,checkedAt:row.checked_at}:null;
  }

  /** All callbacks are synchronous. Savepoints keep caught nested failures from partially committing. */
  transaction<T>(operation: () => T): T {
    const level = this.transactionDepth++;
    const savepoint = `room_tx_${level}`;
    try {
      this.db.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
      try {
        const result = operation();
        if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Ledger transactions must be synchronous.');
        this.db.exec(level === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        this.db.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw error;
      }
    } finally { this.transactionDepth--; }
  }

  enqueue(input: EnqueueInput): MessageWithDeliveries & { deduplicated: boolean; updatedDeliveries?:Delivery[] } {
    if (!input.senderScope || !input.body.trim()) throw new RoomError('bad_request', 'Sender scope and message body are required.');
    const key = input.clientMessageId ?? null;
    if (key !== null && !key.trim()) throw new RoomError('bad_request', 'client_message_id cannot be empty.');
    const fingerprint = this.fingerprint(input);
    return this.transaction(() => {
      if (key !== null) {
        const previous = this.db.prepare('SELECT seq,id,payload,fingerprint FROM messages WHERE sender_scope=? AND client_key=?').get(input.senderScope, key) as unknown as MessageRow | undefined;
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new RoomError('dedup_conflict', 'client_message_id was already used with different content.');
          return { ...this.read(previous.id), deduplicated: true };
        }
      }
      if (input.replyTo && !this.db.prepare('SELECT id FROM messages WHERE id=?').get(input.replyTo)) throw new RoomError('not_found', 'Reply target does not exist in this room.');
      const now = new Date().toISOString();
      const message: RoomMessage = {
        id: `m-${Date.now().toString(36)}-${randomUUID()}`, seq: 0, createdAt: now,
        from: structuredClone(input.sender), to: input.recipients.map(r => r.name),
        addressing: input.addressing, replyTo: input.replyTo ?? null, kind: input.kind ?? 'chat',
        body: input.body, clientMessageId: key,
        ...(input.crossing ? {crossing:structuredClone(input.crossing)} : {}),
      };
      const inserted = this.db.prepare('INSERT INTO messages(id,sender_scope,client_key,fingerprint,payload) VALUES(?,?,?,?,?)').run(message.id, input.senderScope, key, fingerprint, JSON.stringify(message));
      message.seq = Number(inserted.lastInsertRowid);
      this.db.prepare('UPDATE messages SET payload=? WHERE id=?').run(JSON.stringify(message), message.id);
      const updatedDeliveries:Delivery[]=[];
      for (const recipient of input.recipients) {
        if (!recipient.target) {
          if (recipient.name !== HUMAN) throw new RoomError('bad_request', 'Only the human recipient may omit a native delivery target.');
          continue;
        }
        const ordinary=!input.crossing?.urgent&&(input.kind??'chat')==='chat';
        const holdMs=input.holdMs??0;
        if(!Number.isSafeInteger(holdMs)||holdMs<0||holdMs>60000)throw new RoomError('bad_request','Invalid delivery hold.');
        const maxHoldMs=input.batchMaxHoldMs??holdMs;
        if(!Number.isSafeInteger(maxHoldMs)||maxHoldMs<holdMs||maxHoldMs>60000)throw new RoomError('bad_request','Invalid batch maximum hold.');
        let burst:Delivery['burst'];
        let notBefore=ordinary&&holdMs>0?new Date(Date.parse(now)+holdMs).toISOString():undefined;
        if(ordinary&&holdMs>0&&input.batchHeld){
          // Inspect the actual last addressed row, including terminal/urgent rows:
          // a different sender or an intervening claim must end the burst.
          const row=this.db.prepare('SELECT d.payload,m.sender_scope FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.recipient=? ORDER BY m.seq DESC LIMIT 1').get(recipient.name) as {payload:string;sender_scope:string}|undefined;
          const prior:Delivery|undefined=row?JSON.parse(row.payload):undefined;
          if(prior?.burst&&prior.state==='queued'&&!prior.attempts.length&&row!.sender_scope===input.senderScope&&
             prior.target.harness===recipient.target.harness&&prior.target.sessionId===recipient.target.sessionId&&
             prior.burst.holdMs===holdMs&&prior.burst.maxHoldMs===maxHoldMs&&Date.parse(prior.notBefore??'')>Date.parse(now)&&
             JSON.stringify(this.read(prior.messageId).message.from)===JSON.stringify(message.from)){
            burst=prior.burst;
            notBefore=new Date(Math.min(Date.parse(now)+holdMs,Date.parse(burst.startedAt)+maxHoldMs)).toISOString();
            for(const sibling of this.queued(recipient.name))if(sibling.burst?.id===burst.id&&!sibling.attempts.length){
              updatedDeliveries.push(this.updateDelivery(sibling.messageId,sibling.recipient,d=>{d.notBefore=notBefore;}));
            }
          }else burst={id:randomUUID(),startedAt:now,holdMs,maxHoldMs};
        }
        const delivery: Delivery = {
          messageId: message.id, recipient: recipient.name, target: structuredClone(recipient.target),
          state: 'queued', held: input.held ?? false, waiting: null, repliedBy: null,
          ...(notBefore?{notBefore}:{}),...(burst?{burst}:{}),
          priority:input.crossing?.urgent?'urgent':'normal',
          referenced: false, attempts: [], updatedAt: now,
        };
        this.db.prepare('INSERT INTO deliveries(message_id,recipient,state,held,payload) VALUES(?,?,?,?,?)').run(message.id, recipient.name, delivery.state, Number(delivery.held), JSON.stringify(delivery));
      }
      return { ...this.read(message.id), deduplicated: false, updatedDeliveries };
    });
  }

  private fingerprint(input: Pick<EnqueueInput, 'sender' | 'body' | 'requestedRecipients' | 'addressing' | 'replyTo' | 'kind' | 'crossing'>): string {
    return JSON.stringify({ senderKind:input.sender.kind, body:input.body,
      requestedRecipients:input.requestedRecipients===null?null:[...new Set(input.requestedRecipients)].sort(),
      addressing:input.addressing,replyTo:input.replyTo??null,kind:input.kind??'chat',...(input.crossing?.urgent?{urgent:input.crossing.urgent}:{}) });
  }
  /** Check a retry before resolving current recipients, which may have left since the original send. */
  findRetry(input: Pick<EnqueueInput, 'sender' | 'senderScope' | 'body' | 'requestedRecipients' | 'addressing' | 'replyTo' | 'kind' | 'clientMessageId' | 'crossing'>): (MessageWithDeliveries & {deduplicated:true}) | null {
    if(input.clientMessageId===null||input.clientMessageId===undefined)return null;
    const previous=this.db.prepare('SELECT id,fingerprint FROM messages WHERE sender_scope=? AND client_key=?').get(input.senderScope,input.clientMessageId) as {id:string;fingerprint:string}|undefined;
    if(!previous)return null;
    if(previous.fingerprint!==this.fingerprint(input))throw new RoomError('dedup_conflict','client_message_id was already used with different content.');
    return {...this.read(previous.id),deduplicated:true};
  }

  read(id: string): MessageWithDeliveries {
    const row = this.db.prepare('SELECT seq,id,payload,fingerprint FROM messages WHERE id=?').get(id) as unknown as MessageRow | undefined;
    if (!row) throw new RoomError('not_found', 'Message not found in this room.');
    return { message: JSON.parse(row.payload) as RoomMessage, deliveries: this.deliveries(id) };
  }
  list(afterSeq: number | null, limit: number): { items: MessageWithDeliveries[]; lastSeq: number; hasMore: boolean } {
    if (!Number.isSafeInteger(limit) || limit < 1 || (afterSeq !== null && (!Number.isSafeInteger(afterSeq) || afterSeq < 0))) throw new RoomError('bad_request', 'Page limit and cursor must be nonnegative integers; limit must be positive.');
    const rows = (afterSeq === null
      ? this.db.prepare('SELECT seq,id FROM messages ORDER BY seq DESC LIMIT ?').all(limit + 1)
      : this.db.prepare('SELECT seq,id FROM messages WHERE seq>? ORDER BY seq ASC LIMIT ?').all(afterSeq, limit + 1)) as unknown as {seq: number; id: string}[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit); if (afterSeq === null) page.reverse();
    return { items: page.map(row => this.read(row.id)), lastSeq: page.at(-1)?.seq ?? afterSeq ?? 0, hasMore };
  }
  deliveries(messageId: string): Delivery[] {
    return (this.db.prepare('SELECT payload FROM deliveries WHERE message_id=? ORDER BY recipient').all(messageId) as unknown as DeliveryRow[]).map(row => JSON.parse(row.payload) as Delivery);
  }
  delivery(messageId: string, recipient: string): Delivery {
    const found=this.findDelivery(messageId,recipient);
    if (!found) throw new RoomError('not_found', 'Delivery not found in this room.');
    return found;
  }
  /** A rename may move a queued row while the old dispatcher worker awaits a probe. */
  findDelivery(messageId:string,recipient:string):Delivery|null {
    const row=this.db.prepare('SELECT payload FROM deliveries WHERE message_id=? AND recipient=?').get(messageId,recipient) as unknown as DeliveryRow|undefined;
    return row?JSON.parse(row.payload) as Delivery:null;
  }
  unfinishedAttempts(): Delivery[] {
    return (this.db.prepare("SELECT payload FROM deliveries WHERE json_extract(payload,'$.attempts[#-1].outcome')='in_flight'").all() as unknown as DeliveryRow[]).map(row=>JSON.parse(row.payload) as Delivery);
  }
  queued(recipient?: string): Delivery[] {
    return (this.db.prepare(`SELECT d.payload FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.state='queued' ${recipient === undefined ? '' : 'AND d.recipient=?'} ORDER BY CASE WHEN COALESCE(json_extract(d.payload,'$.priority'),CASE WHEN json_type(m.payload,'$.crossing.urgent')='object' THEN 'urgent' ELSE 'normal' END)='urgent' THEN 0 ELSE 1 END,m.seq,d.recipient`).all(...(recipient === undefined ? [] : [recipient])) as unknown as DeliveryRow[]).map(row => JSON.parse(row.payload) as Delivery);
  }
  withdraw(scope:string,messageId:string,recipients?:string[]):WithdrawOutcome {
    return this.transaction(()=>{
      const owner=this.db.prepare('SELECT sender_scope FROM messages WHERE id=?').get(messageId) as {sender_scope:string}|undefined;
      if(!owner)throw new RoomError('not_found','Message not found.');
      if(owner.sender_scope!==scope)throw new RoomError('identity_mismatch','Only the original sender can withdraw this message.');
      const item=this.read(messageId);
      // Delivery rows are the truth for who holds a delivery now (a relabelled row lives under its new name; 8.1);
      // the message's `to` list is history. The human has no row.
      const current=this.deliveries(messageId).map(d=>d.recipient);
      // In the message's own order, then any row relabelled to a name the message never listed.
      const known=[...item.message.to.filter(n=>n===HUMAN||current.includes(n)),...current.filter(n=>!item.message.to.includes(n))];
      const targets=recipients??known;
      if(!targets.length||new Set(targets).size!==targets.length||targets.some(n=>!known.includes(n)))throw new RoomError('bad_request',`Withdraw recipients must be distinct current recipients of this message (${known.join(', ')||'none'}).`);
      return {messageId,recipients:targets.map(recipient=>{
        let disposition:WithdrawDisposition;
        if(recipient===HUMAN)disposition='already_visible';
        else{
          const d=this.delivery(messageId,recipient);
          if(d.state==='withdrawn')disposition='already_withdrawn';
          else if(d.state==='replied')disposition='replied';
          else if(d.attempts.at(-1)?.outcome==='in_flight')disposition='already_submitting';
          else if(d.state==='submitted'||d.attempts.some(a=>a.outcome==='submitted'))disposition='submitted';
          else if(d.state==='uncertain'||d.attempts.some(a=>a.outcome==='uncertain'))disposition='uncertain';
          else{
            this.updateDelivery(messageId,recipient,value=>{value.state='withdrawn';value.withdrawnAt=new Date().toISOString();value.withdrawalCause='sender';value.held=false;value.waiting=null;});
            disposition='withdrawn';
          }
        }
        return {recipient,disposition};
      })};
    });
  }
  /**
   * 8.1/8.2: move QUEUED deliveries addressed to `from` whose target is `target` under the name `to`. The target
   * snapshot never changes (invariant 5): only the label does. A stale rebind wait is cleared, because the binding is
   * registered again under the new name. Submitted, uncertain, in-flight and terminal rows stay as history.
   *
   * Run it only while the dispatcher is stopped or the old name's worker is quiesced (8.1 calls it before the
   * dispatcher starts): a worker that has selected a queued row but not yet claimed it would find the row gone
   * (TD-0041; 8.2's live rename must drain the old name's worker first or make that path tolerant).
   */
  relabelQueued(from:string,to:string,target:Delivery['target'],paused:boolean):Delivery[] {
    return this.transaction(()=>{
      const rows=this.queued(from).filter(d=>d.target.harness===target.harness&&d.target.sessionId===target.sessionId&&d.attempts.at(-1)?.outcome!=='in_flight');
      const moved:Delivery[]=[];
      for(const d of rows){
        if(this.db.prepare('SELECT 1 FROM deliveries WHERE message_id=? AND recipient=?').get(d.messageId,to))continue;
        const next:Delivery={...d,recipient:to,updatedAt:new Date().toISOString()};
        // A cleared rebind wait follows the pause like a fresh enqueue would, except stop requests, which pause
        // never holds.
        if(next.waiting==='rebind_needed'){next.waiting=null;next.held=paused&&this.read(d.messageId).message.kind!=='stop_request';}
        this.db.prepare('UPDATE deliveries SET recipient=?,held=?,payload=? WHERE message_id=? AND recipient=?').run(to,Number(next.held),JSON.stringify(next),d.messageId,from);
        moved.push(next);
      }
      return moved;
    });
  }
  relabelConflicts(from:string,to:string,target:Delivery['target']):string[] {
    return this.queued(from).filter(d=>d.target.harness===target.harness&&d.target.sessionId===target.sessionId&&
      d.attempts.at(-1)?.outcome!=='in_flight'&&this.findDelivery(d.messageId,to)!==null).map(d=>d.messageId);
  }
  kickQueued(target:Delivery['target']):Delivery[] {
    // A name may be reused during crash recovery. Cancel by the frozen native
    // binding across labels, never by whichever session owns the label now.
    return this.transaction(()=>this.queued().filter(d=>d.target.harness===target.harness&&d.target.sessionId===target.sessionId&&d.attempts.at(-1)?.outcome!=='in_flight')
      .map(d=>this.updateDelivery(d.messageId,d.recipient,value=>{value.state='withdrawn';value.withdrawnAt=new Date().toISOString();value.withdrawalCause='kick';value.held=false;value.waiting=null;})));
  }
  recordParticipantAlias(oldName:string,target:Delivery['target']):void {
    this.db.prepare('INSERT INTO participant_aliases(old_name,native_scope) VALUES(?,?) ON CONFLICT(old_name) DO UPDATE SET native_scope=excluded.native_scope').run(oldName,`${target.harness}:${target.sessionId}`);
  }
  participantAlias(oldName:string):string|null {
    const row=this.db.prepare('SELECT native_scope FROM participant_aliases WHERE old_name=?').get(oldName) as {native_scope:string}|undefined;
    return row?.native_scope??null;
  }
  /** Proposal records are durable; a unanimous open record can be completed after service restart. */
  putKickProposal(proposal:KickProposal):void {
    const scope=`${proposal.target.harness}:${proposal.target.sessionId}`;
    this.db.prepare('INSERT INTO kick_proposals(id,target_scope,status,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload').run(proposal.id,scope,proposal.status,JSON.stringify(proposal));
  }
  openKickProposal(target:Delivery['target']):KickProposal|null {
    const row=this.db.prepare("SELECT payload FROM kick_proposals WHERE target_scope=? AND status='open'").get(`${target.harness}:${target.sessionId}`) as {payload:string}|undefined;
    return row?JSON.parse(row.payload) as KickProposal:null;
  }
  openKickProposals():KickProposal[] {
    return (this.db.prepare("SELECT payload FROM kick_proposals WHERE status='open'").all() as {payload:string}[]).map(row=>JSON.parse(row.payload) as KickProposal);
  }
  putHumanKickIntent(intent:HumanKickIntent):void {
    this.db.prepare('INSERT INTO human_kick_intents(id,payload) VALUES(?,?)').run(intent.id,JSON.stringify(intent));
  }
  humanKickIntents():HumanKickIntent[] {
    return (this.db.prepare('SELECT payload FROM human_kick_intents').all() as {payload:string}[]).map(row=>JSON.parse(row.payload) as HumanKickIntent);
  }
  deleteHumanKickIntent(id:string):void {
    this.db.prepare('DELETE FROM human_kick_intents WHERE id=?').run(id);
  }
  /** Update mutable state only; message, recipient and target snapshot cannot be replaced. */
  updateDelivery(messageId: string, recipient: string, update: (delivery: Delivery) => void): Delivery {
    return this.transaction(() => {
      const delivery = this.delivery(messageId, recipient);
      const frozen = JSON.stringify([delivery.messageId, delivery.recipient, delivery.target]);
      const oldAttempts = structuredClone(delivery.attempts);
      const withdrawn=delivery.state==='withdrawn'?JSON.stringify(delivery):null;
      update(delivery);
      if(withdrawn!==null&&JSON.stringify(delivery)!==withdrawn)throw new RoomError('invalid_state','Withdrawn deliveries are terminal.');
      if (frozen !== JSON.stringify([delivery.messageId, delivery.recipient, delivery.target])) throw new RoomError('invalid_state', 'Delivery target snapshots are immutable.');
      this.validateAttempts(oldAttempts, delivery.attempts);
      delivery.updatedAt = new Date().toISOString();
      this.db.prepare('UPDATE deliveries SET state=?,held=?,payload=? WHERE message_id=? AND recipient=?').run(delivery.state, Number(delivery.held), JSON.stringify(delivery), messageId, recipient);
      return delivery;
    });
  }
  private validateAttempts(before: DeliveryAttempt[], after: DeliveryAttempt[]): void {
    if (after.length < before.length) throw new RoomError('invalid_state', 'Attempt history cannot be removed.');
    for (let i = 0; i < after.length; i++) {
      const attempt = after[i]!; const old = before[i];
      if (attempt.n !== i + 1) throw new RoomError('invalid_state', 'Attempt numbers must be consecutive.');
      if (old && (old.n !== attempt.n || old.startedAt !== attempt.startedAt || (old.outcome !== 'in_flight' && JSON.stringify(old) !== JSON.stringify(attempt)))) throw new RoomError('invalid_state', 'Completed attempt history is immutable.');
    }
  }
  roomState(): RoomState { return JSON.parse((this.db.prepare('SELECT payload FROM room_state WHERE id=1').get() as {payload: string}).payload) as RoomState; }
  setRoomState(state: RoomState): void { this.db.prepare('UPDATE room_state SET payload=? WHERE id=1').run(JSON.stringify(state)); }
  putParticipant(value: ParticipantState): void { this.db.prepare('INSERT INTO participants(name,payload) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload').run(value.name, JSON.stringify(value)); }
  participants(): ParticipantState[] { return (this.db.prepare('SELECT payload FROM participants ORDER BY name').all() as {payload: string}[]).map(row => JSON.parse(row.payload) as ParticipantState); }
  removeParticipant(name: string): void { this.db.prepare('DELETE FROM participants WHERE name=?').run(name); }
  putCursor<T = UsageCursor>(name: string, cursor: T): void { this.db.prepare('INSERT INTO usage_cursors(name,payload) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload').run(name, JSON.stringify(cursor)); }
  /** Stored cursor payload. The caller owns its shape (the usage observer stores its own cursor list). */
  cursor<T = UsageCursor>(name: string): T | null { const row = this.db.prepare('SELECT payload FROM usage_cursors WHERE name=?').get(name) as {payload: string} | undefined; return row ? JSON.parse(row.payload) as T : null; }
}
