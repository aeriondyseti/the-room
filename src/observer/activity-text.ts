// Shared text handling for activity parsers (6.1). Two separate concerns, deliberately not mixed:
//  1. terminal safety — control characters, ESC and bidi overrides can never reach the TUI (invariant 9);
//  2. sensitive-field redaction — values under known secret-bearing keys, and well-known token shapes, are masked
//     before anything is summarised, stored or shown. This is best effort: arbitrary tool output can still contain
//     secrets we can't recognise, so we never claim universal secret detection.
import stringWidth from 'string-width';
import { ACTIVITY_SUMMARY_COLS } from '../contracts/activity.js';

/** Replace terminal-control characters (C0 except \n and \t, DEL, C1, ESC) and bidi overrides with visible symbols. */
export function terminalSafe(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/g, (ch) => {
    const code = ch.codePointAt(0)!;
    if (code === 0x1b) return '␛';
    if (code < 0x20) return String.fromCodePoint(0x2400 + code);
    if (code === 0x7f) return '␡';
    return '�';
  });
}

const SENSITIVE_KEY = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key|session[_-]?key)/i;
const TOKEN_SHAPES: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, // provider API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs
];

/** Deep-copy `value`, masking values under sensitive keys. Strings are returned untouched (see redactText). */
export function redactFields(value: unknown, depth = 0): unknown {
  if (depth > 20) return '[…]';
  if (Array.isArray(value)) return value.map((v) => redactFields(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redactFields(v, depth + 1);
    return out;
  }
  return value;
}

/** Mask well-known token shapes inside free text. */
export function redactText(text: string): string {
  return TOKEN_SHAPES.reduce((s, re) => s.replace(re, '[redacted]'), text);
}

/** One-line, terminal-safe, redacted summary no wider than ACTIVITY_SUMMARY_COLS columns. */
export function summaryLine(text: string, cols: number = ACTIVITY_SUMMARY_COLS): string {
  const one = terminalSafe(redactText(text.replace(/\s+/g, ' ').trim()));
  if (stringWidth(one) <= cols) return one;
  let out = '';
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(one)) {
    if (stringWidth(out) + stringWidth(segment) > cols - 1) break;
    out += segment;
  }
  return `${out}…`;
}

/** Bounded, terminal-safe, redacted detail body; `truncated` says whether it was cut. */
export function capDetail(text: string, maxBytes: number): { detail: string; truncated: boolean } {
  const safe = terminalSafe(redactText(text));
  const bytes = Buffer.from(safe, 'utf8');
  if (bytes.length <= maxBytes) return { detail: safe, truncated: false };
  // Cut on a character boundary (decode, drop a possibly-split trailing char).
  const cut = bytes.subarray(0, maxBytes).toString('utf8').replace(/�$/, '');
  return { detail: cut, truncated: true };
}

/** Stringify tool arguments/results for display: redact sensitive fields first, then serialise. */
export function displayJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(redactFields(value), null, 1);
  } catch {
    return '[unserialisable]';
  }
}
