// Activity reader (6.1): turns each participant's transcript into a bounded, pageable stream of ActivityItems.
// Read-only (never writes harness files). Presentation only: nothing here feeds delivery, identity or liveness.
//  - one stream per participant binding; `generation` bumps on a new session, a new source file, or a rotation, so
//    stale cursors are recognisable (`reset`);
//  - a new stream starts `startBytes` before the end of the transcript (older history is reported unavailable);
//  - per-stream seq is monotonic and persisted with the byte cursor, so a restart neither repeats nor skips items;
//  - retained window is bounded; evicted history is reported as `olderEvicted`, never as empty.
import { stat } from 'node:fs/promises';
import type { ActivityItem, ActivityPage, ActivityParser, ActivityRequest, ActivityStreamId } from '../contracts/activity.js';
import type { Harness } from '../contracts/domain.js';
import { claudeTranscriptPaths, codexRolloutPath } from './locate.js';
import { newCursor, readRecords, type RecordCursor } from './record-tail.js';

export interface ActivityReaderOptions {
  claudeProjectsDir: string;
  codexSessionsDir: string;
  parsers: readonly ActivityParser[];
  detailBytes: number;
  windowItems: number;
  startBytes: number;
  maxLineBytes: number;
  readBytes: number;
  now?: () => Date;
}

export interface ActivityTarget {
  participant: string;
  harness: Harness;
  sessionId: string;
}

/** Persisted per stream: enough to resume exactly where we were (no repeats, no gaps) after a service restart. */
export interface ActivityCursorState {
  stream: ActivityStreamId;
  path: string;
  cursor: RecordCursor;
  nextSeq: number;
}

interface Stream {
  id: ActivityStreamId;
  path: string | null;
  cursor: RecordCursor | null;
  nextSeq: number;
  items: ActivityItem[];
  /** True when history before the first retained item exists but isn't held (started mid-file, evicted, or restart). */
  olderUnavailable: boolean;
  unknown: number;
  malformed: number;
  oversized: number;
  lastUnknownReason: string | null;
  exists: boolean;
  checkedAt: string | null;
  backlog: boolean;
  /** No parser for this harness: reported as unavailable, never as an empty "full" stream. */
  unsupported?: boolean;
}

export class ActivityReader {
  private readonly streams = new Map<string, Stream>();
  private readonly codexCache = new Map<string, string>();
  private readonly now: () => Date;

  constructor(private readonly options: ActivityReaderOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Restore persisted cursors (e.g. after a service restart). Items before the restore are reported unavailable. */
  restore(states: readonly ActivityCursorState[]): void {
    for (const s of states) {
      this.streams.set(s.stream.participant, {
        id: s.stream, path: s.path, cursor: s.cursor, nextSeq: s.nextSeq, items: [], olderUnavailable: s.nextSeq > 1,
        unknown: 0, malformed: 0, oversized: 0, lastUnknownReason: null, exists: true, checkedAt: null, backlog: false,
      });
    }
  }

  export(): ActivityCursorState[] {
    const out: ActivityCursorState[] = [];
    for (const s of this.streams.values()) if (s.path && s.cursor) out.push({ stream: s.id, path: s.path, cursor: { ...s.cursor }, nextSeq: s.nextSeq });
    return out;
  }

  /** Forget participants that are no longer bound (bounded memory, bounded persisted state). */
  retain(participants: readonly string[]): void {
    for (const name of [...this.streams.keys()]) if (!participants.includes(name)) this.streams.delete(name);
  }

  private readonly inFlight = new Map<string, Promise<unknown>>();

  /**
   * Read anything new for this participant's current binding; returns the newly observed items (possibly none).
   * Polls are serialized per participant: a concurrent caller (e.g. an `activity` request during a timer pass) waits
   * for the one in flight, so the same bytes are never parsed twice under different seqs.
   */
  poll(target: ActivityTarget): Promise<{ stream: ActivityStreamId; items: ActivityItem[]; reset: boolean }> {
    const prev = this.inFlight.get(target.participant) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.pollNow(target));
    this.inFlight.set(target.participant, next);
    void next.finally(() => {
      if (this.inFlight.get(target.participant) === next) this.inFlight.delete(target.participant);
    }).catch(() => {});
    return next;
  }

  private async pollNow(target: ActivityTarget): Promise<{ stream: ActivityStreamId; items: ActivityItem[]; reset: boolean }> {
    const stream = await this.streamFor(target);
    const reset = stream.nextSeq === 1 && stream.items.length === 0 && stream.cursor === null;
    const parser = this.options.parsers.find((p) => p.harness === target.harness);
    stream.checkedAt = this.now().toISOString();
    stream.unsupported = !parser;
    if (!parser) return { stream: stream.id, items: [], reset: false }; // never read records we can't interpret
    if (!stream.path) {
      stream.exists = false;
      return { stream: stream.id, items: [], reset: false };
    }
    if (!stream.cursor) {
      let size: number;
      try {
        size = (await stat(stream.path)).size;
      } catch {
        stream.exists = false; // no cursor yet: the next poll starts from the tail again, never from offset 0
        return { stream: stream.id, items: [], reset };
      }
      const cursor = newCursor(stream.path);
      if (size > this.options.startBytes) {
        cursor.offset = size - this.options.startBytes;
        cursor.skipping = true; // start at the next line boundary
        stream.olderUnavailable = true;
      }
      stream.cursor = cursor;
    }
    const read = await readRecords(stream.cursor, { maxBytes: this.options.readBytes, maxLineBytes: this.options.maxLineBytes });
    stream.exists = read.exists;
    stream.backlog = read.backlog;
    if (read.rotated) {
      // A replaced/rotated source is a new stream: new generation, fresh window, old cursors become stale.
      stream.id = { ...stream.id, generation: stream.id.generation + 1 };
      stream.nextSeq = 1;
      stream.items = [];
      stream.olderUnavailable = false;
    }
    stream.malformed += read.malformed;
    stream.oversized += read.oversized;
    const fresh: ActivityItem[] = [];
    for (const record of read.records) {
      const verdict = parser.parse(record, { detailBytes: this.options.detailBytes });
      if (verdict.kind === 'unknown') {
        stream.unknown++;
        stream.lastUnknownReason = verdict.reason;
      } else if (verdict.kind === 'items') {
        for (const item of verdict.items) fresh.push({ ...item, stream: stream.id, seq: stream.nextSeq++ });
      }
    }
    if (fresh.length) {
      stream.items.push(...fresh);
      const excess = stream.items.length - this.options.windowItems;
      if (excess > 0) {
        stream.items.splice(0, excess);
        stream.olderUnavailable = true;
      }
    }
    return { stream: stream.id, items: fresh, reset: read.rotated || reset };
  }

  /** A page of retained items, per the request's direction; honest about eviction, staleness and coverage. */
  page(req: ActivityRequest): ActivityPage {
    const s = this.streams.get(req.participant);
    const limit = Math.max(1, Math.min(req.limit ?? 50, this.options.windowItems));
    if (!s) {
      return { stream: null, items: [], earliestSeq: null, lastSeq: null, hasMore: false, olderEvicted: false, reset: false,
        coverage: 'unavailable', reason: 'no activity source observed for this participant yet', checkedAt: null, backlog: false };
    }
    const reset = !!req.stream && (req.stream.sessionId !== s.id.sessionId || req.stream.generation !== s.id.generation || req.stream.harness !== s.id.harness);
    const all = s.items;
    let items: ActivityItem[];
    let hasMore: boolean;
    let reachesStart: boolean;
    if (!reset && req.afterSeq !== undefined && req.afterSeq !== null) {
      const after = all.filter((i) => i.seq > req.afterSeq!);
      items = after.slice(0, limit);
      hasMore = after.length > limit;
      reachesStart = false;
    } else if (!reset && req.beforeSeq !== undefined && req.beforeSeq !== null) {
      const before = all.filter((i) => i.seq < req.beforeSeq!);
      items = before.slice(-limit);
      hasMore = before.length > limit;
      reachesStart = !hasMore;
    } else {
      items = all.slice(-limit);
      hasMore = all.length > limit;
      reachesStart = !hasMore;
    }
    const problems: string[] = [];
    if (s.unknown) problems.push(`${s.unknown} unrecognised record${s.unknown === 1 ? '' : 's'}${s.lastUnknownReason ? ` (e.g. ${s.lastUnknownReason})` : ''}`);
    if (s.malformed) problems.push(`${s.malformed} malformed line${s.malformed === 1 ? '' : 's'}`);
    if (s.oversized) problems.push(`${s.oversized} oversized record${s.oversized === 1 ? '' : 's'} skipped`);
    const coverage = s.unsupported || !s.path || !s.exists ? 'unavailable' : problems.length ? 'partial' : 'full';
    const reason = s.unsupported
      ? `activity for ${s.id.harness} sessions isn't supported yet`
      : coverage === 'unavailable'
        ? s.path ? 'the transcript could not be read' : 'no transcript found for this session'
        : problems.join('; ') || undefined;
    return {
      stream: s.id, items, earliestSeq: all[0]?.seq ?? null, lastSeq: all.at(-1)?.seq ?? null, hasMore,
      olderEvicted: reachesStart && s.olderUnavailable, reset, coverage, ...(reason ? { reason } : {}), checkedAt: s.checkedAt, backlog: s.backlog,
    };
  }

  private async streamFor(target: ActivityTarget): Promise<Stream> {
    let s = this.streams.get(target.participant);
    if (s && (s.id.sessionId !== target.sessionId || s.id.harness !== target.harness)) {
      // Rebound to a new native session: a new stream (never mixes two sessions' activity).
      s = this.fresh(target, s.id.generation + 1);
      this.streams.set(target.participant, s);
    }
    if (!s) {
      s = this.fresh(target, 1);
      this.streams.set(target.participant, s);
    }
    const path = await this.locate(target);
    if (path === null && s.path !== null) {
      // A transient miss (locked/busy directory): keep the known source and cursor; it's just unreadable right now.
      s.exists = false;
      return s;
    }
    if (path !== s.path) {
      if (s.path !== null && path !== null) {
        // A different source file for the same session: new generation.
        const next = this.fresh(target, s.id.generation + 1);
        this.streams.set(target.participant, next);
        s = next;
      }
      s.path = path;
      s.cursor = null;
    }
    return s;
  }

  private fresh(target: ActivityTarget, generation: number): Stream {
    return {
      id: { participant: target.participant, harness: target.harness, sessionId: target.sessionId, generation },
      path: null, cursor: null, nextSeq: 1, items: [], olderUnavailable: false, unknown: 0, malformed: 0, oversized: 0,
      lastUnknownReason: null, exists: false, checkedAt: null, backlog: false,
    };
  }

  private async locate(target: ActivityTarget): Promise<string | null> {
    if (target.harness === 'claude') return (await claudeTranscriptPaths(this.options.claudeProjectsDir, target.sessionId))[0] ?? null;
    return codexRolloutPath(this.options.codexSessionsDir, target.sessionId, this.codexCache);
  }
}
