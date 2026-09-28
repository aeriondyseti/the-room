import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Delivery, DeliveryAttempt, MessageWithDeliveries, ParticipantState, RoomMessage, RoomState, Sender, TargetSnapshot } from '../../contracts/domain.js';
import { HUMAN } from '../../contracts/domain.js';
import { loadConfig } from '../config.js';
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
}
export interface UsageCursor { source: string; offset: number; identity: string; updatedAt: string }
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
      if (version.user_version > 1) throw new RoomError('unsupported_version', 'Room database was created by a newer version.');
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          sender_scope TEXT NOT NULL, client_key TEXT, fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
          UNIQUE(sender_scope, client_key)
        );
        CREATE TABLE IF NOT EXISTS deliveries (
          message_id TEXT NOT NULL REFERENCES messages(id), recipient TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('queued','submitted','replied','failed','uncertain')),
          held INTEGER NOT NULL CHECK(held IN (0,1)), payload TEXT NOT NULL,
          PRIMARY KEY(message_id, recipient)
        );
        CREATE INDEX IF NOT EXISTS delivery_order ON deliveries(recipient,state);
        CREATE TABLE IF NOT EXISTS participants (name TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS usage_cursors (name TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS room_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
        INSERT OR IGNORE INTO room_state VALUES(1,'{"paused":false,"pausedAt":null,"stopRequestId":null}');
        PRAGMA user_version = 1;
      `);
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }

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

  enqueue(input: EnqueueInput): MessageWithDeliveries & { deduplicated: boolean } {
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
      };
      const inserted = this.db.prepare('INSERT INTO messages(id,sender_scope,client_key,fingerprint,payload) VALUES(?,?,?,?,?)').run(message.id, input.senderScope, key, fingerprint, JSON.stringify(message));
      message.seq = Number(inserted.lastInsertRowid);
      this.db.prepare('UPDATE messages SET payload=? WHERE id=?').run(JSON.stringify(message), message.id);
      for (const recipient of input.recipients) {
        if (!recipient.target) {
          if (recipient.name !== HUMAN) throw new RoomError('bad_request', 'Only the human recipient may omit a native delivery target.');
          continue;
        }
        const delivery: Delivery = {
          messageId: message.id, recipient: recipient.name, target: structuredClone(recipient.target),
          state: 'queued', held: input.held ?? false, waiting: null, repliedBy: null,
          referenced: false, attempts: [], updatedAt: now,
        };
        this.db.prepare('INSERT INTO deliveries(message_id,recipient,state,held,payload) VALUES(?,?,?,?,?)').run(message.id, recipient.name, delivery.state, Number(delivery.held), JSON.stringify(delivery));
      }
      return { ...this.read(message.id), deduplicated: false };
    });
  }

  private fingerprint(input: Pick<EnqueueInput, 'sender' | 'body' | 'requestedRecipients' | 'addressing' | 'replyTo' | 'kind'>): string {
    return JSON.stringify({ senderKind:input.sender.kind, body:input.body,
      requestedRecipients:input.requestedRecipients===null?null:[...new Set(input.requestedRecipients)].sort(),
      addressing:input.addressing,replyTo:input.replyTo??null,kind:input.kind??'chat' });
  }
  /** Check a retry before resolving current recipients, which may have left since the original send. */
  findRetry(input: Pick<EnqueueInput, 'sender' | 'senderScope' | 'body' | 'requestedRecipients' | 'addressing' | 'replyTo' | 'kind' | 'clientMessageId'>): (MessageWithDeliveries & {deduplicated:true}) | null {
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
    const row = this.db.prepare('SELECT payload FROM deliveries WHERE message_id=? AND recipient=?').get(messageId, recipient) as unknown as DeliveryRow | undefined;
    if (!row) throw new RoomError('not_found', 'Delivery not found in this room.');
    return JSON.parse(row.payload) as Delivery;
  }
  unfinishedAttempts(): Delivery[] {
    return (this.db.prepare("SELECT payload FROM deliveries WHERE json_extract(payload,'$.attempts[#-1].outcome')='in_flight'").all() as unknown as DeliveryRow[]).map(row=>JSON.parse(row.payload) as Delivery);
  }
  queued(recipient?: string): Delivery[] {
    return (this.db.prepare(`SELECT d.payload FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.state='queued' ${recipient === undefined ? '' : 'AND d.recipient=?'} ORDER BY m.seq,d.recipient`).all(...(recipient === undefined ? [] : [recipient])) as unknown as DeliveryRow[]).map(row => JSON.parse(row.payload) as Delivery);
  }
  /** Update mutable state only; message, recipient and target snapshot cannot be replaced. */
  updateDelivery(messageId: string, recipient: string, update: (delivery: Delivery) => void): Delivery {
    return this.transaction(() => {
      const delivery = this.delivery(messageId, recipient);
      const frozen = JSON.stringify([delivery.messageId, delivery.recipient, delivery.target]);
      const oldAttempts = structuredClone(delivery.attempts);
      update(delivery);
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
  putCursor(name: string, cursor: UsageCursor): void { this.db.prepare('INSERT INTO usage_cursors(name,payload) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload').run(name, JSON.stringify(cursor)); }
  cursor(name: string): UsageCursor | null { const row = this.db.prepare('SELECT payload FROM usage_cursors WHERE name=?').get(name) as {payload: string} | undefined; return row ? JSON.parse(row.payload) as UsageCursor : null; }
}
