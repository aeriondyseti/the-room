// Pure formatting for the TUI: messages → styled, width-bounded lines. Rendering by lines lets the conversation
// viewport scroll precisely without measuring Ink boxes.
import type { Delivery, MessageWithDeliveries } from '../contracts/domain.js';
import { HUMAN, SYSTEM } from '../contracts/domain.js';

export interface Segment {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  inverse?: boolean;
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

/** Word-wrap to `width` columns, preserving blank lines and hard-splitting words longer than a line. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n')) {
    if (raw.trim() === '') {
      out.push(' ');
      continue;
    }
    let line = '';
    for (const word of raw.split(/(\s+)/)) {
      if (word === '') continue;
      if (/^\s+$/.test(word)) {
        if (line !== '' && line.length + 1 <= w) line += ' ';
        continue;
      }
      let rest = word;
      while (rest.length > 0) {
        const room = w - line.length;
        if (rest.length <= room) {
          line += rest;
          rest = '';
        } else if (line.trimEnd() !== '' && rest.length <= w) {
          out.push(line.trimEnd());
          line = '';
        } else {
          line += rest.slice(0, room);
          rest = rest.slice(room);
          out.push(line.trimEnd());
          line = '';
        }
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
    if (seg.text.length <= room) {
      out.push(seg);
      used += seg.text.length;
    } else {
      out.push({ ...seg, text: room > 1 ? seg.text.slice(0, room - 1) + '…' : '…' });
      used = width;
    }
  }
  return out;
}

export function lineText(line: Line): string {
  return line.map((s) => s.text).join('');
}

// ---- messages -------------------------------------------------------------------------------------------

const INDENT = '  ';

export function messageLines(item: MessageWithDeliveries, ctx: FormatContext): Line[] {
  const { message } = item;
  const lines: Line[] = [];
  const header: Line = [{ text: formatTime(message.createdAt), dim: true }, { text: ' ' }];
  if (message.kind === 'stop_request') header.push({ text: ' STOP REQUEST ', color: 'red', inverse: true, bold: true }, { text: ' ' });
  header.push({ text: displayName(message.from.name, ctx.humanName), color: colorFor(message.from.name), bold: true });
  if (message.from.identity.mode === 'declared') header.push({ text: ' (declared)', dim: true, italic: true });
  header.push({ text: ' → ', dim: true });
  if (message.addressing === 'broadcast') {
    header.push({ text: message.from.name === HUMAN ? 'everyone' : 'all', dim: true });
  } else {
    message.to.forEach((name, i) => {
      if (i > 0) header.push({ text: ', ', dim: true });
      header.push({ text: displayName(name, ctx.humanName), color: colorFor(name) });
    });
  }
  if (message.replyTo) {
    const seq = ctx.seqById.get(message.replyTo);
    header.push({ text: `  ↩ ${seq !== undefined ? `#${seq}` : 'earlier message'}`, dim: true });
  }
  header.push({ text: `  #${message.seq}`, dim: true });
  lines.push(fitLine(header, ctx.width));

  const bodyStyle: Segment = message.kind === 'system' ? { text: '', dim: true, italic: true } : { text: '' };
  for (const text of wrapText(message.body, ctx.width - INDENT.length)) {
    lines.push([{ text: INDENT }, { ...bodyStyle, text }]);
  }

  if (item.deliveries.length > 0) {
    const marks: Line = [{ text: INDENT }];
    item.deliveries.forEach((d, i) => {
      const mark = deliveryMark(d);
      if (i > 0) marks.push({ text: '  ' });
      marks.push({ text: `${mark.glyph} `, color: mark.color }, { text: displayName(d.recipient, ctx.humanName), color: mark.color, dim: mark.label === 'queued' });
      if (mark.label !== 'sent' && mark.label !== 'replied' && mark.label !== 'queued') marks.push({ text: ` ${mark.label}`, color: mark.color, dim: true });
      if (d.referenced) marks.push({ text: ' (preview + reference)', dim: true });
    });
    lines.push(fitLine(marks, ctx.width));
  }
  return lines;
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
