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
  TargetSnapshot,
} from './domain.js';
import type { ActivityItem, ActivityPage, ActivityRequest, ActivityStreamId } from './activity.js';
import type { AccountUsage } from './account.js';

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
 * Who is calling. Clients never assert a verified agent identity themselves: they pass evidence and/or a
 * declared name, and the service decides (invariant 5).
 *
 * `{kind:'human'}` rules (agents never act as the human):
 * - The service accepts it only on connections whose `hello` declared client `tui` or `cli`; never `mcp`.
 * - The CLI is also the agents' fallback surface, so the CLI MUST send `{kind:'agent', ...}` whenever it
 *   detects agent context (CODEX_THREAD_ID, or a Claude session among its ancestor processes), and MUST
 *   refuse human-only commands (pause, resume, retry, shutdown) in that context. It sends `human` only when no
 *   agent context is detected. This is local routing hygiene in a trusted room, not isolation from
 *   same-user processes (proposal "Messaging").
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
    /** `accounts` (6.6): subscription usage once per account; absent from older services. */
    result: { participants: ParticipantState[]; room: RoomState; accounts?: AccountUsage[] };
  };
  join: {
    params: {
      name: string;
      native: NativeEvidence;
      /**
       * Compare-and-swap guard: required to rebind an existing name to a different native session. Must equal
       * the currently registered target (harness + sessionId), else `rebind_conflict` (no silent clobbering).
       */
      expectedPrevious?: TargetSnapshot | null;
    };
    result: { registration: ParticipantRegistration; created: boolean; rebound: boolean };
  };
  deliveries: {
    params: { messageId: MessageId };
    result: { deliveries: Delivery[] };
  };
  retry: {
    /** Human-only: re-attempts a failed/uncertain delivery (an uncertain one may already have been delivered). */
    params: { caller: { kind: 'human' }; messageId: MessageId; recipient: string };
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
    /**
     * Replays `message.created` events for messages with seq > `afterSeq`, then streams live events on this
     * connection. Delivery/participant/room updates are NOT replayed: after every (re)subscribe the client must
     * refresh state with `who` and `read {includeDeliveries: true}` (or `deliveries`) before trusting its view.
     */
    params: { afterSeq?: number | null };
    result: { subscribed: true; lastSeq: number };
  };
  shutdown: {
    /** Human-only (same connection rule as Caller `human`). */
    params: { caller: { kind: 'human' } };
    result: { stopping: true };
  };
  activity: {
    /**
     * Observed activity for one participant (6.1): read-only, presentation only. Exactly one of afterSeq/beforeSeq
     * (neither = newest page). A `stream` from another binding/generation yields `reset: true` (drop local state).
     */
    params: ActivityRequest;
    result: ActivityPage;
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
  'activity',
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
  | { type: 'service.stopping'; reason: string }
  /** New observed activity (6.1). `reset` means the stream changed (rebind/rotation): drop that participant's view. */
  | { type: 'activity.appended'; stream: ActivityStreamId; items: ActivityItem[]; reset: boolean }
  /** Subscription usage for one account changed (6.6). */
  | { type: 'account.updated'; account: AccountUsage };

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

export type FrameErrorKind = 'malformed' | 'too_large' | 'unsupported_version';

/**
 * Framing failure. `frames` carries any frames decoded from the same chunk *before* the bad line, so a caller
 * can still process them before closing. `unsupported_version` lets the service reply with the
 * `unsupported_version` error code before closing.
 */
export class FrameError extends Error {
  readonly kind: FrameErrorKind;
  frames: Frame[];
  /** The offending request's id, when it could be read, so the service can send a correlated error response. */
  readonly requestId: string | null;

  constructor(kind: FrameErrorKind, message: string, frames: Frame[] = [], requestId: string | null = null) {
    super(message);
    this.name = 'FrameError';
    this.kind = kind;
    this.frames = frames;
    this.requestId = requestId;
  }
}

/**
 * Incremental decoder for newline-delimited frames. Feed it *decoded strings* (use
 * `socket.setEncoding('utf8')` so multi-byte characters split across pipe chunks are reassembled); it returns
 * complete frames and keeps partial trailing data. Throws FrameError on an oversized or malformed frame, with
 * any frames decoded earlier in the same chunk attached, so the connection can be closed instead of silently
 * dropping data.
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
      try {
        frames.push(parseFrame(line));
      } catch (err) {
        this.buffer = '';
        if (err instanceof FrameError) err.frames = frames;
        throw err;
      }
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_FRAME_BYTES) {
      this.buffer = '';
      throw new FrameError('too_large', `frame exceeds ${MAX_FRAME_BYTES} bytes`, frames);
    }
    return frames;
  }

  /** True when a partial frame is buffered (e.g. the peer closed mid-frame). */
  get hasPartial(): boolean {
    return this.buffer.length > 0;
  }
}

export function parseFrame(line: string): Frame {
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) throw new FrameError('too_large', `frame exceeds ${MAX_FRAME_BYTES} bytes`);
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new FrameError('malformed', 'frame is not valid JSON');
  }
  if (!isRecord(value)) throw new FrameError('malformed', 'frame is not a JSON object');
  if (value['v'] !== PROTOCOL_VERSION) {
    const requestId = value['type'] === 'request' && typeof value['id'] === 'string' ? value['id'] : null;
    throw new FrameError(
      'unsupported_version',
      `unsupported protocol version: ${String(value['v'])} (expected ${PROTOCOL_VERSION})`,
      [],
      requestId,
    );
  }
  const type = value['type'];
  if (type === 'request') {
    if (typeof value['id'] !== 'string' || !isMethod(value['method']) || !isRecord(value['params'])) {
      throw new FrameError('malformed', 'malformed request frame');
    }
  } else if (type === 'response') {
    if (typeof value['id'] !== 'string' || typeof value['ok'] !== 'boolean') throw new FrameError('malformed', 'malformed response frame');
    if (value['ok'] === false && !isRecord(value['error'])) throw new FrameError('malformed', 'malformed error response');
    if (value['ok'] === true && !Object.hasOwn(value, 'result')) throw new FrameError('malformed', 'success response without result');
  } else if (type === 'event') {
    if (!isRecord(value['event']) || typeof value['event']['type'] !== 'string') throw new FrameError('malformed', 'malformed event frame');
  } else {
    throw new FrameError('malformed', `unknown frame type: ${String(type)}`);
  }
  return value as unknown as Frame;
}

export function isMethod(value: unknown): value is Method {
  return typeof value === 'string' && (METHODS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
