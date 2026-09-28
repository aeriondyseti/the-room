// Left-panel layout (6.8, Kevin: "a toggle to swap between top-bar and left-bar forms"). The same information as the
// top bar — participants (status, context, model, git) and plan usage per account — stacked vertically in a fixed-width
// column. Pure line model (like the top bar) so it's testable; the app draws it beside the conversation.
import type { ParticipantState } from '../contracts/domain.js';
import type { AccountUsage } from '../contracts/account.js';
import { colorFor, fitLine, lineCols, sanitize, type Line } from './format.js';
import { contextBar } from './bars.js';
import { accountWindows, accountNotes, activityLabel, harnessLabel, livenessDot, workspaceSegments } from './topbar.js';

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

/** `line` indented by two, with bars dropped to numbers only when the barred form can't fit the panel. */
function indented(withBar: Line, numeric: Line, width: number): Line {
  const pick = 2 + lineCols(withBar) <= width ? withBar : numeric;
  return fitLine([{ text: '  ' }, ...pick], width);
}

function participantBlock(p: ParticipantState, opts: { width: number; stale: boolean; mono: boolean }): Line[] {
  const live = opts.stale ? { glyph: '◌', color: 'gray' } : livenessDot(p.liveness);
  const lines: Line[] = [fitLine([{ text: `${live.glyph} `, color: live.color }, { text: sanitize(p.name), color: opts.stale ? 'gray' : colorFor(p.name), bold: true }], opts.width)];
  const status = activityLabel(p);
  lines.push(fitLine([{ text: `  ${opts.stale ? `last known: ${status.text}` : status.text}`, color: opts.stale ? undefined : status.color, dim: opts.stale || status.color === undefined }], opts.width));
  // Context: same metric (and bar) as the top bar, on its own row. Not shown while disconnected (invariant 3).
  if (!opts.stale) lines.push(indented(contextBar(p.usage, { stale: false }), contextBar(p.usage, { stale: false, bar: false }), opts.width));
  // 6.7 workspace: model and branch*dirty; omitted when unknown (full detail in /who).
  const ws = workspaceSegments(p, opts.stale).slice(1); // drop the leading " · "
  if (ws.length) lines.push(fitLine([{ text: '  ' }, ...ws], opts.width));
  return lines;
}

/** Short forms of the account qualifiers for a cramped panel (same meaning, fewer rows). */
function shortNote(note: string): string {
  if (note.includes('login unverified')) return '(login unverified)';
  if (note.includes('via statusline')) return '(statusline: no model limits)';
  return note;
}

/**
 * One account. `compact` (for short panels): numbers without bars, reset hints only when they fit on the metric's row.
 * The staleness qualifier rides on the account's own heading row, so a shown value is never separated from it.
 */
function accountBlock(a: AccountUsage, opts: { width: number; now: number; disconnected: boolean; compact: boolean }): Line[] {
  const notes = accountNotes(a, opts.disconnected);
  const isState = (n: string): boolean => n === '(stale)' || n === '(last known)';
  const state = notes.filter(isState);
  const head: Line = [{ text: harnessLabel(a.account.harness), bold: true }, ...state.map((n): Line[number] => ({ text: ` ${n}`, dim: true, italic: true }))];
  if (a.status === 'unavailable') return [fitLine(head, opts.width), ...wrapNote(`unavailable — ${sanitize(a.reason ?? 'no reading yet')}`, opts.width)];
  // Every other qualifier (unverified login, reduced source) also comes BEFORE the values (Astra's cross-review): if a
  // short panel cuts the block from the bottom, no shown value is ever left without its qualifiers.
  const lines: Line[] = [fitLine(head, opts.width), ...notes.filter((n) => !isState(n)).flatMap((n) => wrapNote(opts.compact ? shortNote(n) : n, opts.width))];
  const barred = accountWindows(a, { now: opts.now, disconnected: opts.disconnected, bars: !opts.compact });
  const plain = accountWindows(a, { now: opts.now, disconnected: opts.disconnected, bars: false });
  barred.forEach((w, i) => {
    const metric = indented(w.metric, plain[i]!.metric, opts.width);
    // The reset hint follows on the same row when it fits, else on an indented continuation row (not when compact).
    if (w.reset && lineCols(metric) + 1 + lineCols([w.reset]) <= opts.width) lines.push([...metric, { text: ' ' }, w.reset]);
    else {
      lines.push(metric);
      if (w.reset && !opts.compact) lines.push(fitLine([{ text: '    ' }, w.reset], opts.width));
    }
  });
  return lines;
}

/**
 * The left panel as lines of at most `width` columns and exactly `height` rows (padded). Participants that don't fit
 * are summarised as "+N more · /who"; plan usage that doesn't fit first drops bars and reset rows, then ends with an
 * explicit "more usage" marker — nothing is dropped silently.
 */
export function sidePanelLines(
  participants: readonly ParticipantState[],
  accounts: readonly AccountUsage[],
  opts: { width: number; height: number; stale: boolean; mono: boolean; now?: number; humanName: string },
): Line[] {
  const now = opts.now ?? Date.now();
  const height = Math.max(0, opts.height);
  const title: Line = [{ text: `AGENTS${opts.stale ? ' · last known' : ''}`, dim: true, bold: true }];
  const footer: Line[] = [[{ text: ' ' }], fitLine([{ text: `you: ${sanitize(opts.humanName)}`, dim: true }], opts.width)];
  const usageFor = (compact: boolean): Line[] =>
    accounts.length ? [[{ text: ' ' }], [{ text: 'PLAN USAGE', dim: true, bold: true }], ...accounts.flatMap((a) => accountBlock(a, { width: opts.width, now, disconnected: opts.stale, compact }))] : [];
  // Usage gets what's left after the title, the footer and one agent row (an agent or the "+N more" marker).
  const usageRoom = height - 1 - footer.length - 1;
  let usage = usageFor(false);
  if (usage.length > usageRoom) usage = usageFor(true);
  if (usage.length > usageRoom) {
    const keep = Math.max(0, usageRoom - 1);
    usage = [...usage.slice(0, keep), fitLine([{ text: '+ more usage · /layout top', dim: true }], opts.width)].slice(0, Math.max(0, usageRoom));
  }
  const blocks = participants.map((p) => participantBlock(p, opts));
  const room = height - 1 - usage.length - footer.length;
  const body: Line[] = [];
  if (participants.length === 0) body.push([{ text: 'none yet', dim: true }]);
  let shown = 0;
  for (const b of blocks) {
    const reserve = shown + 1 < blocks.length ? 1 : 0; // keep a row for "+N more" if others would follow
    if (body.length + b.length + reserve > room) break;
    body.push(...b);
    shown++;
  }
  if (shown < blocks.length) body.push([{ text: `+${blocks.length - shown} more · /who`, dim: true }]);
  // Content from the top; the footer sits at the bottom of the panel (padding goes between them). On a panel too
  // short even for this, the footer yields first.
  const all = [title, ...body, ...usage].slice(0, height);
  while (all.length < height - footer.length) all.push([{ text: ' ' }]);
  all.push(...footer.slice(0, height - all.length));
  return all.map((l) => (lineCols(l) > opts.width ? fitLine(l, opts.width) : l));
}