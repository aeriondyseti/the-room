// The TUI's only dependency on the room: a request/event/status transport. The IPC RoomClient (1.2) implements
// it for real; FakeRoomSource implements it for tests and `roundtable tui --demo`. The TUI is presentation only.
import type { Method, Params, Result, RoomEvent } from '../contracts/ipc.js';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface ConnectionStatus {
  state: ConnectionState;
  detail?: string;
}

export interface RoomSource {
  request<M extends Method>(method: M, params: Params<M>): Promise<Result<M>>;
  /** Live events for this connection (after `subscribe`). Returns an unsubscribe function. */
  onEvent(listener: (event: RoomEvent) => void): () => void;
  onStatus(listener: (status: ConnectionStatus) => void): () => void;
  status(): ConnectionStatus;
  /** Where the room lives (shown in the header). */
  readonly roomLabel: string;
}
