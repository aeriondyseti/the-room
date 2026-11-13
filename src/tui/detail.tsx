// Delivery detail (ROADMAP 3.3): everything the room knows about one message's per-recipient delivery — state,
// target session, reply link, and every attempt with its evidence or error. Built as wrapped lines (never cut;
// invariant 9) so the App can scroll it like the conversation. Only renders fields the service reported.
import type { Delivery, DeliveryAttempt, MessageWithDeliveries, SubmitEvidence } from '../contracts/domain.js';
import { colorFor, deliveryMark, displayName, formatTime, sanitize, wrapText, type Line } from './format.js';

export interface DetailContext {
  width: number;
  humanName: string;
  seqById: ReadonlyMap<string, number>;
  /** True while disconnected: states are last-known, not live (invariant 3). */
  stale: boolean;
}

const ACTIONABLE = new Set(['failed', 'uncertain']);

export function detailLines(item: MessageWithDeliveries, ctx: DetailContext): Line[] {
  const { message } = item;
  const out: Line[] = [];
  const w = Math.max(20, ctx.width);
  const wrapped = (text: string, indent: string, style: Omit<Line[number], 'text'> = {}): Line[] =>
    wrapText(text, w - indent.length).map((t) => [{ text: indent }, { ...style, text: t }]);

  out.push([
    { text: `Message #${message.seq}`, bold: true },
    { text: ` · ${formatTime(message.createdAt)} · from `, dim: true },
    { text: sanitize(displayName(message.from.name, ctx.humanName)), color: colorFor(message.from.name), bold: true },
    { text: ` (${message.from.identity.mode})`, dim: true },
  ]);
  if (ctx.stale) out.push([{ text: 'Disconnected — showing the last known state, not live.', color: 'yellow' }]);

  const retryable = item.deliveries.filter((d) => ACTIONABLE.has(d.state));
  if (retryable.length > 0) {
    const hint = `${retryable.map((d) => `/retry #${message.seq} @${d.recipient}`).join('  ·  ')} to re-send${
      retryable.some((d) => d.state === 'uncertain') ? ' (uncertain ones may already have arrived)' : ''
    }`;
    out.push(...wrapped(hint, '', { color: 'cyan' }));
  }
  out.push([{ text: 'PgUp/PgDn or ↑/↓ scroll · Esc to close', dim: true }]);
  out.push([{ text: ' ' }]);

  const body = wrapText(message.body, w - 2);
  body.slice(0, 3).forEach((t, i) => out.push([{ text: '  ' }, { text: t + (i === 2 && body.length > 3 ? ' …' : ''), dim: true }]));
  out.push([{ text: ' ' }]);

  if (item.deliveries.length === 0) {
    out.push([{ text: 'No agent deliveries (a log-only message).', dim: true }]);
    return out;
  }
  // Failed/uncertain first: the actionable ones are the least likely to be scrolled past.
  const ordered = [...item.deliveries].sort((a, b) => Number(ACTIONABLE.has(b.state)) - Number(ACTIONABLE.has(a.state)));
  ordered.forEach((d, i) => {
    if (i > 0) out.push([{ text: ' ' }]);
    out.push(...deliveryBlock(d, ctx, wrapped));
  });
  return out;
}

function deliveryBlock(
  d: Delivery,
  ctx: DetailContext,
  wrapped: (text: string, indent: string, style?: Omit<Line[number], 'text'>) => Line[],
): Line[] {
  const out: Line[] = [];
  const mark = deliveryMark(d);
  out.push([
    { text: `${mark.glyph} `, color: mark.color },
    { text: sanitize(displayName(d.recipient, ctx.humanName)), color: colorFor(d.recipient), bold: true },
    { text: ` ${mark.label}`, color: mark.color },
  ]);
  const replied = d.repliedBy ? ctx.seqById.get(d.repliedBy) : undefined;
  const target = `→ ${sanitize(d.target.harness)} ${sanitize(shortId(d.target.sessionId))}${
    d.repliedBy ? `  ↩ replied in ${replied !== undefined ? `#${replied}` : 'a later message'}` : ''
  }`;
  out.push(...wrapped(target, '    ', { dim: true }));
  if (d.held) out.push(...wrapped('held while the room is paused', '    ', { color: 'yellow' }));
  if (d.waiting === 'offline') out.push(...wrapped("waiting — the agent's session isn't running", '    ', { color: 'yellow' }));
  if (d.waiting === 'rebind_needed') out.push(...wrapped('waiting — the agent needs to re-join (its session changed)', '    ', { color: 'yellow' }));
  if (d.referenced) out.push(...wrapped('sent as a preview + `roundtable read` reference (too long for this harness)', '    ', { dim: true }));
  if (d.attempts.length === 0) out.push([{ text: '    no attempts yet', dim: true }]);
  for (const a of d.attempts) out.push(...attemptLines(a, wrapped));
  return out;
}

function attemptLines(a: DeliveryAttempt, wrapped: (text: string, indent: string, style?: Omit<Line[number], 'text'>) => Line[]): Line[] {
  const color = a.outcome === 'submitted' ? 'cyan' : a.outcome === 'failed' ? 'red' : a.outcome === 'uncertain' ? 'magenta' : 'gray';
  const out: Line[] = [
    [
      { text: `    attempt ${a.n} · ${formatTime(a.startedAt)} `, dim: true },
      { text: a.outcome === 'in_flight' ? 'in flight' : a.outcome, color },
      ...(a.evidence ? [{ text: `  (${evidenceText(a.evidence)})`, dim: true }] : []),
    ],
  ];
  // Which native runtime took the attempt (e.g. the codex executable and CODEX_HOME), for reconciling an uncertain one.
  if (a.runtimeContext) {
    const rc = a.runtimeContext;
    out.push(...wrapped(`via ${sanitize(rc.executable ?? `${rc.harness} (executable unresolved)`)} · home ${sanitize(rc.home)}`, '      ', { dim: true }));
  }
  if (a.error) {
    out.push(...wrapped(a.error.message, '      ', { color }));
    if (a.error.hint) out.push(...wrapped(`→ ${a.error.hint}`, '      ', { dim: true }));
  }
  return out;
}

export function evidenceText(e: SubmitEvidence): string {
  return e.kind === 'codex-queue' ? `codex queue${e.nativeId ? ` ${sanitize(shortId(e.nativeId))}` : ''}` : `pipe write to pid ${e.pid}`;
}

function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…` : id;
}
