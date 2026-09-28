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
  /**
   * Model-specific limits (e.g. Claude's Fable weekly, a Codex model's 5h and weekly) as extra columns on the account's
   * own row (Kevin, 6.12). Keyed by column: every window a model bucket has gets one; none is dropped.
   */
  models: Map<string, UsageWindow>;
  /** The account's qualifiers, quiet at the end of its row. */
  notes: string[];
  /** For an unavailable account: the reason, shown instead of cells. */
  unavailable?: string;
  stale: boolean;
}

interface ModelColumn {
  key: string;
  header: string;
  bucket: string;
}

/** "5h" / "weekly" for the pinned windows, else the duration in hours or days (nothing when unknown). */
function durationLabel(minutes: number | null): string {
  if (minutes === null) return '';
  if (minutes === 300) return '5h';
  if (minutes === 10_080) return 'weekly';
  return minutes % 1_440 === 0 ? `${minutes / 1_440}d` : `${Math.round(minutes / 60)}h`;
}

function budgetRow(a: AccountUsage, disconnected: boolean, columns: Map<string, ModelColumn>): BudgetRow {
  // Quiet caveats at the line end, without parentheses (mockup): "stale", "last known", "via statusline, …".
  const notes = accountNotes(a, disconnected).map((n) => n.replace(/^\((.*)\)$/, '$1'));
  const stale = a.status === 'stale' || disconnected;
  const label = harnessLabel(a.account.harness);
  if (a.status === 'unavailable') return { label, fiveHour: null, weekly: null, models: new Map(), notes: [], unavailable: a.reason ?? 'no reading yet', stale };
  const byMinutes = (b: UsageBucket | undefined, m: number) => b?.windows.find((w) => w.durationMinutes === m) ?? null;
  const main = a.buckets.find((b) => b.id === a.account.harness) ?? a.buckets.find((b) => b.windows.some((w) => w.durationMinutes === 300)) ?? a.buckets[0];
  const models = new Map<string, UsageWindow>();
  for (const b of a.buckets.filter((x) => x !== main)) {
    const name = sanitize(b.label ?? b.id);
    // Columns are keyed by the bucket's stable id (labels are presentation, not identity — Astra's cross-review), the
    // window's duration and, for same-duration windows, their position; so no two readings ever share a cell.
    const seen = new Map<string, number>();
    for (const w of [...b.windows].sort((x, y) => (x.durationMinutes ?? Infinity) - (y.durationMinutes ?? Infinity))) {
      const dur = String(w.durationMinutes);
      const nth = (seen.get(dur) ?? 0) + 1;
      seen.set(dur, nth);
      const key = `${b.id}\u0000${dur}\u0000${nth}`;
      models.set(key, w);
      if (!columns.has(key)) columns.set(key, { key, header: `${name} ${durationLabel(w.durationMinutes)}${nth > 1 ? ` (${nth})` : ''}`.trim(), bucket: b.id });
    }
  }
  return { label, fiveHour: byMinutes(main, 300), weekly: byMinutes(main, 10_080), models, notes, stale };
}

/** A window's value cell: bar + right-aligned percentage, or "—" when there is no reading (never 0). */
function valueCell(w: UsageWindow | null, opts: { stale: boolean; bars: boolean; cells: number; numberWidth: number }): Line {
  if (!w) return [{ text: '—', dim: true }];
  return usageBar('', w.usedPercent, { stale: opts.stale, bar: opts.bars, cells: opts.cells, numberWidth: opts.numberWidth });
}

/** A window's reset cell (quiet), in its own column so reset times line up; empty when unknown. */
function resetCell(w: UsageWindow | null, now: number): Line {
  const reset = w && w.usedPercent !== null ? resetHint(w.resetsAt, now) : null;
  return reset ? [{ text: `${RESET_MARK}${reset}`, dim: true }] : [];
}

/** How the grid shrinks to fit (Kevin, 6.12): 10-cell bars, then 8-cell bars, then plain numbers. */
const BAR_STEPS = [{ bars: true, cells: 10 }, { bars: true, cells: 8 }, { bars: false, cells: 0 }] as const;

/**
 * BUDGETS: one row per account. Columns are named once in a header: 5h, weekly, then one column pair per
 * model-specific window (e.g. "Fable weekly", "Spark 5h") on the account's own row (Kevin, 6.12). Like pieces line up
 * (Kevin): values, reset times and caveats each have their own measured column, percentages right-aligned; a column
 * that is empty on every row takes no space. "—" where a limit has no reading; blank where an account has no such limit
 * at all (Codex has no Fable limit). Caveats go at the end of the row, or wrap onto a continuation row; never cut. Bars
 * shrink from 10 to 8 cells, then become numbers, to fit, preferring the largest size at which caveats stay inline.
 * Null if even numbers don't fit (the caller falls back to wrapped metric lines).
 */
export function budgetGrid(accounts: readonly AccountUsage[], opts: { width: number; now?: number; disconnected?: boolean }): Line[] | null {
  if (accounts.length === 0) return [];
  const now = opts.now ?? Date.now();
  const columns = new Map<string, ModelColumn>();
  const rows = accounts.map((a) => budgetRow(a, !!opts.disconnected, columns));
  const models = [...columns.values()];
  // Two different buckets with the same label (and duration) get visibly distinct headers: the bucket id is appended.
  const counts = new Map<string, number>();
  for (const m of models) counts.set(m.header, (counts.get(m.header) ?? 0) + 1);
  for (const m of models) if (counts.get(m.header)! > 1) m.header = `${m.header} [${sanitize(m.bucket)}]`;
  const labelCell = (r: BudgetRow): Line => [{ text: ' ' }, { text: r.label, bold: true }];
  const noteCell = (r: BudgetRow): Line => (r.notes.length ? [{ text: r.notes.join(' · '), dim: true, italic: true }] : []);
  // Each value column right-aligns its percentages to its own widest number.
  const w5 = numberWidth(rows.map((r) => r.fiveHour?.usedPercent));
  const wW = numberWidth(rows.map((r) => r.weekly?.usedPercent));
  const wM = models.map((m) => numberWidth(rows.map((r) => r.models.get(m.key)?.usedPercent)));
  const available = rows.filter((r) => !r.unavailable);
  // Prefer the largest bars at which every caveat also fits on its row; else the largest at which the values fit (the
  // caveats then wrap onto continuation rows).
  let valuesOnly: Line[] | null = null;
  for (const step of BAR_STEPS) {
    const v = (w: UsageWindow | null, r: BudgetRow, width: number) => valueCell(w, { stale: r.stale, bars: step.bars, cells: step.cells, numberWidth: width });
    const allValues = (r: BudgetRow): Line[] => [
      labelCell(r), v(r.fiveHour, r, w5), resetCell(r.fiveHour, now), v(r.weekly, r, wW), resetCell(r.weekly, now),
      ...models.flatMap((m, i): Line[] => {
        const w = r.models.get(m.key);
        return w ? [v(w, r, wM[i]!), resetCell(w, now)] : [[], []]; // no such limit on this account: blank, not "—"
      }),
    ];
    const allHeader: Line[] = [[sectionLabel('BUDGETS')], [{ text: '5h', dim: true }], [], [{ text: 'weekly', dim: true }], [], ...models.flatMap((m): Line[] => [[{ text: m.header, dim: true }], []])];
    // A column that is empty on every row (e.g. no reset times known) takes no space and adds no gap.
    const allWidths = colWidths([allHeader, ...available.map(allValues), ...rows.map((r) => [labelCell(r)])]);
    const keep = allWidths.map((w, i) => i === 0 || w > 0);
    const kept = <T,>(xs: readonly T[]) => xs.filter((_, i) => keep[i]);
    const values = (r: BudgetRow) => kept(allValues(r));
    const widths = kept(allWidths);
    // Where the caveat column starts: after the padded value columns (the same widths the cells are padded to).
    const noteCol = widths.reduce((sum, w) => sum + w + GAP.length, 0);
    const indent = widths[0]! + GAP.length;
    const out: Line[] = [join(trim(kept(allHeader)), widths)];
    let fits = lineCols(out[0]!) <= opts.width;
    let notesInline = true;
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
      else {
        notesInline = false;
        out.push(bare, ...wrapQuiet([{ text: ' '.repeat(indent) }, ...note], opts.width, indent));
      }
    }
    if (fits && notesInline) return out;
    if (fits) valuesOnly ??= out;
  }
  return valuesOnly;
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