// IPC contract: newline-delimited JSON frames over a local named pipe (Windows) / Unix socket.
// The service owns all behavior; TUI, CLI and MCP are thin clients speaking this protocol.
import type {
  Delivery,
  ErrorInfo,
  Harness,
  IdentitySource,
  MessageId,
  MessageWithDeliveries,
  ParticipantRegistration,
  ParticipantState,
  RoomMessage,
  RoomState,
} from './domain.js';

export const PROTOCOL_VERSION = 1;

/** Upper bound on one frame (a message body plus envelope metadata), protecting the service's memory. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

// ---- Caller identity ------------------------------------------------------------------------------

/** Raw native evidence gathered by a client; the service resolves it against the registry. */
export interface NativeEvidence {
  harness: Harness;
  sessionId: string;
  source: Exclude<IdentitySource, 'declared' | 'tui' | 'service'>;
}

/**
 * Who is calling. Clients never assert a verified identity themselves: they pass evidence and/or a
 * declared name, and the service decides (invariant 5).
 */
export type Caller =
  | { kind: 'human' }
  | {
      kind: 'agent';
      /** Native evidence, when the client could detect it. */
      native: NativeEvidence | null;
      /** A name the caller claims (`--as`). Checked against native evidence when both exist. */
      declaredName: string | null;
    };

// ---- Requests -------------------------------------------------------------------------------------

export type ClientKind = 'tui' | 'cli' | 'mcp';

export interface RequestMap {
  hello: {
    params: { client: ClientKind; clientVersion: string; protocolVersion: number };
    result: { serviceVersion: string; protocolVersion: number; roomRoot: string; pid: number };
  };
  send: {
    params: {
      caller: Caller;
      /** Participant names, or ['all']. Omitted/empty: human => all agents; agent => error `no_recipients`. */
      to: string[] | null;
      body: string;
      replyTo?: MessageId | null;
      clientMessageId?: string | null;
    };
    result: MessageWithDeliveries & { deduplicated: boolean };
  };
  read: {
    params: {
      /** Return messages with seq > afterSeq (default: the latest `limit` messages). */
      afterSeq?: number | null;
      limit?: number | null;
      /** Fetch one message by id (used for oversized-message references). */
      messageId?: MessageId | null;
      includeDeliveries?: boolean;
    };
    result: { items: MessageWithDeliveries[]; lastSeq: number; hasMore: boolean };
  };
  who: {
    params: Record<string, never>;
    result: { participants: ParticipantState[]; room: RoomState };
  };
  join: {
    params: {
      name: string;
      native: NativeEvidence;
      /** Required to rebind an existing name to a new native session (no silent clobbering). */
      expectedSessionId?: string | null;
    };
    result: { registration: ParticipantRegistration; created: boolean; rebound: boolean };
  };
  deliveries: {
    params: { messageId: MessageId };
    result: { deliveries: Delivery[] };
  };
  retry: {
    params: { messageId: MessageId; recipient: string };
    result: { delivery: Delivery };
  };
  pause: {
    params: { caller: { kind: 'human' }; stopRequestBody?: string | null; resendStopRequest?: boolean };
    result: { room: RoomState; stopRequest: MessageWithDeliveries | null };
  };
  resume: {
    params: { caller: { kind: 'human' } };
    result: { room: RoomState; released: number };
  };
  subscribe: {
    /** Replays events after `afterSeq` (message events only), then streams live events on this connection. */
    params: { afterSeq?: number | null };
    result: { subscribed: true; lastSeq: number };
  };
  shutdown: {
    params: Record<string, never>;
    result: { stopping: true };
  };
}

export type Method = keyof RequestMap;
export const METHODS = [
  'hello',
  'send',
  'read',
  'who',
  'join',
  'deliveries',
  'retry',
  'pause',
  'resume',
  'subscribe',
  'shutdown',
] as const satisfies readonly Method[];

export type Params<M extends Method> = RequestMap[M]['params'];
export type Result<M extends Method> = RequestMap[M]['result'];

export interface RequestFrame<M extends Method = Method> {
  v: typeof PROTOCOL_VERSION;
  type: 'request';
  id: string;
  method: M;
  params: Params<M>;
}

export type ResponseFrame<M extends Method = Method> =
  | { v: typeof PROTOCOL_VERSION; type: 'response'; id: string; ok: true; result: Result<M> }
  | { v: typeof PROTOCOL_VERSION; type: 'response'; id: string; ok: false; error: ErrorInfo };

// ---- Events ---------------------------------------------------------------------------------------

export type RoomEvent =
  | { type: 'message.created'; message: RoomMessage; deliveries: Delivery[] }
  | { type: 'delivery.updated'; delivery: Delivery }
  | { type: 'participant.updated'; participant: ParticipantState }
  | { type: 'participant.removed'; name: string }
  | { type: 'room.updated'; room: RoomState }
  | { type: 'service.stopping'; reason: string };

export interface EventFrame {
  v: typeof PROTOCOL_VERSION;
  type: 'event';
  event: RoomEvent;
}

export type Frame = RequestFrame | ResponseFrame | EventFrame;

// ---- Framing --------------------------------------------------------------------------------------

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame) + '\n';
}

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

/**
 * Incremental decoder for newline-delimited frames. Feed it chunks as they arrive; it returns complete
 * frames and keeps partial trailing data. Throws FrameError on oversized or malformed frames so the
 * connection can be closed instead of silently dropping data.
 */
export class FrameDecoder {
  private buffer = '';

  push(chunk: string): Frame[] {
    this.buffer += chunk;
    const frames: Frame[] = [];
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() === '') continue;
      frames.push(parseFrame(line));
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_FRAME_BYTES) {
      this.buffer = '';
      throw new FrameError(`frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }
    return frames;
  }

  /** True when a partial frame is buffered (e.g. the peer closed mid-frame). */
  get hasPartial(): boolean {
    return this.buffer.length > 0;
  }
}

export function parseFrame(line: string): Frame {
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) throw new FrameError(`frame exceeds ${MAX_FRAME_BYTES} bytes`);
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new FrameError('frame is not valid JSON');
  }
  if (!isRecord(value) || value['v'] !== PROTOCOL_VERSION) {
    throw new FrameError(`unsupported protocol version: ${isRecord(value) ? String(value['v']) : 'n/a'}`);
  }
  const type = value['type'];
  if (type === 'request') {
    if (typeof value['id'] !== 'string' || !isMethod(value['method']) || !isRecord(value['params'])) {
      throw new FrameError('malformed request frame');
    }
  } else if (type === 'response') {
    if (typeof value['id'] !== 'string' || typeof value['ok'] !== 'boolean') throw new FrameError('malformed response frame');
    if (value['ok'] === false && !isRecord(value['error'])) throw new FrameError('malformed error response');
  } else if (type === 'event') {
    if (!isRecord(value['event']) || typeof value['event']['type'] !== 'string') throw new FrameError('malformed event frame');
  } else {
    throw new FrameError(`unknown frame type: ${String(type)}`);
  }
  return value as unknown as Frame;
}

export function isMethod(value: unknown): value is Method {
  return typeof value === 'string' && (METHODS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
