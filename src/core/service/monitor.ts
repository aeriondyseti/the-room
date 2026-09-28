// Participant monitor (ROADMAP 2.5b): keeps each participant's liveness, activity and context usage current, so
// `who` and the TUI show observed state instead of "unknown". Read-only by construction: adapter probes and the
// usage observer never message or modify a session (invariant 8). Unknown stays unknown (invariant 3).
import type { DeliveryAdapter } from '../../contracts/adapter.js';
import type { Harness, ParticipantState, UsageSnapshot } from '../../contracts/domain.js';
import type { UsageCursor as ObserverCursor } from '../../observer/observer.js';

export interface MonitorDeps {
  /** Current participant states (as the service computes them). */
  participants(): Promise<ParticipantState[]>;
  adapters: readonly DeliveryAdapter[];
  observer: {
    snapshot(target: { harness: Harness; sessionId: string }): Promise<UsageSnapshot>;
    exportCursors(): ObserverCursor[];
    restoreCursors(cursors: readonly ObserverCursor[]): void;
  };
  save(state: ParticipantState): void;
  publish(state: ParticipantState): void;
  /** Persist/restore observer cursors so a service restart doesn't re-read whole transcripts. */
  loadCursors(): ObserverCursor[];
  saveCursors(cursors: ObserverCursor[]): void;
  intervalMs: number;
  now?: () => Date;
}

export class ParticipantMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private readonly now: () => Date;

  constructor(private readonly deps: MonitorDeps) {
    this.now = deps.now ?? (() => new Date());
    try {
      deps.observer.restoreCursors(deps.loadCursors());
    } catch {
      // Corrupt cursors only cost a re-read from the start; never block the service.
    }
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.deps.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** Refresh everyone (or one participant). Overlapping calls share the in-flight refresh. */
  refresh(only?: string): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run(only).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(only?: string): Promise<void> {
    let participants: ParticipantState[];
    try {
      participants = await this.deps.participants();
    } catch {
      return; // registry unreadable right now; the next tick retries
    }
    for (const p of participants) {
      if (this.stopped) return;
      if (only && p.name !== only) continue;
      const next = await this.observe(p);
      if (changed(p, next)) {
        this.deps.save(next);
        this.deps.publish(next);
      }
    }
    try {
      this.deps.saveCursors(this.deps.observer.exportCursors());
    } catch {
      // best effort
    }
  }

  private async observe(p: ParticipantState): Promise<ParticipantState> {
    const target = { harness: p.harness, sessionId: p.sessionId };
    const adapter = this.deps.adapters.find((a) => a.harness === p.harness);
    let liveness = p.liveness;
    let activity = p.activity;
    if (adapter) {
      try {
        const probe = await adapter.probe(target);
        liveness = probe.liveness;
        activity = probe.activity;
      } catch {
        liveness = 'unknown';
        activity = 'unknown';
      }
    }
    let usage: UsageSnapshot | null;
    try {
      usage = await this.deps.observer.snapshot(target);
    } catch (err) {
      usage = {
        source: p.harness === 'claude' ? 'claude-transcript' : 'codex-token-count',
        status: 'unavailable',
        observedAt: null,
        cumulative: null,
        context: null,
        reason: `usage reader failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { ...p, liveness, activity, usage, livenessCheckedAt: adapter ? this.now().toISOString() : p.livenessCheckedAt };
  }
}

/** Only publish meaningful changes (not every re-check timestamp). */
function changed(a: ParticipantState, b: ParticipantState): boolean {
  const strip = (s: ParticipantState) => ({ ...s, livenessCheckedAt: null });
  return JSON.stringify(strip(a)) !== JSON.stringify(strip(b));
}
