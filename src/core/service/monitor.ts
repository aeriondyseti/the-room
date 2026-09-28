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
  /** Work requested while a refresh is in flight: 'all', or specific names (e.g. a participant that just joined). */
  private queued: Set<string> | 'all' | null = null;
  private lastCursors: string | null = null;
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

  /** Last background error (contained; the next tick retries). */
  lastError: Error | null = null;

  /**
   * Refresh everyone (or one participant). A request arriving while a refresh is in flight is queued and runs right
   * after it (never swallowed: a participant that joins mid-run is still observed immediately). The returned promise
   * settles once all queued work is done. Never rejects: it runs from timers and fire-and-forget calls, so a
   * transient DB/registry error must not become an unhandled rejection.
   */
  refresh(only?: string): Promise<void> {
    if (!only) this.queued = 'all';
    else if (this.queued !== 'all') {
      const names = this.queued ?? new Set<string>();
      names.add(only);
      this.queued = names;
    }
    this.running ??= this.drain();
    return this.running;
  }

  private async drain(): Promise<void> {
    try {
      while (this.queued && !this.stopped) {
        const batch = this.queued;
        this.queued = null;
        try {
          await this.run(batch === 'all' ? null : batch);
        } catch (err) {
          this.lastError = err instanceof Error ? err : new Error(String(err));
        }
      }
    } finally {
      this.running = null; // synchronous with the last queue check, so no request can slip between them
    }
  }

  private async run(only: ReadonlySet<string> | null): Promise<void> {
    let participants: ParticipantState[];
    try {
      participants = await this.deps.participants();
    } catch {
      return; // registry unreadable right now; the next tick retries
    }
    for (const p of participants) {
      if (this.stopped) return;
      if (only && !only.has(p.name)) continue;
      const observed = await this.observe(p);
      // Probes and transcript reads are slow: re-read the participant and apply only the observed fields to its
      // CURRENT state, and skip it if it was removed or rebound meanwhile (never overwrite a newer binding/pending).
      const current = (await this.deps.participants()).find((c) => c.name === p.name);
      if (!current || current.harness !== p.harness || current.sessionId !== p.sessionId) continue;
      const next: ParticipantState = {
        ...current,
        liveness: observed.liveness,
        activity: observed.activity,
        usage: observed.usage,
        livenessCheckedAt: observed.livenessCheckedAt,
      };
      // Persist every check (so `who` shows a fresh livenessCheckedAt); publish only meaningful changes.
      const isNews = changed(current, next);
      if (isNews || next.livenessCheckedAt !== current.livenessCheckedAt) this.deps.save(next);
      if (isNews) this.deps.publish(next);
    }
    try {
      const cursors = this.deps.observer.exportCursors();
      const serialized = JSON.stringify(cursors);
      if (serialized !== this.lastCursors) {
        this.deps.saveCursors(cursors);
        this.lastCursors = serialized;
      }
    } catch {
      // best effort; retried next tick
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
