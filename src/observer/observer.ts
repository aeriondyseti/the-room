// Read-only usage observer (ROADMAP 2.5). Never writes harness files (invariant 8); never reports usage it
// didn't observe (invariant 3): missing sources are `unavailable`, old readings are `stale`.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Harness, TargetSnapshot, UsageSnapshot } from '../contracts/domain.js';
import { readNew, type TailCursor } from './jsonl-tail.js';
import { parseClaudeRecord, parseCodexRecord, type TokenCounters } from './parsers.js';

export interface UsageObserverOptions {
  /** `<claudeConfigDir>/projects` — one sub-directory per working directory, holding `<sessionId>.jsonl`. */
  claudeProjectsDir: string;
  /** `<codexHome>/sessions` — `YYYY/MM/DD/rollout-*-<threadId>.jsonl`. */
  codexSessionsDir: string;
  staleMs: number;
  now?: () => number;
}

/** Serializable per-file state, persisted by the service (usage_cursors) so a restart doesn't re-read everything. */
export interface UsageCursor {
  harness: Harness;
  sessionId: string;
  path: string;
  offset: number;
  counters: TokenCounters;
  context: ContextReading | null;
  lastAt: string | null;
  /** Claude: last message id counted (streamed records repeat it on consecutive lines). */
  lastMessageId: string | null;
}

interface ContextReading {
  tokens: number;
  limit: number | null;
  at: string | null;
}

interface FileState {
  cursor: TailCursor;
  counters: TokenCounters;
  context: ContextReading | null;
  lastAt: string | null;
  lastMessageId: string | null;
  seenIds: Set<string>;
  sawUsage: boolean;
}

const ZERO: TokenCounters = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export class UsageObserver {
  private readonly files = new Map<string, FileState>(); // key: `${harness}\0${sessionId}\0${path}`
  private readonly codexPathCache = new Map<string, string>();
  private readonly now: () => number;

  constructor(private readonly options: UsageObserverOptions) {
    this.now = options.now ?? Date.now;
  }

  async snapshot(target: TargetSnapshot): Promise<UsageSnapshot> {
    const source = target.harness === 'claude' ? 'claude-transcript' : 'codex-token-count';
    const paths = target.harness === 'claude' ? await this.claudePaths(target.sessionId) : await this.codexPaths(target.sessionId);
    if (paths.length === 0) {
      return unavailable(source, target.harness === 'claude' ? 'no Claude transcript found for this session' : 'no Codex rollout found for this thread');
    }
    const states: FileState[] = [];
    for (const path of paths) states.push(await this.advance(target, path));
    const withUsage = states.filter((s) => s.sawUsage);
    if (withUsage.length === 0) return unavailable(source, 'no usage recorded yet');

    // Claude counters are per-response and summed across the session's files; Codex reports a running total.
    const cumulative =
      target.harness === 'claude' ? withUsage.reduce((acc, s) => addCounters(acc, s.counters), { ...ZERO }) : newestBy(withUsage, (s) => s.lastAt).counters;
    const latest = newestBy(withUsage, (s) => s.context?.at ?? s.lastAt);
    const lastAt = newestBy(withUsage, (s) => s.lastAt).lastAt;
    const stale = lastAt === null || this.now() - Date.parse(lastAt) > this.options.staleMs;
    return {
      source,
      status: stale ? 'stale' : 'ok',
      observedAt: lastAt,
      cumulative: { ...cumulative },
      context: latest.context
        ? {
            usedTokens: latest.context.tokens,
            limitTokens: latest.context.limit,
            percent: latest.context.limit ? Math.round((latest.context.tokens / latest.context.limit) * 1000) / 10 : null,
          }
        : null,
      ...(stale ? { reason: lastAt === null ? 'reading has no timestamp' : 'no new usage recently' } : {}),
    };
  }

  exportCursors(): UsageCursor[] {
    return [...this.files.entries()].map(([key, s]) => {
      const [harness, sessionId] = key.split('\0') as [Harness, string];
      return {
        harness,
        sessionId,
        path: s.cursor.path,
        offset: s.cursor.offset,
        counters: { ...s.counters },
        context: s.context ? { ...s.context } : null,
        lastAt: s.lastAt,
        lastMessageId: s.lastMessageId,
      };
    });
  }

  restoreCursors(cursors: readonly UsageCursor[]): void {
    for (const c of cursors) {
      this.files.set(fileKey(c.harness, c.sessionId, c.path), {
        cursor: { path: c.path, offset: c.offset },
        counters: { ...c.counters },
        context: c.context ? { ...c.context } : null,
        lastAt: c.lastAt,
        lastMessageId: c.lastMessageId,
        seenIds: new Set(c.lastMessageId ? [c.lastMessageId] : []),
        sawUsage: c.lastAt !== null || c.context !== null || c.counters.output > 0 || c.counters.input > 0,
      });
    }
  }

  private async advance(target: TargetSnapshot, path: string): Promise<FileState> {
    const key = fileKey(target.harness, target.sessionId, path);
    let state = this.files.get(key);
    if (!state) {
      state = freshState(path);
      this.files.set(key, state);
    }
    // Drain the file in bounded chunks.
    for (;;) {
      const before = state.cursor.offset;
      const read = await readNew(state.cursor);
      if (read.restarted) {
        const cursor: TailCursor = state.cursor;
        state = { ...freshState(path), cursor };
        this.files.set(key, state);
      }
      for (const record of read.records) {
        if (target.harness === 'claude') applyClaude(state, record);
        else applyCodex(state, record);
      }
      if (!read.exists || state.cursor.offset === before) break;
    }
    return state;
  }

  private async claudePaths(sessionId: string): Promise<string[]> {
    if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return [];
    let dirs: string[];
    try {
      dirs = await readdir(this.options.claudeProjectsDir);
    } catch {
      return [];
    }
    const found: string[] = [];
    for (const dir of dirs) {
      const path = join(this.options.claudeProjectsDir, dir, `${sessionId}.jsonl`);
      if (await isFile(path)) found.push(path);
    }
    return found;
  }

  private async codexPaths(threadId: string): Promise<string[]> {
    const cached = this.codexPathCache.get(threadId);
    if (cached && (await isFile(cached))) return [cached];
    if (!/^[A-Za-z0-9-]+$/.test(threadId)) return [];
    const suffix = `-${threadId}.jsonl`;
    // Newest dates first: the rollout for a live thread is almost always recent.
    for (const year of await sortedDesc(this.options.codexSessionsDir)) {
      for (const month of await sortedDesc(join(this.options.codexSessionsDir, year))) {
        for (const day of await sortedDesc(join(this.options.codexSessionsDir, year, month))) {
          const dir = join(this.options.codexSessionsDir, year, month, day);
          const hit = (await safeReaddir(dir)).find((f) => f.startsWith('rollout-') && f.endsWith(suffix));
          if (hit) {
            const path = join(dir, hit);
            this.codexPathCache.set(threadId, path);
            return [path];
          }
        }
      }
    }
    return [];
  }
}

function applyClaude(state: FileState, record: unknown): void {
  const parsed = parseClaudeRecord(record);
  if (!parsed) return;
  state.sawUsage = true;
  if (parsed.messageId !== state.lastMessageId && !state.seenIds.has(parsed.messageId)) {
    state.counters = addCounters(state.counters, parsed.sample.counters);
    state.seenIds.add(parsed.messageId);
  }
  state.lastMessageId = parsed.messageId;
  if (parsed.sample.contextTokens !== null) {
    state.context = { tokens: parsed.sample.contextTokens, limit: parsed.sample.contextLimit, at: parsed.sample.at };
  }
  if (parsed.sample.at) state.lastAt = parsed.sample.at;
}

function applyCodex(state: FileState, record: unknown): void {
  const sample = parseCodexRecord(record);
  if (!sample) return;
  state.sawUsage = true;
  state.counters = { ...sample.counters }; // cumulative total: latest wins
  if (sample.contextTokens !== null) state.context = { tokens: sample.contextTokens, limit: sample.contextLimit, at: sample.at };
  if (sample.at) state.lastAt = sample.at;
}

function freshState(path: string): FileState {
  return { cursor: { path, offset: 0 }, counters: { ...ZERO }, context: null, lastAt: null, lastMessageId: null, seenIds: new Set(), sawUsage: false };
}

function unavailable(source: UsageSnapshot['source'], reason: string): UsageSnapshot {
  return { source, status: 'unavailable', observedAt: null, cumulative: null, context: null, reason };
}

function addCounters(a: TokenCounters, b: TokenCounters): TokenCounters {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

function newestBy<T>(items: T[], at: (item: T) => string | null): T {
  return items.reduce((best, item) => ((at(item) ?? '') > (at(best) ?? '') ? item : best));
}

function fileKey(harness: Harness, sessionId: string, path: string): string {
  return `${harness}\0${sessionId}\0${path}`;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function sortedDesc(dir: string): Promise<string[]> {
  return (await safeReaddir(dir)).filter((d) => /^\d+$/.test(d)).sort((a, b) => b.localeCompare(a));
}
