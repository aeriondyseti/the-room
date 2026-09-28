// RoomSource backed by the real IPC RoomClient (1.2). Owns the TUI's reconnect policy (agreed with Astra, R35):
// one RoomClient = one connection; on disconnect we reconnect with backoff and the App refreshes its snapshot.
// Requests are never replayed automatically (a failed send keeps its client_message_id for a manual retry).
import { RoomError } from '../contracts/errors.js';
import type { Method, Params, Result, RoomEvent } from '../contracts/ipc.js';
import { RoomClient } from '../ipc/client.js';
import type { ConnectionStatus, RoomSource } from './source.js';

/** The subset of RoomClient this source needs (injectable for tests). */
export interface RoomConnection {
  request<M extends Method>(method: M, params: Params<M>): Promise<Result<M>>;
  onEvent(listener: (event: RoomEvent) => void): () => void;
  onDisconnect(listener: (reason: Error) => void): () => void;
  close(): void;
}

export interface ClientRoomSourceOptions {
  roomRoot: string;
  connect?: (root: string) => Promise<RoomConnection>;
  /** Delay before each reconnect attempt; the last value repeats. */
  backoffMs?: readonly number[];
  /** After this many consecutive failures the status becomes `disconnected` (still retrying). */
  failuresBeforeDisconnected?: number;
}

const DEFAULT_BACKOFF = [250, 500, 1_000, 2_000, 5_000] as const;

export class ClientRoomSource implements RoomSource {
  readonly roomLabel: string;
  private connection: RoomConnection | null = null;
  private current: ConnectionStatus = { state: 'connecting' };
  private readonly eventListeners = new Set<(event: RoomEvent) => void>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private closed = false;
  private running = false;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly connectFn: (root: string) => Promise<RoomConnection>;
  private readonly backoff: readonly number[];
  private readonly failuresBeforeDisconnected: number;

  constructor(private readonly options: ClientRoomSourceOptions) {
    this.roomLabel = options.roomRoot;
    this.connectFn = options.connect ?? ((root) => RoomClient.connect(root, { client: 'tui', autoStart: true }));
    this.backoff = options.backoffMs ?? DEFAULT_BACKOFF;
    this.failuresBeforeDisconnected = options.failuresBeforeDisconnected ?? 3;
  }

  /** Begin connecting (idempotent). */
  start(): void {
    if (!this.running && !this.closed) void this.connectLoop();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.connection?.close();
    this.connection = null;
  }

  status(): ConnectionStatus {
    return this.current;
  }

  onEvent(listener: (event: RoomEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  request<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    if (!this.connection) return Promise.reject(new RoomError('service_unavailable', 'Not connected to the room service yet; try again in a moment.'));
    return this.connection.request(method, params);
  }

  private setStatus(status: ConnectionStatus): void {
    this.current = status;
    for (const l of this.statusListeners) l(status);
  }

  private async connectLoop(): Promise<void> {
    this.running = true;
    while (!this.closed) {
      try {
        const connection = await this.connectFn(this.options.roomRoot);
        if (this.closed) {
          connection.close();
          break;
        }
        this.connection = connection;
        this.failures = 0;
        connection.onEvent((event) => {
          for (const l of this.eventListeners) l(event);
        });
        connection.onDisconnect((reason) => {
          if (this.connection !== connection) return;
          this.connection = null;
          if (this.closed) return;
          this.setStatus({ state: 'reconnecting', detail: reason.message });
          this.scheduleReconnect();
        });
        this.setStatus({ state: 'connected' });
        break;
      } catch (err) {
        this.failures++;
        const detail = err instanceof Error ? err.message : String(err);
        this.setStatus({ state: this.failures >= this.failuresBeforeDisconnected ? 'disconnected' : 'reconnecting', detail });
        await new Promise<void>((resolve) => {
          this.timer = setTimeout(resolve, this.delay());
        });
      }
    }
    this.running = false;
  }

  private scheduleReconnect(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.start(), this.delay());
  }

  private delay(): number {
    return this.backoff[Math.min(this.failures, this.backoff.length - 1)] ?? 1_000;
  }
}
