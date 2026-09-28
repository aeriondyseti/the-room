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
export function leftPanelFits(totalCols: number, panelWidth: number, breakpoint: number): boolean {
  return totalCols >= Math.max(breakpoint, panelWidth + 1 + MIN_CONVERSATION_WIDTH);
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

function accountBlock(a: AccountUsage, opts: { width: number; now: number; disconnected: boolean }): Line[] {
  const head: Line = [{ text: harnessLabel(a.account.harness), bold: true }];
  if (a.status === 'unavailable') return [fitLine(head, opts.width), ...wrapNote(`unavailable — ${sanitize(a.reason ?? 'no reading yet')}`, opts.width)];
  const lines: Line[] = [fitLine(head, opts.width)];
  const barred = accountWindows(a, { now: opts.now, disconnected: opts.disconnected, bars: true });
  const plain = accountWindows(a, { now: opts.now, disconnected: opts.disconnected, bars: false });
  barred.forEach((w, i) => {
    const metric = indented(w.metric, plain[i]!.metric, opts.width);
    // The reset hint follows on the same row when it fits, else on an indented continuation row.
    if (w.reset && lineCols(metric) + 1 + lineCols([w.reset]) <= opts.width) lines.push([...metric, { text: ' ' }, w.reset]);
    else {
      lines.push(metric);
      if (w.reset) lines.push(fitLine([{ text: '    ' }, w.reset], opts.width));
    }
  });
  for (const note of accountNotes(a, opts.disconnected)) lines.push(...wrapNote(note, opts.width));
  return lines;
}
/**
 * The left panel as lines of at most `width` columns and exactly `height` rows (padded). Plan usage is kept whole;
 * participants that don't fit are summarised as "+N more · /who" (never silently dropped).
 */
export function sidePanelLines(
  participants: readonly ParticipantState[],
  accounts: readonly AccountUsage[],
  opts: { width: number; height: number; stale: boolean; mono: boolean; now?: number; humanName: string },
): Line[] {
  const now = opts.now ?? Date.now();
  const title: Line = [{ text: `AGENTS${opts.stale ? ' · last known' : ''}`, dim: true, bold: true }];
  const usage: Line[] = accounts.length
    ? [[{ text: ' ' }], [{ text: 'PLAN USAGE', dim: true, bold: true }], ...accounts.flatMap((a) => accountBlock(a, { width: opts.width, now, disconnected: opts.stale }))]
    : [];
  const footer: Line[] = [[{ text: ' ' }], fitLine([{ text: `you: ${sanitize(opts.humanName)}`, dim: true }], opts.width)];
  const blocks = participants.map((p) => participantBlock(p, opts));
  // Room for participants once the title, usage and footer are placed (usage yields last, then the footer).
  const room = opts.height - 1 - usage.length - footer.length;
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
  const height = Math.max(0, opts.height);
  // Content from the top; the footer sits at the bottom of the panel (padding goes between them).
  const all = [title, ...body, ...usage].slice(0, Math.max(0, height - footer.length));
  while (all.length < height - footer.length) all.push([{ text: ' ' }]);
  all.push(...footer.slice(0, height - all.length));
  return all.map((l) => (lineCols(l) > opts.width ? fitLine(l, opts.width) : l));
}
