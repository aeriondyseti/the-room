// Top bar (6.6): participants as compact chips across the top, replacing the left sidebar (Kevin: "the sidebar is a
// lot of empty space"). Pure line model so layout is testable; the conversation gets the full terminal width.
import type { ParticipantState } from '../contracts/domain.js';
import { colorFor, cols, fitLine, lineCols, sanitize, usageLabel, type Line, type Segment } from './format.js';

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

/** Short status for a participant. Attention states get a color; the rest stay dim. */
export function activityLabel(p: ParticipantState): { text: string; color?: string } {
  const pending = p.pending > 0 ? ` · ${p.pending} queued` : '';
  if (p.liveness === 'offline') return { text: `offline${pending}` };
  if (p.liveness === 'rebind_needed') return { text: `rebind needed${pending}`, color: 'yellow' };
  if (p.activity === 'waiting_permission') return { text: `needs approval${pending}`, color: 'yellow' };
  if (p.activity === 'unknown') return { text: `status unknown${pending}` };
  return { text: `${p.activity}${pending}` };
}

/** One participant chip: `● name status ctx N%`. While disconnected everything is greyed "last known" (invariant 3). */
export function participantChip(p: ParticipantState, opts: { stale: boolean; mono: boolean }): Line {
  const live = opts.stale ? { glyph: '◌', color: 'gray' } : livenessDot(p.liveness);
  const status = activityLabel(p);
  const chip: Line = [
    { text: `${live.glyph} `, color: live.color },
    { text: sanitize(p.name), color: opts.stale ? 'gray' : colorFor(p.name), bold: true },
    { text: ` ${opts.stale ? `last known: ${status.text}` : status.text}`, color: opts.stale ? undefined : status.color, dim: opts.stale || status.color === undefined },
  ];
  if (!opts.stale) {
    const u = usageLabel(p.usage);
    // Monochrome can't show the warning colour, so a high reading gets a "!" instead.
    chip.push({ text: ` ${u.text}${opts.mono && u.color ? '!' : ''}`, color: u.color, dim: u.dim });
  }
  return chip;
}

const GAP: Segment = { text: '   ' };

/**
 * Participant chips wrapped across at most `maxLines` lines of `width` columns; chips that don't fit are summarised
 * as "+N more · /who" (never silently dropped). A single chip wider than a line is truncated with an ellipsis.
 */
export function participantLines(participants: readonly ParticipantState[], opts: { width: number; stale: boolean; mono: boolean; maxLines: number }): Line[] {
  if (participants.length === 0) return [[{ text: 'No agents yet · they appear here when they join', dim: true }]];
  const chips = participants.map((p) => participantChip(p, opts));
  const lines: Line[] = [];
  let current: Line = [];
  let i = 0;
  for (; i < chips.length; i++) {
    const chip = chips[i]!;
    const needed = (current.length ? cols(GAP.text) : 0) + lineCols(chip);
    if (current.length && lineCols(current) + needed > opts.width) {
      lines.push(current);
      current = [];
      if (lines.length === opts.maxLines) break;
    }
    if (current.length) current.push(GAP);
    current.push(...(lineCols(chip) > opts.width ? fitLine(chip, opts.width) : chip));
  }
  if (lines.length < opts.maxLines && current.length) lines.push(current);
  const hidden = chips.length - countChips(lines);
  if (hidden > 0) {
    // Make room on the last line for the overflow marker, dropping trailing chips from it if needed.
    const more: Line = [{ text: `+${hidden} more · /who`, dim: true }];
    let last = lines.pop() ?? [];
    let extra = hidden;
    while (last.length && lineCols(last) + cols(GAP.text) + lineCols(more) > opts.width) {
      last = dropLastChip(last);
      extra++;
    }
    const marker: Line = [{ text: `+${extra} more · /who`, dim: true }];
    lines.push(last.length ? [...last, GAP, ...marker] : marker);
  }
  return lines;
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
