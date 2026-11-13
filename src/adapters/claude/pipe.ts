// Claude Code messaging-pipe client: auth frame, then one user-message frame (captured protocol, 2.1.283).
// Honest outcome mapping (task 2.2):
//   error before the message frame is handed to the OS  -> 'failed'    (definitely not delivered)
//   error/close after the message frame was written     -> 'uncertain' (it may have been read)
//   message written and the receiver stayed open for the settle window -> 'written'
import { connect, type Socket } from 'node:net';

export interface PipeSendOptions {
  pipePath: string;
  /** Secret; never logged, never included in any returned value. */
  token: string;
  /** Stable per delivery (see stableMsgId) so a re-sent delivery is recognizably the same message. */
  msgId: string;
  content: string;
  /** Label shown to the receiving model as the sender address. */
  from: string;
  priority: 'next' | 'now' | 'later';
  timeoutMs: number;
  settleMs: number;
}

export type PipeSendOutcome =
  | { kind: 'written' }
  | { kind: 'failed'; reason: string }
  | { kind: 'uncertain'; reason: string };

export function buildAuthFrame(token: string): string {
  return JSON.stringify({ type: 'auth', token }) + '\n';
}

export function buildUserFrame(content: string, from: string, priority: PipeSendOptions['priority'], msgId: string): string {
  return JSON.stringify({ type: 'user', message: { content }, from, priority, msg_id: msgId }) + '\n';
}

export function sendToPipe(opts: PipeSendOptions): Promise<PipeSendOutcome> {
  return new Promise((resolve) => {
    let phase: 'connecting' | 'auth' | 'message' | 'settling' | 'done' = 'connecting';
    let socket: Socket | null = null;
    let settleTimer: NodeJS.Timeout | null = null;

    const finish = (outcome: PipeSendOutcome) => {
      if (phase === 'done') return;
      phase = 'done';
      clearTimeout(overall);
      if (settleTimer) clearTimeout(settleTimer);
      socket?.removeAllListeners('close');
      socket?.on('error', () => {}); // late errors after we've decided must not crash the process
      socket?.destroy();
      resolve(outcome);
    };

    // An error once the message frame may have reached the receiver is `uncertain`; before that, `failed`.
    const onFailure = (what: string) => {
      if (phase === 'message' || phase === 'settling') finish({ kind: 'uncertain', reason: `${what} after the message was written` });
      else finish({ kind: 'failed', reason: `${what} before the message was written` });
    };

    const overall = setTimeout(() => onFailure('timed out'), opts.timeoutMs);

    try {
      socket = connect(opts.pipePath);
    } catch (err) {
      finish({ kind: 'failed', reason: `connect failed: ${describe(err)}` });
      return;
    }
    socket.on('error', (err) => onFailure(`pipe error (${describe(err)})`));
    socket.on('close', () => onFailure('receiver closed the connection'));
    socket.on('data', () => {
      // Qualified in task 6.3b (git show v0.9.0:probes/claude-pipe-frames.md): the receiver sends no receipt/status frames for user
      // frames, so there is nothing to interpret here; evidence is the write plus an open connection through settle.
    });
    socket.on('connect', () => {
      phase = 'auth';
      socket!.write(buildAuthFrame(opts.token), (err) => {
        if (err || phase !== 'auth') return; // the error handler has already classified it
        phase = 'message';
        socket!.write(buildUserFrame(opts.content, opts.from, opts.priority, opts.msgId), (err2) => {
          if (err2 || phase !== 'message') return;
          phase = 'settling';
          clearTimeout(overall); // the settle window bounds this phase; a long settle must not read as a timeout
          settleTimer = setTimeout(() => {
            socket!.removeAllListeners('close');
            socket!.end();
            finish({ kind: 'written' });
          }, opts.settleMs);
        });
      });
    });
  });
}

/** Error text without anything but the code/message (no objects, no secrets). */
function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code}` : err.message;
  }
  return String(err);
}
