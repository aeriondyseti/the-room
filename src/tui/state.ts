// Pure room-view state for the TUI: a snapshot (who + read) plus live events. No I/O here.
import type { Delivery, MessageWithDeliveries, ParticipantState, RoomState } from '../contracts/domain.js';
import type { RoomEvent } from '../contracts/ipc.js';
import type { ConnectionStatus } from './source.js';

export interface RoomView {
  /** Ordered by seq; each message with its per-recipient deliveries. */
  items: MessageWithDeliveries[];
  participants: ParticipantState[];
  room: RoomState;
  connection: ConnectionStatus;
  /** True once the first who+read snapshot has been applied. */
  loaded: boolean;
  lastSeq: number;
  /** A non-fatal problem to show (e.g. a failed refresh). */
  notice: string | null;
}

export const INITIAL_VIEW: RoomView = {
  items: [],
  participants: [],
  room: { paused: false, pausedAt: null, stopRequestId: null },
  connection: { state: 'connecting' },
  loaded: false,
  lastSeq: 0,
  notice: null,
};

export type ViewAction =
  | { type: 'snapshot'; items: MessageWithDeliveries[]; participants: ParticipantState[]; room: RoomState }
  | { type: 'event'; event: RoomEvent }
  | { type: 'status'; status: ConnectionStatus }
  | { type: 'notice'; notice: string | null };

export function reduceView(view: RoomView, action: ViewAction): RoomView {
  switch (action.type) {
    case 'snapshot': {
      // A snapshot after reconnect merges with anything already shown (it may overlap events we saw live).
      const byId = new Map(view.items.map((i) => [i.message.id, i] as const));
      for (const item of action.items) byId.set(item.message.id, item);
      const items = [...byId.values()].sort((a, b) => a.message.seq - b.message.seq);
      return {
        ...view,
        items,
        participants: sortParticipants(action.participants),
        room: action.room,
        loaded: true,
        lastSeq: Math.max(view.lastSeq, items.at(-1)?.message.seq ?? 0),
      };
    }
    case 'event':
      return applyEvent(view, action.event);
    case 'status':
      return { ...view, connection: action.status };
    case 'notice':
      return { ...view, notice: action.notice };
  }
}

function applyEvent(view: RoomView, event: RoomEvent): RoomView {
  switch (event.type) {
    case 'message.created': {
      if (view.items.some((i) => i.message.id === event.message.id)) return view;
      const items = [...view.items, { message: event.message, deliveries: event.deliveries }].sort((a, b) => a.message.seq - b.message.seq);
      return { ...view, items, lastSeq: Math.max(view.lastSeq, event.message.seq) };
    }
    case 'delivery.updated':
      return { ...view, items: view.items.map((i) => (i.message.id === event.delivery.messageId ? withDelivery(i, event.delivery) : i)) };
    case 'participant.updated': {
      const others = view.participants.filter((p) => p.name !== event.participant.name);
      return { ...view, participants: sortParticipants([...others, event.participant]) };
    }
    case 'participant.removed':
      return { ...view, participants: view.participants.filter((p) => p.name !== event.name) };
    case 'room.updated':
      return { ...view, room: event.room };
    case 'service.stopping':
      return { ...view, notice: `Room service stopping: ${event.reason}` };
  }
}

function withDelivery(item: MessageWithDeliveries, delivery: Delivery): MessageWithDeliveries {
  const exists = item.deliveries.some((d) => d.recipient === delivery.recipient);
  return {
    ...item,
    deliveries: exists ? item.deliveries.map((d) => (d.recipient === delivery.recipient ? delivery : d)) : [...item.deliveries, delivery],
  };
}

function sortParticipants(list: ParticipantState[]): ParticipantState[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name));
}
