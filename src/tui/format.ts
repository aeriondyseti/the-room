// Pure formatting for the TUI: messages → styled, width-bounded lines. Rendering by lines lets the conversation
// viewport scroll precisely without measuring Ink boxes. Widths are terminal columns (string-width), not UTF-16
// units, and every peer-supplied string is sanitized so it can't drive the terminal (invariants 5, 9).
import stringWidth from 'string-width';
import type { Delivery, MessageWithDeliveries, ParticipantState, UsageSnapshot } from '../contracts/domain.js';
import { HUMAN, SYSTEM } from '../contracts/domain.js';

export interface Segment {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  inverse?: boolean;
  /**
   * A bar cell's flat surface (6.15): 'fill' (solid bright background in color, the state colour) or 'track' (solid dim
   * background). Text on it has no background of its own. See bars.ts surfaceStyle for how themes render it.
   */
  surface?: { kind: 'fill' | 'track'; color?: string };
}
export type Line = Segment[];

export interface FormatContext {
  width: number;
  humanName: string;
  /** id → seq, to render reply references as `#seq`. */
  seqById: ReadonlyMap<string, number>;
}

// ---- colors ---------------------------------------------------------------------------------------------

const AGENT_PALETTE = ['cyan', 'magenta', 'green', 'blue', 'cyanBright', 'magentaBright', 'greenBright', 'blueBright'];
export const HUMAN_COLOR = 'yellow';

/** Stable color per participant name (same agent, same color, every session). */
export function colorFor(name: string): string {
  if (name === HUMAN) return HUMAN_COLOR;
  if (name === SYSTEM) return 'gray';
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return AGENT_PALETTE[h % AGENT_PALETTE.length]!;
}

export function displayName(name: string, humanName: string): string {
  return name === HUMAN ? humanName : name;
}

// ---- deliveries ---------------------------------------------------------------------------------------

export interface DeliveryMark {
  glyph: string;
  color: string;
  label: string;
}

/** One glyph per recipient. Held/waiting override the base state because they explain *why* it's queued. */
export function deliveryMark(d: Pick<Delivery, 'state' | 'held' | 'waiting'>): DeliveryMark {
  if (d.state === 'queued' && d.held) return { glyph: '⏸', color: 'yellow', label: 'held' };
  if (d.state === 'queued' && d.waiting === 'offline') return { glyph: '⋯', color: 'yellow', label: 'offline' };
  if (d.state === 'queued' && d.waiting === 'rebind_needed') return { glyph: '⚠', color: 'yellow', label: 'rebind needed' };
  switch (d.state) {
    case 'queued':
      return { glyph: '◌', color: 'gray', label: 'queued' };
    case 'submitted':
      return { glyph: '↑', color: 'cyan', label: 'sent' };
    case 'replied':
      return { glyph: '✓', color: 'green', label: 'replied' };
    case 'failed':
      return { glyph: '✗', color: 'red', label: 'failed' };
    case 'uncertain':
      return { glyph: '?', color: 'magenta', label: 'uncertain' };
  }
}

export const DELIVERY_LEGEND: readonly DeliveryMark[] = [
  deliveryMark({ state: 'queued', held: false, waiting: null }),
  deliveryMark({ state: 'submitted', held: false, waiting: null }),
  deliveryMark({ state: 'replied', held: false, waiting: null }),
  deliveryMark({ state: 'queued', held: true, waiting: null }),
  deliveryMark({ state: 'queued', held: false, waiting: 'offline' }),
  deliveryMark({ state: 'failed', held: false, waiting: null }),
  deliveryMark({ state: 'uncertain', held: false, waiting: null }),
];

// ---- text -----------------------------------------------------------------------------------------------

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Terminal columns a string occupies. */
export function cols(s: string): number {
  return stringWidth(s);
}

/**
 * Make peer-supplied text inert: control characters (C0 except newline/tab, DEL, C1), ESC, and bidirectional
 * overrides become visible symbols, so a message can't move the cursor, recolor, or reorder what's shown.
 */
export function sanitize(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/g, (ch) => {
    const code = ch.codePointAt(0)!;
    if (code === 0x1b) return '␛';
    if (code < 0x20) return String.fromCodePoint(0x2400 + code); // control pictures (␀…␟)
    if (code === 0x7f) return '␡';
    return '�';
  });
}

/** Word-wrap to `width` columns, preserving blank lines and hard-splitting words longer than a line. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const raw of sanitize(text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ')).split('\n')) {
    if (raw.trim() === '') {
      out.push(' ');
      continue;
    }
    let line = '';
    for (const word of raw.split(/( +)/)) {
      if (word === '') continue;
      if (/^ +$/.test(word)) {
        if (line !== '' && cols(line) + 1 <= w) line += ' ';
        continue;
      }
      if (cols(line) + cols(word) <= w) {
        line += word;
        continue;
      }
      if (line.trimEnd() !== '' && cols(word) <= w) {
        out.push(line.trimEnd());
        line = word;
        continue;
      }
      // Hard-split a word longer than the line, by grapheme so nothing is cut mid-character.
      for (const { segment } of graphemes.segment(word)) {
        if (cols(line) + cols(segment) > w && line !== '') {
          out.push(line.trimEnd());
          line = '';
        }
        line += segment;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Trim a line's segments to `width` columns, ending with an ellipsis when cut. */
export function fitLine(line: Line, width: number): Line {
  let used = 0;
  const out: Line = [];
  for (const seg of line) {
    if (used >= width) break;
    const room = width - used;
    const w = cols(seg.text);
    if (w <= room) {
      out.push(seg);
      used += w;
      continue;
    }
    let text = '';
    for (const { segment } of graphemes.segment(seg.text)) {
      if (cols(text) + cols(segment) > room - 1) break;
      text += segment;
    }
    out.push({ ...seg, text: text + '…' });
    used = width;
  }
  return out;
}

export function lineText(line: Line): string {
  return line.map((s) => s.text).join('');
}

export function lineCols(line: Line): number {
  return line.reduce((n, s) => n + cols(s.text), 0);
}

// ---- messages -------------------------------------------------------------------------------------------

const INDENT = '  ';

export function messageLines(item: MessageWithDeliveries, ctx: FormatContext): Line[] {
  const { message } = item;
  const lines: Line[] = [];
  const name = (n: string) => sanitize(displayName(n, ctx.humanName));

  // Header, in priority order: who said it (never dropped) › to whom › reply ref › seq (dropped first).
  const core: Line = [{ text: formatTime(message.createdAt), dim: true }, { text: ' ' }];
  if (message.kind === 'stop_request') core.push({ text: ' STOP REQUEST ', color: 'red', inverse: true, bold: true }, { text: ' ' });
  core.push({ text: name(message.from.name), color: colorFor(message.from.name), bold: true });
  if (message.from.identity.mode === 'declared') core.push({ text: ' (declared)', dim: true, italic: true });
  const recipients: Line = [{ text: ' → ', dim: true }];
  if (message.addressing === 'broadcast') {
    recipients.push({ text: message.from.name === HUMAN ? 'everyone' : 'all', dim: true });
  } else {
    message.to.forEach((n, i) => {
      if (i > 0) recipients.push({ text: ', ', dim: true });
      recipients.push({ text: name(n), color: colorFor(n) });
    });
  }
  const reply: Line = [];
  if (message.replyTo) {
    const seq = ctx.seqById.get(message.replyTo);
    reply.push({ text: `  ↩ ${seq !== undefined ? `#${seq}` : 'earlier message'}`, dim: true });
  }
  const seqPart: Line = [{ text: `  #${message.seq}`, dim: true }];
  const candidates = [
    [...core, ...recipients, ...reply, ...seqPart],
    [...core, ...recipients, ...reply],
    [...core, ...recipients],
  ];
  lines.push(fitLine(candidates.find((l) => lineCols(l) <= ctx.width) ?? candidates.at(-1)!, ctx.width));

  const bodyStyle: Segment = message.kind === 'system' ? { text: '', dim: true, italic: true } : { text: '' };
  lines.push(...bodyLines(message.body, ctx.width, bodyStyle));

  // Delivery marks wrap onto more lines rather than hiding a state behind an ellipsis (invariant 3).
  let marks: Line = [{ text: INDENT }];
  item.deliveries.forEach((d, i) => {
    const mark = deliveryMark(d);
    const chunk: Line = [{ text: `${mark.glyph} `, color: mark.color }, { text: name(d.recipient), color: mark.color, dim: mark.label === 'queued' }];
    if (mark.label !== 'sent' && mark.label !== 'replied' && mark.label !== 'queued') chunk.push({ text: ` ${mark.label}`, color: mark.color, dim: true });
    if (d.referenced) chunk.push({ text: ' (preview + reference)', dim: true });
    const sep: Line = i > 0 ? [{ text: '  ' }] : [];
    if (i > 0 && lineCols(marks) + lineCols(sep) + lineCols(chunk) > ctx.width) {
      lines.push(marks);
      marks = [{ text: INDENT }];
    } else {
      marks.push(...sep);
    }
    marks.push(...chunk);
  });
  if (item.deliveries.length > 0) lines.push(fitLine(marks, ctx.width));
  return lines;
}

const FENCE_OPEN = /^\s*(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;

/**
 * CommonMark-style opening fence: 3+ backticks or tildes plus an info string. A backtick fence whose info string
 * contains a backtick is inline code (e.g. "```npm test``` fails"), not a fence, so that line stays prose.
 */
function openFence(line: string): { ch: string; len: number; info: string } | null {
  const m = FENCE_OPEN.exec(line);
  if (!m) return null;
  const info = m[2]!.trim();
  if (m[1]![0] === '`' && info.includes('`')) return null;
  return { ch: m[1]![0]!, len: m[1]!.length, info };
}

/** A closing fence uses the same character, is at least as long as the opener, and has nothing else on the line. */
function closesFence(line: string, open: { ch: string; len: number }): boolean {
  const m = FENCE_CLOSE.exec(line);
  return !!m && m[1]![0] === open.ch && m[1]!.length >= open.len;
}

/**
 * Message body → lines. Prose is word-wrapped; fenced code blocks (``` or ~~~) keep their indentation, are
 * hard-wrapped (never re-flowed) and sit behind a gutter, so code stays readable and copyable at any width.
 * An unclosed fence runs to the end of the message.
 */
export function bodyLines(body: string, width: number, style: Segment = { text: '' }): Line[] {
  const out: Line[] = [];
  const text = body.replace(/\r\n?/g, '\n');
  let prose: string[] = [];
  const flushProse = () => {
    if (prose.length) for (const t of wrapText(prose.join('\n'), width - INDENT.length)) out.push([{ text: INDENT }, { ...style, text: t }]);
    prose = [];
  };
  let fence: { ch: string; len: number } | null = null;
  for (const raw of text.split('\n')) {
    const open: ReturnType<typeof openFence> = fence === null ? openFence(raw) : null;
    if (open) {
      flushProse();
      fence = open;
      // The whole info string is shown (wrapped, never dropped — invariant 9).
      hardWrap(sanitize(open.info || 'code'), width - INDENT.length - 2).forEach((part, i) =>
        out.push([{ text: INDENT }, { text: `${i === 0 ? '┌' : ' '} ${part}`, dim: true }]),
      );
      continue;
    }
    if (fence !== null) {
      if (closesFence(raw, fence)) {
        out.push([{ text: INDENT }, { text: '└', dim: true }]);
        fence = null;
        continue;
      }
      for (const chunk of hardWrap(sanitize(raw.replace(/\t/g, '  ')), width - INDENT.length - 2)) {
        out.push([{ text: INDENT }, { text: '│ ', dim: true }, { text: chunk }]);
      }
      continue;
    }
    prose.push(raw);
  }
  flushProse();
  if (fence !== null) out.push([{ text: INDENT }, { text: '└', dim: true }]);
  return out;
}

/** Split into ≤ width-column pieces by grapheme, keeping leading spaces (code indentation). Empty → one blank. */
function hardWrap(line: string, width: number): string[] {
  const w = Math.max(1, width);
  if (line === '') return [' '];
  const out: string[] = [];
  let cur = '';
  for (const { segment } of graphemes.segment(line)) {
    if (cols(cur) + cols(segment) > w && cur !== '') {
      out.push(cur);
      cur = '';
    }
    cur += segment;
  }
  out.push(cur);
  return out;
}

// ---- participants & usage ----------------------------------------------------------------------------------

/** "42s ago" / "5m ago" / "3h ago" / "2d ago"; honest about bad input. */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown time';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * Compact context-usage label for the participant panel. Never shows a number that wasn't observed: no snapshot
 * or `unavailable` → "usage n/a"; no known limit → absolute tokens, not a guessed percentage (invariant 3).
 * A stale reading keeps its value but is marked with "?".
 */
export function usageLabel(usage: UsageSnapshot | null): { text: string; color?: string; dim: boolean } {
  if (!usage || usage.status === 'unavailable' || !usage.context) return { text: 'usage n/a', dim: true };
  const pct = usage.context.percent;
  const text = pct !== null ? `ctx ${Math.round(pct)}%` : `ctx ${compactTokens(usage.context.usedTokens)}`;
  if (usage.status === 'stale') return { text: `${text}?`, dim: true };
  const color = pct === null ? undefined : pct >= 85 ? 'red' : pct >= 65 ? 'yellow' : undefined;
  return color ? { text, color, dim: false } : { text, dim: true };
}

/** Header summary: how many agents, and anything that needs the human's attention. */
export function participantsSummary(participants: readonly ParticipantState[]): Array<{ text: string; color?: string }> {
  const parts: Array<{ text: string; color?: string }> = [{ text: participants.length === 1 ? '1 agent' : `${participants.length} agents` }];
  if (participants.length === 0) return parts;
  parts.push({ text: `${participants.filter((p) => p.liveness === 'online').length} online` });
  const approval = participants.filter((p) => p.activity === 'waiting_permission').length;
  if (approval) parts.push({ text: `${approval} need${approval === 1 ? 's' : ''} approval`, color: 'yellow' });
  const rebind = participants.filter((p) => p.liveness === 'rebind_needed').length;
  if (rebind) parts.push({ text: `${rebind} rebind needed`, color: 'yellow' });
  return parts;
}

/** All conversation lines, with a blank separator between messages. */
export function conversationLines(items: readonly MessageWithDeliveries[], ctx: FormatContext): Line[] {
  const out: Line[] = [];
  items.forEach((item, i) => {
    if (i > 0) out.push([{ text: ' ' }]); // a space: Ink collapses empty Text to zero height
    out.push(...messageLines(item, ctx));
  });
  return out;
}
