// Usage bars and group colours (6.8, Kevin: "use of color to make groups more distinct, and adopting the 'progress
// bar' format that my current ccstatusline config uses"). Matches his ccstatusline settings, read-only (Astra's research
// and spec): `display: "slider"` = 10 cells, U+2593 filled / U+2591 empty, no brackets, then the percentage to one
// decimal; colours from ccstatusline's 256-colour palette (colorLevel 2; chalk downsamples on 16-colour terminals).
// Colours group by MEANING and are fixed; status is carried by text ("!", "n/a", "(stale)") so it survives NO_COLOR.
import type { UsageSnapshot } from '../contracts/domain.js';
import type { Line, Segment } from './format.js';

/** Fixed group colours (ccstatusline ANSI-256 palette indices as used by Kevin's statusline). */
export const PALETTE = {
  cwd: 'ansi256(26)', // blue
  model: 'ansi256(30)', // cyan
  branch: 'ansi256(30)', // cyan
  changes: 'ansi256(96)', // magenta (dirty Git detail)
  reset: 'ansi256(96)', // magenta (reset timer)
  fiveHour: 'ansi256(140)', // brightMagenta (session / 5h usage)
  weekly: 'ansi256(111)', // brightBlue (weekly + model-specific weekly)
  context: 'ansi256(178)', // yellow (context percentage)
} as const;

export const BAR_CELLS = 10;
/** The existing high-usage threshold: a fresh reading at or above it gets a bold "!". */
export const HIGH_USAGE_PERCENT = 65;

/** ccstatusline's makeSliderBar: round(clamp(pct, 0, 100) / 100 × cells) filled cells. */
export function sliderBar(percent: number, cells = BAR_CELLS): string {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * cells);
  return '▓'.repeat(filled) + '░'.repeat(cells - filled);
}

/**
 * One metric: `label ▓▓░░░░░░░░ 21.0%` in its group colour (or `label 21.0%` when `bar` is false, for tight widths).
 * Unknown → `label n/a`, no bar (never an empty 0% bar). Stale → the whole reading dim and colourless (the caller adds
 * "(stale)" / "(last known)"). A fresh high reading keeps its group colour and gains a bold "!" — never colour alone.
 */
export function usageBar(label: string, percent: number | null, color: string, opts: { stale: boolean; bar?: boolean }): Line {
  if (percent === null) return [{ text: `${label} n/a`, dim: true }];
  const high = !opts.stale && percent >= HIGH_USAGE_PERCENT;
  const c = opts.stale ? undefined : color;
  const out: Segment[] = [{ text: `${label} `, color: c, dim: opts.stale }];
  if (opts.bar !== false) out.push({ text: `${sliderBar(percent)} `, color: c, dim: opts.stale });
  out.push({ text: `${percent.toFixed(1)}%${high ? '!' : ''}`, color: c, bold: high, dim: opts.stale });
  return out;
}

/**
 * An agent's context reading as a metric (`ctx ▓▓▓▓░░░░░░ 42.0%`, yellow). Tokens without a known limit show as
 * `ctx 12k` (no bar: no percentage was observed); a stale snapshot is dim with "?"; unavailable is `ctx n/a`.
 */
export function contextBar(usage: UsageSnapshot | null | undefined, opts: { stale: boolean; bar?: boolean }): Line {
  if (!usage || usage.status === 'unavailable' || !usage.context) return [{ text: 'ctx n/a', dim: true }];
  const stale = opts.stale || usage.status === 'stale';
  if (usage.context.percent === null) {
    const tokens: Line = [{ text: `ctx ${compact(usage.context.usedTokens)}`, color: stale ? undefined : PALETTE.context, dim: stale }];
    if (usage.status === 'stale' && !opts.stale) tokens.push({ text: '?', dim: true });
    return tokens;
  }
  const line = usageBar('ctx', usage.context.percent, PALETTE.context, { stale, bar: opts.bar });
  if (usage.status === 'stale' && !opts.stale) line.push({ text: '?', dim: true });
  return line;
}

function compact(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);
}
