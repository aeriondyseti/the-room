// Left-panel layout (6.8, Kevin: "a toggle to swap between top-bar and left-bar forms"; 6.16: organised like the top bar —
// AGENTS / BUDGETS, one shared label column so bars, numbers and resets line up). The same information as the
// top bar — participants (status, context, model, git) and plan usage per account — stacked vertically in a fixed-width
// column. Pure line model (like the top bar) so it's testable; the app draws it beside the conversation.
import type { ParticipantState } from '../contracts/domain.js';
import type { AccountUsage, UsageBucket, UsageWindow } from '../contracts/account.js';
import { colorFor, cols, fitLine, lineCols, sanitize, type Line } from './format.js';
import { contextBar, numberWidth, RESET_MARK, usageBar } from './bars.js';
import { accountNotes, activityLabel, harnessLabel, resetHint, stateDot, workspaceSegments } from './topbar.js';
import { durationLabel } from './topgrid.js';

export type TuiLayout = 'top' | 'left';
export const TUI_LAYOUTS: readonly TuiLayout[] = ['top', 'left'];
export function isTuiLayout(v: unknown): v is TuiLayout {
  return v === 'top' || v === 'left';
}

/** Below this conversation width the left panel yields to the top bar (a layout guard, not a preference). */
export const MIN_CONVERSATION_WIDTH = 50;

/** Whether the left panel fits: the conversation must keep a readable width whatever the tunables say. */
export function leftPanelMinCols(panelWidth: number, breakpoint: number): number {
  return Math.max(breakpoint, panelWidth + 1 + MIN_CONVERSATION_WIDTH);
}
export function leftPanelFits(totalCols: number, panelWidth: number, breakpoint: number): boolean {
  return totalCols >= leftPanelMinCols(panelWidth, breakpoint);
}

/** Word-wrap dim italic note text onto indented lines (notes are never truncated away). */
function wrapNote(text: string, width: number, indent = '  '): Line[] {
  const lines: Line[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const next = current ? `${current} ${word}` : word;
    if (current && indent.length + next.length > width) {
      lines.push([{ text: `${indent}${current}`, dim: true, italic: true }]);
      current = word;
    } else current = next;
  }
  if (current) lines.push([{ text: `${indent}${current}`, dim: true, italic: true }]);
  return lines.map((l) => (lineCols(l) > width ? fitLine(l, width) : l));
}

const pad = (line: Line, width: number): Line => (lineCols(line) >= width ? line : [...line, { text: ' '.repeat(width - lineCols(line)) }]);

/** `left` … `right` on one row of `width` (the right side is never cut; the left is truncated first). Null if even a
 * four-column left can't fit beside it. */
function spread(left: Line, right: Line, width: number): Line | null {
  const room = width - lineCols(right) - 1;
  if (room < 4) return null;
  const l = lineCols(left) > room ? fitLine(left, room) : left;
  return [...l, { text: ' '.repeat(Math.max(1, width - lineCols(l) - lineCols(right))) }, ...right];
}

// ---- panel geometry (6.16: like pieces line up down the whole panel) --------------------------------------------

interface PanelWindow {
  label: string;
  w: UsageWindow | null;
}

/** An available account's windows in panel order: 5h and weekly of the main bucket, then each model-specific window
 * named by its model ("Fable" = its weekly limit; other durations are spelled out, e.g. "Spark 5h"). */
function panelWindows(a: AccountUsage): PanelWindow[] {
  const byMinutes = (b: UsageBucket | undefined, m: number) => b?.windows.find((w) => w.durationMinutes === m) ?? null;
  const main = a.buckets.find((b) => b.id === a.account.harness) ?? a.buckets.find((b) => b.windows.some((w) => w.durationMinutes === 300)) ?? a.buckets[0];
  const out: PanelWindow[] = [{ label: '5h', w: byMinutes(main, 300) }, { label: 'weekly', w: byMinutes(main, 10_080) }];
  for (const b of a.buckets.filter((x) => x !== main)) {
    const name = sanitize(b.label ?? b.id);
    for (const w of [...b.windows].sort((x, y) => (x.durationMinutes ?? Infinity) - (y.durationMinutes ?? Infinity))) {
      // Weekly is implied by the model name; other durations are spelled out; an unobserved duration says so.
      out.push({ label: w.durationMinutes === 10_080 ? name : w.durationMinutes === null ? `${name} (?)` : `${name} ${durationLabel(w.durationMinutes)}`, w });
    }
  }
  // Two buckets with the same label keep distinct rows: the bucket id is appended to repeated labels.
  const ids = new Map<PanelWindow, string>();
  for (const b of a.buckets.filter((x) => x !== main)) for (const w of b.windows) { const pw = out.find((o) => o.w === w); if (pw) ids.set(pw, sanitize(b.id)); }
  const counts = new Map<string, number>();
  for (const o of out) counts.set(o.label, (counts.get(o.label) ?? 0) + 1);
  return out.map((o) => (counts.get(o.label)! > 1 && ids.has(o) ? { ...o, label: `${o.label} [${ids.get(o)}]` } : o));
}

interface PanelGeom {
  width: number;
  /** One label column for the whole panel (ctx and every window label); longer labels are ellipsised to it. */
  labelW: number;
  /** Bar cells (10 or 8), or 0 for plain numbers. */
  cells: number;
  /** Every percentage right-aligned to the panel's widest number. */
  numW: number;
  /** Width of the value column (bar or number). */
  valueW: number;
  /** Reset times inline in their own column, or (when they can't fit) on their own row under the value column. */
  resetsInline: boolean;
  now: number;
}

function resetText(w: UsageWindow | null, now: number): string | null {
  const reset = w && w.usedPercent !== null ? resetHint(w.resetsAt, now) : null;
  return reset ? `${RESET_MARK}${reset}` : null;
}

/** Labels shrink before anything else gives way, but never below this (enough for "weekly"). */
const MIN_LABEL = 6;

/**
 * The panel's shared columns. The value (bar or number) is never cut; labels are capped (ellipsised) to what the width
 * allows; reset times stay inline if they fit, else each goes on its own row under the value — never cut (6.16 review).
 * Preference: inline resets with 10-cell bars, then 8, then numbers; only then resets on their own rows.
 */
function panelGeometry(participants: readonly ParticipantState[], accounts: readonly AccountUsage[], opts: { width: number; stale: boolean; now: number }): PanelGeom {
  const windows = accounts.filter((a) => a.status !== 'unavailable').flatMap(panelWindows);
  const ctx = opts.stale ? [] : participants.map((p) => (p.usage?.status !== 'unavailable' ? p.usage?.context?.percent ?? null : null));
  const widest = Math.max(opts.stale || participants.length === 0 ? 0 : 3, ...windows.map((w) => cols(w.label)));
  const numW = numberWidth([...ctx, ...windows.map((w) => w.w?.usedPercent)]);
  const resetW = Math.max(0, ...windows.map((w) => cols(resetText(w.w, opts.now) ?? '')));
  const numberOnlyW = numW + 2; // "99.9%!"
  const minLabel = Math.min(widest, MIN_LABEL);
  for (const resetsInline of [true, false]) {
    for (const cells of [10, 8, 0]) {
      const valueW = cells ? Math.max(cells, numberOnlyW) : numberOnlyW;
      const fixed = 2 + 1 + valueW + (resetsInline && resetW ? 2 + resetW : 0);
      // With resets on their own rows they start at the value column, so the label also leaves room for the widest reset.
      const labelW = Math.min(widest, opts.width - fixed, resetsInline || !resetW ? Infinity : opts.width - 3 - resetW);
      if (labelW >= minLabel) return { width: opts.width, labelW, cells, numW, valueW, resetsInline, now: opts.now };
    }
  }
  // Absurdly narrow: numbers, resets on their own rows, whatever label room is left.
  return { width: opts.width, labelW: Math.max(1, opts.width - 3 - numberOnlyW), cells: 0, numW, valueW: numberOnlyW, resetsInline: false, now: opts.now };
}

/** `  label value  ↻ reset` in the panel's shared columns (the reset on its own row under the value when it can't be
 * inline). The label is ellipsised to the label column; the value and reset are never cut. */
function metricRows(label: string, value: Line, reset: string | null, g: PanelGeom): Line[] {
  const lab: Line = cols(label) > g.labelW ? fitLine([{ text: label, dim: true }], g.labelW) : [{ text: label, dim: true }];
  const row: Line = [{ text: '  ' }, ...pad(lab, g.labelW), { text: ' ' }, ...(reset && g.resetsInline ? pad(value, g.valueW) : value)];
  if (!reset) return [row];
  if (g.resetsInline) return [[...row, { text: '  ' }, { text: reset, dim: true }]];
  return [row, [{ text: ' '.repeat(2 + g.labelW + 1) }, { text: reset, dim: true }]];
}
function participantBlock(p: ParticipantState, opts: { stale: boolean }, g: PanelGeom): { head: Line[]; detail: Line[] } {
  const live = opts.stale ? { glyph: '◌', color: 'gray' } : stateDot(p);
  const name: Line = [{ text: `${live.glyph} `, color: live.color }, { text: sanitize(p.name), color: opts.stale ? 'gray' : colorFor(p.name), bold: true }];
  const status = activityLabel(p);
  // Only the state word is loud: busy (and anything needing attention) bold; idle plain; the rest quiet.
  const loud = !opts.stale && (p.activity === 'busy' || status.color !== undefined);
  const state: Line = opts.stale
    ? [{ text: `last known: ${status.text}`, dim: true }]
    : [{ text: status.text, color: status.color, bold: loud, dim: !loud && p.activity !== 'idle' }];
  const head = spread(name, state, g.width);
  const heads: Line[] = head ? [head] : [fitLine(name, g.width), fitLine([{ text: '  ' }, ...state], g.width)];
  const lines: Line[] = [];
  // Context in the panel's shared label/value columns. Not shown while disconnected (invariant 3).
  if (!opts.stale) lines.push(...metricRows('ctx', contextBar(p.usage, { stale: false, bar: g.cells > 0, cells: g.cells || undefined, numberWidth: g.numW, label: '' }), null, g));
  // 6.7 workspace: model and branch*dirty, quiet; omitted when unknown (full detail in /who).
  const ws = workspaceSegments(p, opts.stale).slice(1); // drop the leading " · "
  if (ws.length) lines.push(fitLine([{ text: '  ' }, ...ws], g.width));
  return { head: heads, detail: lines };
}

/** Agents a short panel must never hide behind "+N more": needing approval, rebind, or otherwise flagged. */
function needsAttention(p: ParticipantState): boolean {
  return p.activity === 'waiting_permission' || p.liveness === 'rebind_needed' || activityLabel(p).color !== undefined;
}

/** Short forms of the account qualifiers for a cramped panel (same meaning, fewer rows). */
function shortNote(note: string): string {
  if (note.includes('via statusline')) return '(statusline: no model limits)';
  return note;
}

/**
 * One account: its heading (with stale / last known right-aligned), any other qualifier wrapped under the heading
 * BEFORE the values (so a short panel cut from the bottom never leaves a value without its qualifiers — Astra's
 * cross-review), then one row per window in the panel's shared columns. "—" in the value column where there's no reading.
 */
function accountBlock(a: AccountUsage, opts: { disconnected: boolean; compact: boolean }, g: PanelGeom): Line[] {
  const notes = accountNotes(a, opts.disconnected);
  const isState = (n: string): boolean => n === '(stale)' || n === '(last known)';
  const name: Line = [{ text: harnessLabel(a.account.harness), bold: true }];
  const state = notes.filter(isState).map((n) => n.replace(/^\((.*)\)$/, '$1'));
  const spreadHead = state.length ? spread(name, [{ text: state.join(' · '), dim: true, italic: true }], g.width) : null;
  // The stale / last known qualifier is never dropped: right-aligned on the heading, or on its own row under it.
  const headRows: Line[] = spreadHead ? [spreadHead] : [fitLine(name, g.width), ...(state.length ? wrapNote(state.join(' · '), g.width) : [])];
  if (a.status === 'unavailable') return [...headRows, ...wrapNote(`unavailable — ${sanitize(a.reason ?? 'no reading yet')}`, g.width)];
  const stale = a.status === 'stale' || opts.disconnected;
  const lines: Line[] = [...headRows, ...notes.filter((n) => !isState(n)).flatMap((n) => wrapNote(opts.compact ? shortNote(n) : n, g.width))];
  for (const w of panelWindows(a)) {
    const value: Line = w.w ? usageBar('', w.w.usedPercent, { stale, bar: g.cells > 0, cells: g.cells || undefined, numberWidth: g.numW }) : [{ text: '—', dim: true }];
    lines.push(...metricRows(w.label, value, resetText(w.w, g.now), g));
  }
  return lines;
}

/**
 * The left panel as lines of at most `width` columns and exactly `height` rows (padded). Like pieces line up down the
 * whole panel (6.16): one label column, bars, right-aligned numbers and reset times each in their own column. Agents
 * that don't fit are summarised as "+N more · /who"; usage that doesn't fit ends with an explicit "more usage" marker —
 * nothing is dropped silently.
 */
export function sidePanelLines(
  participants: readonly ParticipantState[],
  accounts: readonly AccountUsage[],
  opts: { width: number; height: number; stale: boolean; mono: boolean; now?: number; humanName: string },
): Line[] {
  const now = opts.now ?? Date.now();
  const height = Math.max(0, opts.height);
  const g = panelGeometry(participants, accounts, { width: opts.width, stale: opts.stale, now });
  const title: Line = [{ text: `AGENTS${opts.stale ? ' · last known' : ''}`, dim: true, bold: true }];
  const footer: Line[] = [[{ text: ' ' }], fitLine([{ text: `you: ${sanitize(opts.humanName)}`, dim: true }], opts.width)];
  const usageFor = (compact: boolean): Line[] =>
    accounts.length ? [[{ text: ' ' }], [{ text: 'BUDGETS', dim: true, bold: true }], ...accounts.flatMap((a) => accountBlock(a, { disconnected: opts.stale, compact }, g))] : [];
  // Space priority (Astra's sidebar audit): every agent's identity row(s) first, then budgets, then agent detail.
  const blocks = participants.map((p) => participantBlock(p, { stale: opts.stale }, g));
  const headRows = participants.length ? blocks.reduce((n, b) => n + b.head.length, 0) : 1;
  // At least one row for budgets when there are any, so their "more usage" marker can always show (never silently absent).
  const usageRoom = Math.max(accounts.length ? 1 : 0, height - 1 - footer.length - headRows);
  let usage = usageFor(false);
  if (usage.length > usageRoom) usage = usageFor(true);
  if (usage.length > usageRoom) {
    const keep = Math.max(0, usageRoom - 1);
    usage = [...usage.slice(0, keep), fitLine([{ text: '+ more usage · /layout top', dim: true }], opts.width)].slice(0, Math.max(0, usageRoom));
  }
  const room = height - 1 - usage.length - footer.length;
  const body: Line[] = [];
  if (participants.length === 0) body.push([{ text: 'none yet', dim: true }]);
  else {
    // Which agents get a row: all if their heads fit; else those needing attention first (then panel order), keeping
    // a row for "+N more · /who". Shown agents stay in panel order.
    let chosen = blocks.map((_, i) => i);
    if (headRows > room) {
      const budget = Math.max(0, room - 1);
      const order = [...chosen].sort((x, y) => Number(needsAttention(participants[y]!)) - Number(needsAttention(participants[x]!)) || x - y);
      const pick: number[] = [];
      let used = 0;
      for (const i of order) {
        if (used + blocks[i]!.head.length > budget) continue;
        pick.push(i);
        used += blocks[i]!.head.length;
      }
      chosen = pick.sort((x, y) => x - y);
    }
    // Spare rows then add detail, the same level for every shown agent (uneven detail would read as missing data):
    // ctx + model · branch, else ctx only, else names only.
    const spare = room - chosen.reduce((n, i) => n + blocks[i]!.head.length, 0) - (chosen.length < blocks.length ? 1 : 0);
    const need = (k: number) => chosen.reduce((n, i) => n + Math.min(k, blocks[i]!.detail.length), 0);
    const level = [2, 1, 0].find((k) => need(k) <= spare) ?? 0;
    for (const i of chosen) body.push(...blocks[i]!.head, ...blocks[i]!.detail.slice(0, level));
    if (chosen.length < blocks.length) body.push([{ text: `+${blocks.length - chosen.length} more · /who`, dim: true }]);
  }
  // Content from the top; the footer sits at the bottom of the panel (padding goes between them). On a panel too
  // short even for this, the footer yields first.
  const all = [title, ...body, ...usage].slice(0, height);
  while (all.length < height - footer.length) all.push([{ text: ' ' }]);
  all.push(...footer.slice(0, height - all.length));
  return all.map((l) => (lineCols(l) > opts.width ? fitLine(l, opts.width) : l));
}