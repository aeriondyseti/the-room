// Activity service (6.1): polls each participant's transcript through the ActivityReader and publishes new items.
// Deliberately separate from the participant monitor and the dispatcher: observed activity is presentation only and
// never feeds delivery, identity, liveness or bindings. Room-looking text in a transcript is just text here.
import type { ActivityPage, ActivityRequest } from '../../contracts/activity.js';
import type { ParticipantState } from '../../contracts/domain.js';
import type { RoomEvent } from '../../contracts/ipc.js';
import type { ActivityCursorState, ActivityReader } from '../../observer/activity-reader.js';

export interface ActivityServiceDeps {
  reader: ActivityReader;
  participants(): Promise<ParticipantState[]>;
  publish(event: RoomEvent): void;
  loadCursors(): ActivityCursorState[];
  saveCursors(cursors: ActivityCursorState[]): void;
  intervalMs: number;
}

export class ActivityService {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private lastSaved: string | null = null;
  lastError: Error | null = null;

  constructor(private readonly deps: ActivityServiceDeps) {
    try {
      deps.reader.restore(deps.loadCursors());
    } catch {
      // corrupt cursors only cost re-reading from the transcript's tail
    }
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** One polling pass over current bindings (overlapping calls share the pass; never rejects). */
  tick(): Promise<void> {
    this.running ??= this.pass()
      .catch((err: unknown) => {
        this.lastError = err instanceof Error ? err : new Error(String(err));
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** Serve an `activity` request: poll that participant first so the page is fresh. */
  async page(req: ActivityRequest): Promise<ActivityPage> {
    const p = (await this.deps.participants()).find((x) => x.name === req.participant);
    if (p) await this.pollOne(p);
    return this.deps.reader.page(req);
  }

  private async pass(): Promise<void> {
    const participants = await this.deps.participants();
    this.deps.reader.retain(participants.map((p) => p.name));
    for (const p of participants) {
      if (this.stopped) return;
      try {
        await this.pollOne(p);
      } catch (err) {
        this.lastError = err instanceof Error ? err : new Error(String(err)); // one bad transcript never blocks others
      }
    }
    const cursors = this.deps.reader.export();
    const serialized = JSON.stringify(cursors);
    if (serialized !== this.lastSaved) {
      try {
        this.deps.saveCursors(cursors);
        this.lastSaved = serialized;
      } catch {
        // best effort; retried next pass
      }
    }
  }

  private async pollOne(p: ParticipantState): Promise<void> {
    const r = await this.deps.reader.poll({ participant: p.name, harness: p.harness, sessionId: p.sessionId });
    if (r.items.length || r.reset) this.deps.publish({ type: 'activity.appended', stream: r.stream, items: r.items, reset: r.reset });
  }
}
