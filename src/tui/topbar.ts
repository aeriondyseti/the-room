// Top bar (6.6): participants as compact chips across the top, replacing the left sidebar (Kevin: "the sidebar is a
// lot of empty space"). Pure line model so layout is testable; the conversation gets the full terminal width.
import type { ParticipantState } from '../contracts/domain.js';
import type { AccountUsage, UsageBucket, UsageWindow } from '../contracts/account.js';
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

function pctSegments(label: string, w: UsageWindow | undefined, opts: { mono: boolean; stale: boolean; now: number }): Line {
  if (!w || w.usedPercent === null) return [{ text: `${label} n/a`, dim: true }];
  const pct = Math.round(w.usedPercent);
  const color = opts.stale ? undefined : pct >= 85 ? 'red' : pct >= 65 ? 'yellow' : undefined;
  const reset = resetHint(w.resetsAt, opts.now);
  return [
    { text: `${label} ` , dim: true },
    { text: `${pct}%${opts.mono && color ? '!' : ''}`, color, bold: !!color, dim: opts.stale },
    ...(reset ? [{ text: ` ↻${reset}`, dim: true }] : []),
  ];
}

/** One account: pinned 5h + weekly for the main bucket, then each other bucket's weekly (e.g. "Fable weekly"). */
export function accountSegments(a: AccountUsage, opts: { mono: boolean; now?: number }): Line {
  const now = opts.now ?? Date.now();
  const name: Segment = { text: HARNESS_LABEL[a.account.harness] ?? a.account.harness, bold: true };
  if (a.status === 'unavailable') return [name, { text: ` usage unavailable — ${sanitize(a.reason ?? 'no reading yet')}`, dim: true }];
  const stale = a.status === 'stale';
  const out: Line = [name];
  const [main, ...others] = a.buckets;
  const byMinutes = (b: UsageBucket | undefined, m: number) => b?.windows.find((w) => w.durationMinutes === m);
  for (const p of PINNED) out.push({ text: '  ' }, ...pctSegments(p.label, byMinutes(main, p.minutes), { mono: opts.mono, stale, now }));
  for (const b of others) {
    const weekly = byMinutes(b, 10_080) ?? b.windows[0];
    if (!weekly) continue;
    out.push({ text: '  ' }, ...pctSegments(`${sanitize(b.label ?? b.id)} ${weekly.durationMinutes === 10_080 ? 'weekly' : ''}`.trim(), weekly, { mono: opts.mono, stale, now }));
  }
  if (stale) out.push({ text: ' (stale)', dim: true, italic: true });
  return out;
}

/** Account usage lines: all on one line when they fit, else one per account (each fitted to the width). */
export function accountLines(accounts: readonly AccountUsage[], opts: { width: number; mono: boolean; now?: number }): Line[] {
  if (accounts.length === 0) return [];
  const parts = accounts.map((a) => accountSegments(a, opts));
  const joined: Line = parts.flatMap((p, i) => (i === 0 ? p : [{ text: '   │   ', dim: true }, ...p]));
  if (lineCols(joined) <= opts.width) return [joined];
  return parts.map((p) => fitLine(p, opts.width));
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
