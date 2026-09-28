// Usage bars (6.8) with state colours (6.10), the percentage inside the bar (6.14) as one flat surface (6.15): 10 cells
// (8 when the budget grid is tight): the fill a solid state-colour background, the track a solid dim background, and the
// number (one decimal) drawn over both with no background of its own. Monochrome: reverse-video fill, ░ track.
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

/** The track's flat dim background, and the fill's colour for a stale reading (6.15). */
export const TRACK_BG = 'ansi256(237)';
export const STALE_FILL = 'ansi256(244)';
/** Label text over a bright fill: dark, for contrast; over the track it keeps the default foreground. */
export const TEXT_ON_FILL = 'black';
/** Label text over the dim track: an explicit light foreground, so it's readable whatever the terminal's theme. */
export const TEXT_ON_TRACK = 'ansi256(252)';

/**
 * The bar with its percentage INSIDE it (Kevin, 6.14 option a; 6.15: one flat surface). `cells` cells: the first
 * round(pct/100 × cells) are the FILL — a solid bright background in the state colour — and the rest the TRACK, a solid
 * dim background (no stipple glyph). The number is centred over the bar with no background of its own: each glyph sits
 * on the surface of the cell it covers. Padding spaces in `text` (column alignment) are just more surface. `text` must
 * fit the bar (callers pass cells ≥ 8; "100.0%!" is 7).
 */
export function shadedBar(percent: number, text: string, opts: { cells: number; color: string | undefined; stale: boolean; bold: boolean }): Line {
  const cells = Math.max(text.length, opts.cells);
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * cells);
  const start = Math.floor((cells - text.length) / 2);
  const out: Segment[] = [];
  for (let i = 0; i < cells; i++) {
    const inText = i >= start && i < start + text.length && text[i - start] !== ' ';
    const seg: Segment = {
      text: inText ? text[i - start]! : ' ',
      surface: i < filled ? { kind: 'fill', color: opts.stale ? undefined : opts.color } : { kind: 'track' },
      bold: inText && opts.bold,
      dim: opts.stale && inText,
    };
    const prev = out.at(-1);
    // Merge runs with the same look (fewer segments to render).
    if (prev && prev.surface?.kind === seg.surface!.kind && prev.surface?.color === seg.surface!.color && prev.bold === seg.bold && prev.dim === seg.dim) prev.text += seg.text;
    else out.push(seg);
  }
  return out;
}

/**
 * How a segment is drawn in a theme. Surfaces: in colour, a fill is a solid background in its colour (grey when stale)
 * with dark text, and the track a solid dim background with the default text colour; in monochrome (no backgrounds) a
 * fill is reverse video and the track plain, so the filled extent still shows without colour.
 */
export function surfaceStyle(seg: Segment, mono: boolean): { color?: string; backgroundColor?: string; inverse?: boolean; dim?: boolean; blank?: string } {
  if (!seg.surface) return { color: seg.color, inverse: seg.inverse, dim: seg.dim };
  const fill = seg.surface.kind === 'fill';
  // Monochrome has no backgrounds: the fill is reverse video and the track's blank cells show "░", so a bar's extent
  // (and a 0% bar) stays visible without colour.
  if (mono) return fill ? { inverse: true, dim: seg.dim } : { inverse: false, dim: seg.dim, blank: '░' };
  // Colour: flat surfaces. Label text is never dimmed on either surface (the grey fill and the "last known"/"stale"
  // labels already say stale; dim black on grey could vanish, and a label straddling fill and track should read as one).
  // Text on the track has an explicit light foreground so it's readable on any terminal theme.
  return fill
    ? { backgroundColor: seg.surface.color ?? STALE_FILL, color: TEXT_ON_FILL }
    : { backgroundColor: TRACK_BG, color: TEXT_ON_TRACK };
}
/**
 * One metric: `label [bar with "21.0%" inside]` (label quiet; the bar in the state colour), or `label 21.0%` when
 * `bar` is false (tight widths), or a bare cell when `label` is empty (the budget grid names its columns once).
 * Unknown → `label —` / `—`, no bar (never an empty 0% bar). Stale → dim and colourless (the caller labels it).
 * A fresh reading at or above 70% gets a bold "!" — never colour alone.
 */
export function usageBar(label: string, percent: number | null, opts: { stale: boolean; bar?: boolean; numberWidth?: number; cells?: number }): Line {
  // Kevin's mockup: a missing value is an em dash (never 0, never blank).
  if (percent === null) return [{ text: label ? `${label} —` : '—', dim: true }];
  const high = !opts.stale && percent >= WARN_PERCENT;
  const c = opts.stale ? undefined : usageColor(percent);
  const out: Segment[] = label ? [{ text: `${label} `, dim: true }] : [];
  // numberWidth: pad to the column's widest number so, centred in equal bars, decimals line up down a column
  // (" 9.0%" under "38.0%", and under "100.0%" when a limit is hit).
  const text = `${percent.toFixed(1).padStart(opts.numberWidth ?? 0)}%${high ? '!' : ''}`;
  // cells: the bar's width (10 by default; the budget grid may shrink it to 8 to fit — the fill is recomputed for it).
  if (opts.bar !== false) out.push(...shadedBar(percent, text.padEnd(text.length + (high ? 0 : opts.numberWidth ? 1 : 0)), { cells: opts.cells ?? BAR_CELLS, color: c, stale: opts.stale, bold: high }));
  else out.push({ text, color: c, bold: high, dim: opts.stale });
  return out;
}
/**
 * An agent's context reading as a metric (`ctx ▓▓▓▓░░░░░░ 42.0%`). Tokens without a known limit show as `ctx 12k`
 * (no bar: no percentage was observed); a stale snapshot is dim with "?"; unavailable is `ctx —`.
 */
export function contextBar(usage: UsageSnapshot | null | undefined, opts: { stale: boolean; bar?: boolean; numberWidth?: number; cells?: number; label?: string }): Line {
  // label: '' draws a bare value (the left panel supplies its own aligned "ctx" label column, 6.16).
  const label = opts.label ?? 'ctx';
  const named = (text: string) => (label ? `${label} ${text}` : text);
  if (!usage || usage.status === 'unavailable' || !usage.context) return [{ text: named('—'), dim: true }];
  const stale = opts.stale || usage.status === 'stale';
  if (usage.context.percent === null) {
    const tokens: Line = [{ text: named(compact(usage.context.usedTokens)), dim: true }];
    if (usage.status === 'stale' && !opts.stale) tokens.push({ text: '?', dim: true });
    return tokens;
  }
  const line = usageBar(label, usage.context.percent, { stale, bar: opts.bar, numberWidth: opts.numberWidth, cells: opts.cells });
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