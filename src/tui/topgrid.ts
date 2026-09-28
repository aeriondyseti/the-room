// Organised top bar (6.10, Kevin's mockup "The Room: a layout that's easier to parse"; top bar only). Two quiet,
// labelled sections — AGENTS (one aligned row per agent) and BUDGETS (a grid with the 5h / weekly headers named once) —
// and three visual weights: loud (who's busy, anything high), normal, quiet (model, branch, resets, caveats).
// Column widths are measured, never assumed. When a grid can't fit the width, it returns null and the caller falls back
// to the wrapping chip/metric lines (which never cut a value or a caveat). Honest state is unchanged: no reading is "—",
// never 0; stale / last known / login unverified stay on the row whose values they qualify.
import type { ParticipantState } from '../contracts/domain.js';
import type { AccountUsage, UsageBucket, UsageWindow } from '../contracts/account.js';
import { colorFor, cols, fitLine, lineCols, sanitize, type Line, type Segment } from './format.js';
import { contextBar, numberWidth, RESET_MARK, usageBar } from './bars.js';
import { accountNotes, activityLabel, gitLabel, harnessLabel, resetHint, shortModel, stateDot } from './topbar.js';

const GAP = '  ';
const pad = (line: Line, width: number): Line => (lineCols(line) >= width ? line : [...line, { text: ' '.repeat(width - lineCols(line)) }]);
const join = (cells: readonly Line[], widths: readonly number[]): Line =>
  cells.flatMap((c, i) => (i === cells.length - 1 ? c : [...pad(c, widths[i]!), { text: GAP }]));
/** Widest cell per column across all rows (rows may have fewer cells; no column is ever lost). */
const colWidths = (rows: readonly (readonly Line[])[]): number[] => {
  const w: number[] = [];
  for (const r of rows) r.forEach((c, i) => { w[i] = Math.max(w[i] ?? 0, lineCols(c)); });
  return w;
};
/** Trailing empty cells don't pad the row. */
const trim = (cells: Line[]): Line[] => {
  const out = [...cells];
  while (out.length && lineCols(out.at(-1)!) === 0) out.pop();
  return out;
};

const sectionLabel = (text: string): Segment => ({ text, dim: true, bold: true });

// ---- AGENTS -------------------------------------------------------------------------------------------------

function agentCells(p: ParticipantState, opts: { stale: boolean; bars: boolean; model: boolean; branch: boolean; numberWidth: number }): Line[] {
  const dot = opts.stale ? { glyph: '◌', color: 'gray' } : stateDot(p);
  const name: Line = [{ text: `${dot.glyph} `, color: dot.color }, { text: sanitize(p.name), color: opts.stale ? 'gray' : colorFor(p.name), bold: true }];
  const status = activityLabel(p);
  // Only the state word is loud: busy (and anything needing attention) bold; idle plain; the rest quiet.
  const loud = p.activity === 'busy' || status.color !== undefined;
  const state: Line = opts.stale
    ? [{ text: `last known: ${status.text}`, dim: true }]
    : [{ text: status.text, color: status.color, bold: loud, dim: !loud && p.activity !== 'idle' }];
  const cells: Line[] = [name, state, opts.stale ? [] : contextBar(p.usage, { stale: false, bar: opts.bars, numberWidth: opts.numberWidth })];
  cells.push(opts.model && p.workspace?.model ? [{ text: sanitize(shortModel(p.workspace.model)), dim: true }] : []);
  const git = opts.branch ? gitLabel(p.workspace?.git ?? null) : null;
  cells.push(git ? [{ text: git, dim: true }] : []);
  return cells;
}

/**
 * AGENTS: a label row, then one aligned row per agent (dot · name · state · ctx · model · branch). Detail is shed to
 * fit (bars → numbers, then model, then branch); agents beyond `maxRows` become "+N more · /who". Null if even the
 * leanest row can't fit.
 */
export function agentGrid(participants: readonly ParticipantState[], opts: { width: number; stale: boolean; maxRows: number }): Line[] | null {
  const title: Line = [sectionLabel(`AGENTS${opts.stale ? ' · last known' : ''}`)];
  if (participants.length === 0) return [title, [{ text: ' No agents yet · they appear here when they join', dim: true }]];
  const variants = [
    { bars: true, model: true, branch: true },
    { bars: false, model: true, branch: true },
    { bars: false, model: false, branch: true },
    { bars: false, model: false, branch: false },
  ];
  const cap = Math.max(1, opts.maxRows);
  const shown = participants.length > cap ? participants.slice(0, cap - 1) : participants;
  for (const v of variants) {
    const width = numberWidth(shown.map((p) => (p.usage?.status !== 'unavailable' ? p.usage?.context?.percent : null)));
    const rows = shown.map((p) => trim(agentCells(p, { stale: opts.stale, ...v, numberWidth: width })));
    const widths = colWidths(rows);
    const lines = rows.map((r): Line => [{ text: ' ' }, ...join(r, widths)]);
    if (lines.every((l) => lineCols(l) <= opts.width)) {
      if (shown.length < participants.length) lines.push([{ text: ` +${participants.length - shown.length} more · /who`, dim: true }]);
      return [title, ...lines];
    }
  }
  return null;
}

// ---- BUDGETS ------------------------------------------------------------------------------------------------

interface BudgetRow {
  label: string;
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  /** The account's qualifiers (on its first row only, so they sit with the values they qualify). */
  notes: string[];
  /** For an unavailable account: the reason, shown instead of cells. */
  unavailable?: string;
  stale: boolean;
}

function budgetRows(a: AccountUsage, disconnected: boolean): BudgetRow[] {
  // Quiet caveats at the line end, without parentheses (mockup): "login unverified", "stale", "last known".
  const notes = accountNotes(a, disconnected).map((n) => n.replace(/^\((.*)\)$/, '$1').replace(/^ccstatusline, /, ''));
  const stale = a.status === 'stale' || disconnected;
  if (a.status === 'unavailable') return [{ label: harnessLabel(a.account.harness), fiveHour: null, weekly: null, notes: [], unavailable: a.reason ?? 'no reading yet', stale }];
  const byMinutes = (b: UsageBucket | undefined, m: number) => b?.windows.find((w) => w.durationMinutes === m) ?? null;
  const main = a.buckets.find((b) => b.id === a.account.harness) ?? a.buckets.find((b) => b.windows.some((w) => w.durationMinutes === 300)) ?? a.buckets[0];
  const rows: BudgetRow[] = [{ label: harnessLabel(a.account.harness), fiveHour: byMinutes(main, 300), weekly: byMinutes(main, 10_080), notes, stale }];
  for (const b of a.buckets.filter((x) => x !== main)) {
    const weekly = byMinutes(b, 10_080) ?? b.windows[0] ?? null;
    if (weekly) rows.push({ label: sanitize(b.label ?? b.id), fiveHour: byMinutes(b, 300), weekly, notes: [], stale });
  }
  return rows;
}

/** A window's value cell: bar + right-aligned percentage, or "—" when there is no reading (never 0). */
function valueCell(w: UsageWindow | null, opts: { stale: boolean; bars: boolean; numberWidth: number }): Line {
  if (!w) return [{ text: '—', dim: true }];
  return usageBar('', w.usedPercent, { stale: opts.stale, bar: opts.bars, numberWidth: opts.numberWidth });
}

/** A window's reset cell (quiet), in its own column so reset times line up; empty when unknown. */
function resetCell(w: UsageWindow | null, now: number): Line {
  const reset = w && w.usedPercent !== null ? resetHint(w.resetsAt, now) : null;
  return reset ? [{ text: `${RESET_MARK}${reset}`, dim: true }] : [];
}

/**
 * BUDGETS: a header row naming the columns once ("BUDGETS  5h  weekly"), then one row per limit (the account, then
 * each model-specific limit such as Fable). Like pieces line up (Kevin): values, reset times and caveats each have their
 * own measured column. "—" where there is no reading. Caveats sit on the account's first row, or wrap onto a
 * continuation row when that row would be too wide; bars become numbers before that. Null if the grid can't fit even
 * then (the caller falls back to wrapped metric lines).
 */
export function budgetGrid(accounts: readonly AccountUsage[], opts: { width: number; now?: number; disconnected?: boolean }): Line[] | null {
  if (accounts.length === 0) return [];
  const now = opts.now ?? Date.now();
  const rows = accounts.flatMap((a) => budgetRows(a, !!opts.disconnected));
  const labelCell = (r: BudgetRow): Line => [{ text: ' ' }, { text: r.label, bold: true }];
  const noteCell = (r: BudgetRow): Line => (r.notes.length ? [{ text: r.notes.join(' · '), dim: true, italic: true }] : []);
  // Each value column right-aligns its percentages to its own widest number.
  const w5 = numberWidth(rows.map((r) => r.fiveHour?.usedPercent));
  const wW = numberWidth(rows.map((r) => r.weekly?.usedPercent));
  for (const bars of [true, false]) {
    const values = (r: BudgetRow): Line[] => [labelCell(r), valueCell(r.fiveHour, { stale: r.stale, bars, numberWidth: w5 }), resetCell(r.fiveHour, now), valueCell(r.weekly, { stale: r.stale, bars, numberWidth: wW }), resetCell(r.weekly, now)];
    const available = rows.filter((r) => !r.unavailable);
    const header: Line[] = [[sectionLabel('BUDGETS')], [{ text: '5h', dim: true }], [], [{ text: 'weekly', dim: true }], []];
    const widths = colWidths([header, ...available.map(values), ...rows.map((r) => [labelCell(r)])]);
    // Where the caveat column starts: after the five padded value columns (the same widths the cells are padded to).
    const noteCol = [0, 1, 2, 3, 4].reduce((sum, i) => sum + (widths[i] ?? 0) + GAP.length, 0);
    const indent = widths[0]! + GAP.length;
    const out: Line[] = [join(trim(header), widths)];
    let fits = lineCols(out[0]!) <= opts.width;
    for (const r of rows) {
      if (r.unavailable) {
        const line: Line = [...pad(labelCell(r), widths[0]!), { text: GAP }, { text: `usage unavailable — ${sanitize(r.unavailable)}`, dim: true }];
        out.push(...wrapQuiet(line, opts.width, indent));
        continue;
      }
      const cells = values(r);
      const bare = join(trim([...cells]), widths);
      if (lineCols(bare) > opts.width) fits = false;
      const note = noteCell(r);
      if (!note.length) out.push(bare);
      // The caveat goes in its own column (aligned across rows) when it fits; else on a continuation row, never cut.
      else if (noteCol + lineCols(note) <= opts.width) out.push(join([...cells, note], widths));
      else out.push(bare, ...wrapQuiet([{ text: ' '.repeat(indent) }, ...note], opts.width, indent));
    }
    if (fits) return out;
  }
  return null;
}
/** Word-wrap a (dim) line onto continuation rows indented by `indent`; never drops words. */
function wrapQuiet(line: Line, width: number, indent: number): Line[] {
  if (lineCols(line) <= width) return [line];
  const head = line.slice(0, -1);
  const last = line.at(-1)!;
  const words = last.text.split(' ');
  const out: Line[] = [];
  let current: Line = [...head, { ...last, text: '' }];
  for (const w of words) {
    const seg = current.at(-1)!;
    const next = seg.text ? `${seg.text} ${w}` : w;
    if (seg.text && lineCols(current) - cols(seg.text) + cols(next) > width) {
      out.push(current);
      current = [{ text: ' '.repeat(indent) }, { ...last, text: w }];
    } else current = [...current.slice(0, -1), { ...seg, text: next }];
  }
  out.push(current);
  return out.map((l) => (lineCols(l) > width ? fitLine(l, width) : l));
}
