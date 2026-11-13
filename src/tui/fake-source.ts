// In-memory RoomSource for tests and `roundtable tui --demo`. It mimics the service contract closely enough for the
// TUI (send/read/who/subscribe/pause/resume/retry + events); it performs no real delivery.
import { RoomError } from '../contracts/errors.js';
import type {
  Delivery,
  DeliveryState,
  MessageWithDeliveries,
  ParticipantState,
  RoomMessage,
  RoomState,
} from '../contracts/domain.js';
import { HUMAN } from '../contracts/domain.js';
import type { Method, Params, Result, RoomEvent } from '../contracts/ipc.js';
import type { ActivityItem, ActivityPage, ActivityStreamId } from '../contracts/activity.js';
import type { AccountUsage } from '../contracts/account.js';
import type { DeliverySettings, RoomSettingsView } from '../contracts/settings.js';
import type { ConnectionStatus, RoomSource } from './source.js';

type Listener<T> = (value: T) => void;

export class FakeRoomSource implements RoomSource {
  readonly roomLabel: string;
  private items: MessageWithDeliveries[] = [];
  private participants: ParticipantState[] = [];
  private room: RoomState = { paused: false, pausedAt: null, stopRequestId: null };
  private eventListeners = new Set<Listener<RoomEvent>>();
  private statusListeners = new Set<Listener<ConnectionStatus>>();
  private current: ConnectionStatus = { state: 'connected' };
  private clock: number;
  /** Every request received (tests assert on these). */
  readonly requests: Array<{ method: Method; params: unknown }> = [];
  private activity = new Map<string, { stream: ActivityStreamId; items: ActivityItem[]; coverage: ActivityPage['coverage']; reason?: string; olderEvicted: boolean }>();

  private accounts: AccountUsage[] | null = null;
  /** 7.6 room settings; tests may replace it (e.g. to mark a key as set by the environment). */
  settings: RoomSettingsView = { defaults: { deliveryHoldMs: 500, batchHeld: true, batchMaxHoldMs: 2000 }, configured: { deliveryHoldMs: 500, batchHeld: true, batchMaxHoldMs: 2000 }, effective: { deliveryHoldMs: 500, batchHeld: true, batchMaxHoldMs: 2000 }, overridden: [] };

  /** Subscription usage the fake `who` reports; `announce` also emits `account.updated` for each (as the service would). */
  setAccounts(accounts: AccountUsage[], announce = false): void {
    this.accounts = accounts;
    if (announce) for (const account of accounts) this.emit({ type: 'account.updated', account: structuredClone(account) });
  }

  /** Set a participant's observed activity (and optionally announce new items live, as the service would). */
  setActivity(participant: string, items: ActivityItem[], opts: { coverage?: ActivityPage['coverage']; reason?: string; olderEvicted?: boolean; generation?: number } = {}): ActivityStreamId {
    const p = this.participants.find((x) => x.name === participant);
    const stream: ActivityStreamId = { participant, harness: p?.harness ?? 'claude', sessionId: p?.sessionId ?? participant, generation: opts.generation ?? 1 };
    this.activity.set(participant, { stream, items, coverage: opts.coverage ?? 'full', ...(opts.reason ? { reason: opts.reason } : {}), olderEvicted: opts.olderEvicted ?? false });
    return stream;
  }

  appendActivity(participant: string, items: ActivityItem[]): void {
    const a = this.activity.get(participant);
    if (!a) throw new Error(`no activity for ${participant}`);
    a.items.push(...items);
    this.emit({ type: 'activity.appended', stream: a.stream, items: structuredClone(items), reset: false });
  }

  constructor(options: { roomLabel?: string; participants?: ParticipantState[]; startAt?: number } = {}) {
    this.roomLabel = options.roomLabel ?? 'demo room';
    this.participants = options.participants ?? [];
    this.clock = options.startAt ?? Date.parse('2026-09-28T09:00:00.000Z');
  }

  status(): ConnectionStatus {
    return this.current;
  }

  onEvent(listener: Listener<RoomEvent>): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: Listener<ConnectionStatus>): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  // ---- test/demo drivers --------------------------------------------------------------------------------

  setStatus(status: ConnectionStatus): void {
    this.current = status;
    for (const l of this.statusListeners) l(status);
  }

  emit(event: RoomEvent): void {
    for (const l of this.eventListeners) l(event);
  }

  /** Append a message as if the service accepted it, with the given per-recipient states; emits message.created. */
  post(from: string, to: string[] | 'all', body: string, options: { states?: Record<string, DeliveryState>; replyTo?: string; kind?: RoomMessage['kind'] } = {}): MessageWithDeliveries {
    const agents = this.participants.map((p) => p.name);
    const recipients = to === 'all' ? agents.filter((n) => n !== from) : to;
    this.clock += 45_000;
    const seq = this.items.length + 1;
    const message: RoomMessage = {
      id: `m${seq}`,
      seq,
      createdAt: new Date(this.clock).toISOString(),
      from: from === HUMAN
        ? { name: HUMAN, kind: 'human', identity: { mode: 'human', source: 'tui' } }
        : { name: from, kind: 'agent', identity: { mode: 'verified', source: 'codex-mcp-meta' } },
      to: recipients,
      addressing: to === 'all' ? 'broadcast' : 'direct',
      replyTo: options.replyTo ?? null,
      kind: options.kind ?? 'chat',
      body,
      clientMessageId: null,
    };
    const deliveries = recipients
      .filter((r) => r !== HUMAN)
      .map((recipient) => this.delivery(message, recipient, options.states?.[recipient] ?? 'queued'));
    const item = { message, deliveries };
    this.items.push(item);
    this.emit({ type: 'message.created', message, deliveries });
    return item;
  }

  /** Change a delivery's state and emit delivery.updated (unless `silent`, e.g. to simulate a missed event). */
  setDelivery(messageId: string, recipient: string, patch: Partial<Delivery>, options: { silent?: boolean } = {}): void {
    const item = this.items.find((i) => i.message.id === messageId);
    const d = item?.deliveries.find((x) => x.recipient === recipient);
    if (!item || !d) throw new Error(`no delivery ${messageId}/${recipient}`);
    Object.assign(d, patch, { updatedAt: new Date(this.clock).toISOString() });
    if (!options.silent) this.emit({ type: 'delivery.updated', delivery: { ...d } });
  }

  setParticipant(state: ParticipantState): void {
    const i = this.participants.findIndex((p) => p.name === state.name);
    if (i === -1) this.participants.push(state);
    else this.participants[i] = state;
    this.emit({ type: 'participant.updated', participant: state });
  }

  // ---- RoomSource.request ---------------------------------------------------------------------------------

  async request<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    this.requests.push({ method, params });
    if (this.current.state !== 'connected') throw new RoomError('service_unavailable', 'not connected to the room service');
    return this.handle(method, params) as Result<M>;
  }

  private handle(method: Method, params: unknown): unknown {
    switch (method) {
      case 'subscribe':
        return { subscribed: true, lastSeq: this.items.length };
      case 'who':
        return { participants: this.participants.map((p) => ({ ...p })), room: { ...this.room }, ...(this.accounts ? { accounts: structuredClone(this.accounts) } : {}) };
      case 'read': {
        const p = params as Params<'read'>;
        const after = p.afterSeq ?? null;
        const limit = p.limit ?? 200;
        const matching = after === null ? this.items.slice(-limit) : this.items.filter((i) => i.message.seq > after).slice(0, limit);
        return { items: structuredClone(matching), lastSeq: this.items.length, hasMore: false };
      }
      case 'send': {
        const p = params as Params<'send'>;
        const from = p.caller.kind === 'human' ? HUMAN : (p.caller.declaredName ?? 'agent');
        const to = p.to === null || p.to.length === 0 || p.to.includes('all') ? 'all' : p.to;
        const item = this.post(from, to, p.body, p.replyTo ? { replyTo: p.replyTo } : {});
        return { ...item, deduplicated: false };
      }
      case 'pause': {
        if (this.room.paused) return { room: { ...this.room }, stopRequest: null };
        const stop = this.post(HUMAN, 'all', 'Please stop working and wait for further instructions.', { kind: 'stop_request' });
        this.room = { paused: true, pausedAt: stop.message.createdAt, stopRequestId: stop.message.id };
        this.emit({ type: 'room.updated', room: { ...this.room } });
        return { room: { ...this.room }, stopRequest: stop };
      }
      case 'resume': {
        this.room = { paused: false, pausedAt: null, stopRequestId: this.room.stopRequestId };
        this.emit({ type: 'room.updated', room: { ...this.room } });
        return { room: { ...this.room }, released: 0 };
      }
      case 'retry': {
        const p = params as Params<'retry'>;
        this.setDelivery(p.messageId, p.recipient, { state: 'queued' });
        const d = this.items.find((i) => i.message.id === p.messageId)!.deliveries.find((x) => x.recipient === p.recipient)!;
        return { delivery: { ...d } };
      }
      case 'shutdown':
        return { stopping: true };
      case 'activity': {
        const p = params as Params<'activity'>;
        const a = this.activity.get(p.participant);
        if (!a) return { stream: null, items: [], earliestSeq: null, lastSeq: null, hasMore: false, olderEvicted: false, reset: false, coverage: 'unavailable', reason: 'no activity source observed for this participant yet', checkedAt: null, backlog: false };
        const limit = p.limit ?? 50;
        const all = a.items;
        const pick = p.beforeSeq != null ? all.filter((i) => i.seq < p.beforeSeq!).slice(-limit) : p.afterSeq != null ? all.filter((i) => i.seq > p.afterSeq!).slice(0, limit) : all.slice(-limit);
        return { stream: a.stream, items: structuredClone(pick), earliestSeq: all[0]?.seq ?? null, lastSeq: all.at(-1)?.seq ?? null, hasMore: false, olderEvicted: a.olderEvicted, reset: false, coverage: a.coverage, ...(a.reason ? { reason: a.reason } : {}), checkedAt: null, backlog: false };
      }
      case 'deliveries': {
        const p = params as Params<'deliveries'>;
        return { deliveries: structuredClone(this.items.find((i) => i.message.id === p.messageId)?.deliveries ?? []) };
      }
      case 'settings_get':
        return structuredClone(this.settings);
      case 'settings_update': {
        // Mirrors the service: merge only supplied keys, null resets to the default, overridden keys are saved but
        // their effective value stays under the environment.
        const p = params as Params<'settings_update'>;
        const s = this.settings;
        for (const [k, v] of Object.entries(p.patch) as Array<[keyof DeliverySettings, DeliverySettings[keyof DeliverySettings] | null | undefined]>) {
          if (v === undefined) continue;
          (s.configured as unknown as Record<string, unknown>)[k] = v === null ? s.defaults[k] : v;
          if (!s.overridden.includes(k)) (s.effective as unknown as Record<string, unknown>)[k] = s.configured[k];
        }
        // A successful update writes a valid file, so any reported file problem is repaired.
        delete (s as { problem?: unknown }).problem;
        return structuredClone(s);
      }
      default:
        throw new RoomError('bad_request', `fake source does not implement ${method}`);
    }
  }

  private delivery(message: RoomMessage, recipient: string, state: DeliveryState): Delivery {
    const p = this.participants.find((x) => x.name === recipient);
    return {
      messageId: message.id,
      recipient,
      target: { harness: p?.harness ?? 'claude', sessionId: p?.sessionId ?? 'unknown' },
      state,
      held: false,
      waiting: null,
      repliedBy: null,
      referenced: false,
      attempts: [],
      updatedAt: message.createdAt,
    };
  }
}
