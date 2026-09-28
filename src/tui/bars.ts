// Usage bars (6.8) with state colours (6.10). Bars keep the ccstatusline `slider` format from Kevin's statusline
// (Astra's research): 10 cells, U+2593 filled / U+2591 empty, no brackets, then the percentage to one decimal.
// Colour (Kevin, 6.10, mockup option "c"): a bar takes the colour of its STATE — green under 70%, amber 70–90%, red
// above 90% — so a glance tells whether anything is close to a limit. Status is also carried by text ("!", "—",
// "stale", "?") so it survives NO_COLOR.
import type { UsageSnapshot } from '../contracts/domain.js';
import type { Line, Segment } from './format.js';

/** The six-colour budget of the 6.10 mockup (default text and dim need no entry). */
export const STATE_COLOR = {
  ok: 'green',
  warn: 'ansi256(214)', // amber
  critical: 'red',
} as const;

export const BAR_CELLS = 10;
/** Amber from here (and a bold "!" for NO_COLOR). */
export const WARN_PERCENT = 70;
/** Red above this. */
export const CRITICAL_PERCENT = 90;

/** ccstatusline's makeSliderBar: round(clamp(pct, 0, 100) / 100 × cells) filled cells. */
export function sliderBar(percent: number, cells = BAR_CELLS): string {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * cells);
  return '▓'.repeat(filled) + '░'.repeat(cells - filled);
}

/** The state colour of a fresh reading: green < 70%, amber 70–90%, red > 90%. */
export function usageColor(percent: number): string {
  return percent > CRITICAL_PERCENT ? STATE_COLOR.critical : percent >= WARN_PERCENT ? STATE_COLOR.warn : STATE_COLOR.ok;
}

/**
 * One metric: `label ▓▓░░░░░░░░ 21.0%` (label quiet; bar and number in the state colour), or `label 21.0%` when `bar`
 * is false (tight widths), or a bare cell when `label` is empty (the budget grid names its columns once).
 * Unknown → `label —` / `—`, no bar (never an empty 0% bar). Stale → dim and colourless (the caller labels it).
 * A fresh reading at or above 70% gets a bold "!" — never colour alone.
 */
export function usageBar(label: string, percent: number | null, opts: { stale: boolean; bar?: boolean; numberWidth?: number; cells?: number }): Line {
  // Kevin's mockup: a missing value is an em dash (never 0, never blank).
  if (percent === null) return [{ text: label ? `${label} —` : '—', dim: true }];
  const high = !opts.stale && percent >= WARN_PERCENT;
  const c = opts.stale ? undefined : usageColor(percent);
  const out: Segment[] = label ? [{ text: `${label} `, dim: true }] : [];
  // cells: the bar's width (10 by default; the budget grid may shrink it to 8 to fit — the fill is recomputed for it).
  if (opts.bar !== false) out.push({ text: `${sliderBar(percent, opts.cells)} `, color: c, dim: opts.stale });
  // numberWidth: right-align the percentage to its column's widest number (grids), so decimals line up down a column
  // (" 9.0%" under "38.0%", and under "100.0%" when a limit is hit).
  const num = percent.toFixed(1).padStart(opts.numberWidth ?? 0);
  out.push({ text: `${num}%${high ? '!' : ''}`, color: c, bold: high, dim: opts.stale });
  return out;
}

/**
 * An agent's context reading as a metric (`ctx ▓▓▓▓░░░░░░ 42.0%`). Tokens without a known limit show as `ctx 12k`
 * (no bar: no percentage was observed); a stale snapshot is dim with "?"; unavailable is `ctx —`.
 */
export function contextBar(usage: UsageSnapshot | null | undefined, opts: { stale: boolean; bar?: boolean; numberWidth?: number }): Line {
  if (!usage || usage.status === 'unavailable' || !usage.context) return [{ text: 'ctx —', dim: true }];
  const stale = opts.stale || usage.status === 'stale';
  if (usage.context.percent === null) {
    const tokens: Line = [{ text: `ctx ${compact(usage.context.usedTokens)}`, dim: true }];
    if (usage.status === 'stale' && !opts.stale) tokens.push({ text: '?', dim: true });
    return tokens;
  }
  const line = usageBar('ctx', usage.context.percent, { stale, bar: opts.bar, numberWidth: opts.numberWidth });
  if (usage.status === 'stale' && !opts.stale) line.push({ text: '?', dim: true });
  return line;
}

function compact(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);
}

/** Width of the widest one-decimal number among these readings (for right-aligning a column); 0 when none. */
export function numberWidth(percents: readonly (number | null | undefined)[]): number {
  return Math.max(0, ...percents.map((p) => (typeof p === 'number' ? p.toFixed(1).length : 0)));
}
/**
 * The reset marker, with a trailing space (Kevin, 6.11): "↻" renders about a cell and a half wide in some terminals and
 * bled into the time after it.
 */
export const RESET_MARK = '↻ ';