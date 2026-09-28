// Account usage monitor (6.6): samples each read-only AccountUsageProvider on a bounded interval (never per
// participant or render), keeps the last good reading, and publishes changes. Presentation only.
//  - a failed sample after a good one → `stale`: last good values kept, with the failure reason and checkedAt;
//  - never succeeded → `unavailable` with the provider's reason (values empty, never zero);
//  - a good reading older than `staleAfterMs` is also marked `stale` (values kept, labelled).
import type { AccountUsage, AccountUsageProvider } from '../../contracts/account.js';
import type { RoomEvent } from '../../contracts/ipc.js';

export interface AccountMonitorDeps {
  providers: readonly AccountUsageProvider[];
  publish(event: RoomEvent): void;
  intervalMs: number;
  staleAfterMs: number;
  now?: () => Date;
}

export class AccountMonitor {
  private readonly current = new Map<string, AccountUsage>();
  private readonly lastGood = new Map<string, AccountUsage>();
  private readonly published = new Map<string, AccountUsage>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private readonly now: () => Date;

  constructor(private readonly deps: AccountMonitorDeps) {
    this.now = deps.now ?? (() => new Date());
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

  /** Current view, one entry per source (with staleness applied at read time). */
  snapshot(): AccountUsage[] {
    return [...this.current.values()].map((a) => this.aged(a)).sort((a, b) => a.account.harness.localeCompare(b.account.harness));
  }

  /** One sampling pass over all providers (overlapping calls share it; never rejects). */
  refresh(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pass(): Promise<void> {
    for (const provider of this.deps.providers) {
      if (this.stopped) return;
      let sample: AccountUsage;
      try {
        sample = await provider.sample();
      } catch (err) {
        // Providers must not throw; if one does, treat it as a failed sample (one bad source never blocks others).
        // Fixed reason (a provider's error text could carry sensitive detail); keep the source's known identity so the
        // TUI doesn't show a phantom second entry.
        void err;
        sample = unavailable(provider, 'the usage source failed unexpectedly', this.now(), this.current.get(provider.id)?.account);
      }
      const next = this.merge(provider.id, sample);
      this.current.set(provider.id, next);
      // Compare what subscribers would SEE (age applied), so a reading that ages into `stale` is published too.
      const view = this.aged(next);
      const prevView = this.published.get(provider.id);
      if (!prevView || changed(prevView, view)) {
        this.published.set(provider.id, view);
        this.deps.publish({ type: 'account.updated', account: view });
      }
    }
  }

  private merge(id: string, sample: AccountUsage): AccountUsage {
    if (sample.status === 'ok') {
      this.lastGood.set(id, sample);
      return sample;
    }
    const good = this.lastGood.get(id);
    if (!good) return sample; // never succeeded: unavailable, as reported
    // The source identified a DIFFERENT account (e.g. the user switched logins): the old account's numbers must not
    // be shown for it, even as stale. Fall back only for the same account, or a failure that learned no identity.
    if (sample.account.scope === 'account' && sample.account.key !== good.account.key) {
      this.lastGood.delete(id);
      return sample;
    }
    // Keep the last good values, labelled stale, with this attempt's reason and time.
    return { ...good, status: 'stale', reason: sample.reason ?? 'the latest reading failed', checkedAt: sample.checkedAt ?? this.now().toISOString() };
  }

  private aged(a: AccountUsage): AccountUsage {
    if (a.status !== 'ok' || !a.observedAt) return a;
    const age = this.now().getTime() - Date.parse(a.observedAt);
    return age > this.deps.staleAfterMs ? { ...a, status: 'stale', reason: `last reading is ${Math.round(age / 60_000)} min old` } : a;
  }
}

function unavailable(provider: AccountUsageProvider, reason: string, now: Date, known?: AccountUsage['account']): AccountUsage {
  return {
    account: known ? { ...known, scope: 'profile' } : { harness: provider.harness, scope: 'profile', key: provider.id, sourceKey: provider.id },
    buckets: [], status: 'unavailable', reason, source: provider.id, checkedAt: now.toISOString(), observedAt: null,
  };
}

/** Meaningful change: anything but the attempt time. */
function changed(a: AccountUsage, b: AccountUsage): boolean {
  const strip = (x: AccountUsage) => ({ ...x, checkedAt: null });
  return JSON.stringify(strip(a)) !== JSON.stringify(strip(b));
}
