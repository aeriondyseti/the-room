// Top bar (6.6): participants as compact chips across the top, replacing the left sidebar (Kevin: "the sidebar is a
// lot of empty space"). Pure line model so layout is testable; the conversation gets the full terminal width.
import type { ParticipantState } from '../contracts/domain.js';
import type { AccountUsage, UsageBucket, UsageWindow } from '../contracts/account.js';
import type { GitInfo, WorkspaceInfo } from '../contracts/workspace.js';
import { colorFor, cols, fitLine, lineCols, relativeTime, sanitize, type Line, type Segment } from './format.js';
import { contextBar, STATE_COLOR, usageBar } from './bars.js';

export function livenessDot(l: ParticipantState['liveness']): { glyph: string; color: string } {
  switch (l) {
    case 'online':
      return { glyph: '●', color: 'green' };
    case 'offline':
      return { glyph: '○', color: 'gray' };
    case 'rebind_needed':
      return { glyph: '⚠', color: 'yellow' };
    case 'unknown':
      return { glyph: '◌', color: 'gray' };
  }
}

/**
 * The dot a participant shows (6.10 mockup): colour follows ACTIVITY for an online agent — green idle, amber busy or
 * waiting for approval — and liveness otherwise (offline/unknown grey, rebind needed amber). The glyph stays the
 * liveness glyph, so monochrome still tells online from offline.
 */
export function stateDot(p: ParticipantState): { glyph: string; color: string } {
  const live = livenessDot(p.liveness);
  if (p.liveness !== 'online') return live;
  if (p.activity === 'busy' || p.activity === 'waiting_permission') return { glyph: live.glyph, color: STATE_COLOR.warn };
  if (p.activity === 'idle') return { glyph: live.glyph, color: STATE_COLOR.ok };
  return { glyph: live.glyph, color: 'gray' };
}

/** Short status for a participant. Attention states get a color; the rest stay dim. */
export function activityLabel(p: ParticipantState): { text: string; color?: string } {
  const pending = p.pending > 0 ? ` · ${p.pending} queued` : '';
  if (p.liveness === 'offline') return { text: `offline${pending}` };
  if (p.liveness === 'rebind_needed') return { text: `rebind needed${pending}`, color: 'yellow' };
  if (p.activity === 'waiting_permission') return { text: `needs approval${pending}`, color: 'yellow' };
  if (p.activity === 'unknown') return { text: `status unknown${pending}` };
  return { text: `${p.activity}${pending}` };
}

/**
 * One participant chip: `● name status ctx ▓▓▓▓░░░░░░ 42.0% · model · branch*N`. Colours group by meaning (6.8): the
 * name keeps its conversation colour, context is yellow, model and branch cyan, dirty count magenta. While disconnected
 * everything is greyed "last known" (invariant 3). `bars: false` shows the context as a number only (tight widths).
 */
export function participantChip(p: ParticipantState, opts: { stale: boolean; mono: boolean; bars?: boolean }): Line {
  const live = opts.stale ? { glyph: '◌', color: 'gray' } : stateDot(p);
  const status = activityLabel(p);
  const chip: Line = [
    { text: `${live.glyph} `, color: live.color },
    { text: sanitize(p.name), color: opts.stale ? 'gray' : colorFor(p.name), bold: true },
    { text: ` ${opts.stale ? `last known: ${status.text}` : status.text}`, color: opts.stale ? undefined : status.color, dim: opts.stale || status.color === undefined },
  ];
  if (!opts.stale) chip.push({ text: ' ' }, ...contextBar(p.usage, { stale: false, bar: opts.bars !== false }));
  // 6.7: model and git in compact form (full cwd/worktree/status live in /who). Unknown parts are simply omitted.
  chip.push(...workspaceSegments(p, opts.stale));
  return chip;
}

/** ` · model · branch*N` (coloured by group; grey while disconnected), or nothing when unknown. */
export function workspaceSegments(p: ParticipantState, stale: boolean): Line {
  const out: Line = [];
  const ws = p.workspace;
  if (ws?.model) out.push({ text: ' · ', dim: true }, { text: sanitize(shortModel(ws.model)), dim: true });
  const git = gitSegments(ws?.git ?? null, stale);
  if (git.length) out.push({ text: ' · ', dim: true }, ...git);
  return out;
}

/** gitLabel as segments: branch cyan, "*N" magenta; "no git" / "git ?" dim. */
export function gitSegments(git: GitInfo | null, stale = false): Line {
  const label = gitLabel(git);
  if (!label || !git) return [];
  if (git.status !== 'ok') return [{ text: label, dim: true }];
  const star = git.dirty ? label.lastIndexOf(`*${git.dirty}`) : -1;
  const where = star >= 0 ? label.slice(0, star) : label;
  return [{ text: where, dim: true }, ...(star >= 0 ? [{ text: label.slice(star), dim: true }] : [])];
}
/** "claude-opus-5-5" → "opus-5-5"; other ids unchanged (bounded). */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, '').slice(0, 24);
}

/** "sprint/6.7*3" (3 changed files), "@a1b2c3d" when detached, "no git" / "git ?" when not a repo / unreadable. */
export function gitLabel(git: GitInfo | null): string | null {
  if (!git) return null;
  if (git.status === 'not_a_repo') return 'no git';
  if (git.status === 'unavailable') return 'git ?';
  const where = git.detached ? (git.head ? `@${git.head}` : '@detached') : git.branch;
  if (!where) return null;
  // Unique changed files (never the sum of overlapping staged/modified counts).
  return `${sanitize(where)}${git.dirty ? `*${git.dirty}` : ''}`;
}

/** /who detail line: session cwd (+ source), worktree, and git status in words; unknowns are said, not hidden. */
export function workspaceDetail(ws: WorkspaceInfo | null | undefined): string {
  if (!ws) return 'workspace not observed';
  const parts: string[] = [];
  parts.push(ws.cwd ? `cwd ${sanitize(ws.cwd)}${ws.cwdSource ? ` (${sanitize(ws.cwdSource)})` : ''}` : 'cwd unknown');
  const g = ws.git;
  if (!g) parts.push('git not sampled');
  else if (g.status !== 'ok') parts.push(g.status === 'not_a_repo' ? 'not a git repository' : `git unavailable${g.reason ? ` (${sanitize(g.reason)})` : ''}`);
  else {
    if (g.worktree) parts.push(`worktree ${sanitize(g.worktree)}`);
    parts.push(g.detached ? `detached at ${g.head ?? '?'}` : `branch ${sanitize(g.branch ?? '?')}`);
    const n = (v: number | null, label: string) => (v === null ? null : `${v} ${label}`);
    const counts = [n(g.staged, 'staged'), n(g.modified, 'modified'), n(g.untracked, 'untracked')].filter(Boolean);
    parts.push(counts.length ? counts.join(', ') : 'status unknown');
    if (g.ahead !== null || g.behind !== null) parts.push(`↑${g.ahead ?? '?'} ↓${g.behind ?? '?'}`);
    if (g.checkedAt && g.checkedAt !== ws.observedAt) parts.push(`git checked ${relativeTime(g.checkedAt)}`);
  }
  // A kept last-known snapshot must not look fresh: always say how old the observation is.
  parts.push(ws.observedAt ? `observed ${relativeTime(ws.observedAt)}` : 'not observed yet');
  return parts.join(' · ');
}

const GAP: Segment = { text: '   ' };

/**
 * Participant chips wrapped across at most `maxLines` lines of `width` columns; chips that don't fit are summarised
 * as "+N more · /who" (never silently dropped). Context bars are dropped (numbers kept) when that shows more chips or
 * avoids truncating one; a single chip still wider than a line is truncated with an ellipsis.
 */
export function participantLines(participants: readonly ParticipantState[], opts: { width: number; stale: boolean; mono: boolean; maxLines: number }): Line[] {
  if (participants.length === 0) return [[{ text: 'No agents yet · they appear here when they join', dim: true }]];
  const withBars = packChips(participants.map((p) => participantChip(p, { ...opts, bars: true })), opts.width, opts.maxLines);
  if (withBars.hidden === 0 && !withBars.truncated) return withBars.lines;
  const numeric = packChips(participants.map((p) => participantChip(p, { ...opts, bars: false })), opts.width, opts.maxLines);
  return numeric.hidden < withBars.hidden || (numeric.hidden === withBars.hidden && !numeric.truncated) ? numeric.lines : withBars.lines;
}

function packChips(chips: readonly Line[], width: number, maxLines: number): { lines: Line[]; hidden: number; truncated: boolean } {
  const lines: Line[] = [];
  let current: Line = [];
  let truncated = false;
  for (let i = 0; i < chips.length; i++) {
    const chip = chips[i]!;
    const needed = (current.length ? cols(GAP.text) : 0) + lineCols(chip);
    if (current.length && lineCols(current) + needed > width) {
      lines.push(current);
      current = [];
      if (lines.length === maxLines) break;
    }
    if (current.length) current.push(GAP);
    if (lineCols(chip) > width) truncated = true;
    current.push(...(lineCols(chip) > width ? fitLine(chip, width) : chip));
  }
  if (lines.length < maxLines && current.length) lines.push(current);
  const hidden = chips.length - countChips(lines);
  if (hidden > 0) {
    // Make room on the last line for the overflow marker, dropping trailing chips from it if needed.
    const more: Line = [{ text: `+${hidden} more · /who`, dim: true }];
    let last = lines.pop() ?? [];
    let extra = hidden;
    while (last.length && lineCols(last) + cols(GAP.text) + lineCols(more) > width) {
      last = dropLastChip(last);
      extra++;
    }
    const marker: Line = [{ text: `+${extra} more · /who`, dim: true }];
    lines.push(last.length ? [...last, GAP, ...marker] : marker);
    return { lines, hidden: extra, truncated };
  }
  return { lines, hidden: 0, truncated };
}
// ---- subscription usage (6.6) ------------------------------------------------------------------------------

const HARNESS_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
/** Kevin pinned the display to these two windows for every subscription. */
const PINNED: ReadonlyArray<{ minutes: number; label: string }> = [{ minutes: 300, label: '5h' }, { minutes: 10_080, label: 'weekly' }];

/** "in 3h12m" under a day, else "Mon 09:00"; null when unknown. */
export function resetHint(iso: string | null, now: number = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const mins = Math.max(0, Math.round((t - now) / 60_000));
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`;
  const d = new Date(t);
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function harnessLabel(harness: string): string {
  return HARNESS_LABEL[harness] ?? harness;
}

/** One quota window: the metric (`5h ▓░░░░░░░░░ 7.0%`) and its reset hint (`↻2h10m`, magenta), kept apart so the left
 * panel can move the reset to a continuation line. */
export interface WindowMetric {
  metric: Line;
  reset: Segment | null;
}

/**
 * An available account's windows: pinned 5h (brightMagenta) + weekly (brightBlue) for the main bucket, then each other
 * bucket's weekly (e.g. "Fable weekly", brightBlue). Shared by the top bar and the left panel so their values match.
 */
export function accountWindows(a: AccountUsage, opts: { now?: number; disconnected?: boolean; bars?: boolean }): WindowMetric[] {
  const now = opts.now ?? Date.now();
  const stale = a.status === 'stale' || !!opts.disconnected;
  const one = (label: string, w: UsageWindow | undefined): WindowMetric => {
    const pct = w ? w.usedPercent : null;
    const reset = pct === null ? null : resetHint(w?.resetsAt ?? null, now);
    return { metric: usageBar(label, pct, { stale, bar: opts.bars }), reset: reset ? { text: `↻${reset}`, dim: true } : null };
  };
  // The main (5h + weekly) bucket is the harness's own bucket (or one carrying a 5h window), never just the first.
  const main = a.buckets.find((b) => b.id === a.account.harness) ?? a.buckets.find((b) => b.windows.some((w) => w.durationMinutes === 300)) ?? a.buckets[0];
  const others = a.buckets.filter((b) => b !== main);
  const byMinutes = (b: UsageBucket | undefined, m: number) => b?.windows.find((w) => w.durationMinutes === m);
  const out: WindowMetric[] = PINNED.map((p) => one(p.label, byMinutes(main, p.minutes)));
  for (const b of others) {
    const weekly = byMinutes(b, 10_080) ?? b.windows[0];
    if (!weekly) continue;
    out.push(one(`${sanitize(b.label ?? b.id)} ${weekly.durationMinutes === 10_080 ? 'weekly' : ''}`.trim(), weekly));
  }
  return out;
}

/** A window as one piece: metric plus its reset hint. */
export function windowLine(w: WindowMetric): Line {
  return w.reset ? [...w.metric, { text: ' ' }, w.reset] : w.metric;
}

/** Qualifiers an account reading must carry on screen (fallback source, unverified login, staleness). */
export function accountNotes(a: AccountUsage, disconnected = false): string[] {
  const notes: string[] = [];
  if (a.fallback) notes.push('(via statusline, no model limits)');
  // (6.10, Kevin: "hide login unverified; that's almost always going to be true, so doesn't provide any useful
  // information.") The shared ccstatusline source keeps its unverified attribution in the data (source, key), not on screen.
  if (disconnected) notes.push('(last known)');
  else if (a.status === 'stale') notes.push('(stale)');
  return notes;
}

/** An account's pieces for the top bar: bold name first, then each window, then its qualifiers. */
function accountPieces(a: AccountUsage, opts: { mono: boolean; now?: number; disconnected?: boolean; bars?: boolean }): Line[] {
  const name: Line = [{ text: harnessLabel(a.account.harness), bold: true }];
  if (a.status === 'unavailable') return [[...name, { text: ` usage unavailable — ${sanitize(a.reason ?? 'no reading yet')}`, dim: true }]];
  return [name, ...accountWindows(a, opts).map(windowLine), ...accountNotes(a, !!opts.disconnected).map((n): Line => [{ text: n, dim: true, italic: true }])];
}

/** One account on one line: name, its windows, then its qualifiers. */
export function accountSegments(a: AccountUsage, opts: { mono: boolean; now?: number; disconnected?: boolean; bars?: boolean }): Line {
  const [first, ...rest] = accountPieces(a, opts);
  return rest.reduce<Line>((line, piece) => [...line, { text: '  ' }, ...piece], first ?? []);
}

/**
 * Account usage lines for the top bar: all on one line when they fit; else each account wraps whole metrics onto
 * indented continuation lines (never cutting a bar or a number). If a single metric can't fit even alone, bars are
 * dropped for plain labelled percentages; only then is anything truncated.
 */
export function accountLines(accounts: readonly AccountUsage[], opts: { width: number; mono: boolean; now?: number; disconnected?: boolean }): Line[] {
  if (accounts.length === 0) return [];
  const joined: Line = accounts.map((a) => accountSegments(a, opts)).flatMap((p, i) => (i === 0 ? p : [{ text: '   │   ', dim: true }, ...p]));
  if (lineCols(joined) <= opts.width) return [joined];
  const wrapAll = (bars: boolean) => accounts.map((a) => accountPieces(a, { ...opts, bars }));
  const fits = (pieces: Line[][]) => pieces.every((ps) => ps.every((piece, i) => lineCols(piece) + (i === 0 ? 0 : 2) <= opts.width));
  const pieces = fits(wrapAll(true)) ? wrapAll(true) : wrapAll(false);
  return pieces.flatMap((ps) => wrapPieces(ps, opts.width));
}

function wrapPieces(pieces: readonly Line[], width: number): Line[] {
  const lines: Line[] = [];
  let current: Line = [];
  for (const piece of pieces) {
    if (current.length && lineCols(current) + 2 + lineCols(piece) > width) {
      lines.push(current);
      current = [{ text: '  ' }];
    } else if (current.length) current.push({ text: '  ' });
    current.push(...piece);
  }
  if (current.length) lines.push(current);
  return lines.map((l) => (lineCols(l) > width ? fitLine(l, width) : l));
}
function countChips(lines: readonly Line[]): number {
  // Each chip starts with a liveness glyph segment ("● ", "○ ", "◌ ", "⚠ ").
  return lines.reduce((n, l) => n + l.filter((s) => /^[●○◌⚠] $/.test(s.text)).length, 0);
}

function dropLastChip(line: Line): Line {
  for (let i = line.length - 1; i >= 0; i--) {
    if (/^[●○◌⚠] $/.test(line[i]!.text)) {
      const cut = line.slice(0, i);
      return cut.length && cut.at(-1) === GAP ? cut.slice(0, -1) : cut.filter((s, j) => !(j === cut.length - 1 && s.text === GAP.text));
    }
  }
  return [];
}
