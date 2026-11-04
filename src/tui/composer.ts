// Pure composer logic (task 3.2): parsing what the human typed into a message or a command, @name completion,
// and a tiny text-editing model. No I/O — the App turns parse results into IPC requests.

// ---- parsing --------------------------------------------------------------------------------------------

export type ComposerCommand = 'pause' | 'resume' | 'retry' | 'detail' | 'who' | 'help' | 'quit' | 'restart' | 'activity' | 'layout' | 'compact' | 'settings' | 'rename' | 'kick';

export interface CommandInfo {
  name: ComposerCommand;
  /** Argument hint shown after the name (empty = no arguments). */
  args: string;
  description: string;
}

/** The single command catalogue: /help, the `/` suggestion list and parsing all derive from it (no drift). */
export const COMMAND_CATALOGUE: readonly CommandInfo[] = [
  { name: 'activity', args: '@name', description: "an agent's tool calls, results and messages (read-only)" },
  { name: 'compact', args: '[on|off]', description: 'top bar: compact lines instead of the full grid (Ctrl+T toggles); remembered' },
  { name: 'detail', args: '[#N]', description: 'delivery detail: attempts, evidence, errors' },
  { name: 'help', args: '', description: 'keys and commands' },
  { name: 'kick', args: '@agent reason', description: 'remove an agent at once (its queued messages get a tombstone; it can rejoin)' },
  { name: 'layout', args: '[top|left]', description: 'switch between the top bar and the left panel (Ctrl+B toggles); remembered' },
  { name: 'pause', args: '[message]', description: 'hold new deliveries and ask every agent to stop' },
  { name: 'quit', args: '', description: 'leave the TUI (agents and the room keep running)' },
  { name: 'rename', args: '@old @new', description: "change an agent's name without a restart (everyone is told)" },
  { name: 'restart', args: '', description: 'restart the room service (e.g. after an upgrade); keeps queued messages' },
  { name: 'resume', args: '', description: 'release held deliveries in order' },
  { name: 'retry', args: '#N [@agent]', description: 're-send a failed or uncertain delivery' },
  { name: 'settings', args: '', description: 'room settings: hold before delivery and batching' },
  { name: 'who', args: '', description: 'participants and their status' },
];
export const COMMANDS: readonly ComposerCommand[] = COMMAND_CATALOGUE.map((c) => c.name);

/**
 * Suggestions while typing a command name: the draft is `/` plus an optional partial name and nothing else
 * (no space yet). Once arguments start, or for ordinary messages, there are none. Prefix match, catalogue order.
 */
export function commandSuggestions(draft: string): CommandInfo[] {
  const m = /^\/([a-z]*)$/i.exec(draft);
  if (!m) return [];
  const prefix = m[1]!.toLowerCase();
  return COMMAND_CATALOGUE.filter((c) => c.name.startsWith(prefix));
}

/** The draft after accepting a suggestion: `/name ` when it takes arguments, `/name` otherwise. */
export function completeCommand(info: CommandInfo): string {
  return `/${info.name}${info.args ? ' ' : ''}`;
}

/** Parse `#N` (or `N`) for /detail. */
export function parseSeqArg(args: string): number | null {
  const m = /^#?(\d+)$/.exec(args.trim());
  return m ? Number(m[1]) : null;
}

export type Parsed =
  | { kind: 'empty' }
  /** `to: null` = everyone (the human's default). */
  | { kind: 'message'; to: string[] | null; body: string }
  | { kind: 'command'; command: ComposerCommand; args: string }
  | { kind: 'error'; message: string };

const MENTION = /^@([a-z][a-z0-9_-]*)(?=\s|$)/i;

/**
 * Leading `@name` tokens address the message; everything after them is the body. No mention = everyone.
 * `@all` (alone) is an explicit broadcast. Mentions later in the text are just text.
 */
export function parseComposer(input: string, participantNames: readonly string[]): Parsed {
  const text = input.replace(/\r\n?/g, '\n');
  if (text.trim() === '') return { kind: 'empty' };
  const trimmedStart = text.trimStart();

  if (trimmedStart.startsWith('/')) {
    const m = /^\/([a-z]+)\b\s*([\s\S]*)$/i.exec(trimmedStart);
    const name = m?.[1]?.toLowerCase() ?? '';
    if ((COMMANDS as readonly string[]).includes(name)) return { kind: 'command', command: name as ComposerCommand, args: (m?.[2] ?? '').trim() };
    return { kind: 'error', message: `Unknown command "/${name}". Type /help for commands.` };
  }

  let rest = trimmedStart;
  const mentions: string[] = [];
  for (;;) {
    const m = MENTION.exec(rest);
    if (!m) break;
    mentions.push(m[1]!.toLowerCase());
    rest = rest.slice(m[0].length).replace(/^[ \t]+/, '');
  }
  const body = rest.replace(/^\n+/, '').trimEnd();
  if (body === '') return { kind: 'error', message: mentions.length ? 'Add a message after the @names.' : 'Nothing to send.' };
  if (mentions.length === 0) return { kind: 'message', to: null, body };
  if (mentions.includes('all')) {
    if (mentions.length > 1) return { kind: 'error', message: '@all already means everyone; drop the other @names.' };
    return { kind: 'message', to: null, body };
  }
  const known = new Set(participantNames);
  const unknown = mentions.filter((n) => !known.has(n));
  if (unknown.length > 0) {
    const hint = suggest(unknown[0]!, participantNames);
    return { kind: 'error', message: `No participant named @${unknown[0]}.${hint ? ` Did you mean @${hint}?` : ' /who lists participants.'}` };
  }
  return { kind: 'message', to: [...new Set(mentions)], body };
}

/** Who the draft is currently addressed to, for the always-visible To: indicator. */
export function addressee(input: string, participantNames: readonly string[]): { label: string; valid: boolean } {
  const trimmed = input.trimStart();
  if (trimmed.startsWith('/')) return { label: 'command', valid: true };
  const names: string[] = [];
  let rest = trimmed;
  for (;;) {
    const m = MENTION.exec(rest);
    if (!m) break;
    names.push(m[1]!.toLowerCase());
    rest = rest.slice(m[0].length).replace(/^[ \t]+/, '');
  }
  if (names.length === 0 || (names.length === 1 && names[0] === 'all')) return { label: 'everyone', valid: true };
  const known = new Set(participantNames);
  return { label: names.join(', '), valid: names.every((n) => known.has(n)) };
}

/** Closest participant name (prefix match first, then small edit distance). */
export function suggest(name: string, participantNames: readonly string[]): string | null {
  const prefix = participantNames.find((p) => p.startsWith(name) || name.startsWith(p));
  if (prefix) return prefix;
  let best: { name: string; d: number } | null = null;
  for (const p of participantNames) {
    const d = editDistance(name, p);
    if (d <= 2 && (!best || d < best.d)) best = { name: p, d };
  }
  return best?.name ?? null;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

// ---- /retry arguments -------------------------------------------------------------------------------------

export function parseRetryArgs(args: string): { seq: number; recipient: string | null } | { error: string } {
  const m = /^#?(\d+)(?:\s+@?([a-z][a-z0-9_-]*))?$/i.exec(args.trim());
  if (!m) return { error: 'Usage: /retry #<message number> [@agent]' };
  return { seq: Number(m[1]), recipient: m[2]?.toLowerCase() ?? null };
}

// ---- @name completion ---------------------------------------------------------------------------------------

/**
 * Complete the `@partial` word that ends at `cursor`. Repeated Tab cycles through matches (`cycle` = how many
 * times Tab was pressed in a row, starting at 0). Returns null when there is nothing to complete.
 */
export function completeMention(text: string, cursor: number, names: readonly string[], cycle = 0): { text: string; cursor: number } | null {
  const before = text.slice(0, cursor);
  const m = /(^|\s)@([a-z0-9_-]*)$/i.exec(before);
  if (!m) return null;
  const partial = m[2]!.toLowerCase();
  const matches = [...names, 'all'].filter((n) => n.startsWith(partial)).sort();
  if (matches.length === 0) return null;
  const pick = matches[cycle % matches.length]!;
  const start = cursor - partial.length;
  const after = text.slice(cursor).replace(/^[a-z0-9_-]*/i, '');
  const insert = pick + (after.startsWith(' ') ? '' : ' ');
  return { text: text.slice(0, start) + insert + after, cursor: start + insert.length };
}

// ---- editing ---------------------------------------------------------------------------------------------

export interface Draft {
  text: string;
  /** Cursor index into `text` (UTF-16 code units, always on a code-point boundary). */
  cursor: number;
}

export const EMPTY_DRAFT: Draft = { text: '', cursor: 0 };

export function insert(d: Draft, s: string): Draft {
  return { text: d.text.slice(0, d.cursor) + s + d.text.slice(d.cursor), cursor: d.cursor + s.length };
}

export function backspace(d: Draft): Draft {
  if (d.cursor === 0) return d;
  const prev = prevBoundary(d.text, d.cursor);
  return { text: d.text.slice(0, prev) + d.text.slice(d.cursor), cursor: prev };
}

export function del(d: Draft): Draft {
  if (d.cursor >= d.text.length) return d;
  const next = nextBoundary(d.text, d.cursor);
  return { text: d.text.slice(0, d.cursor) + d.text.slice(next), cursor: d.cursor };
}

export function left(d: Draft): Draft {
  return { ...d, cursor: prevBoundary(d.text, d.cursor) };
}

export function right(d: Draft): Draft {
  return { ...d, cursor: nextBoundary(d.text, d.cursor) };
}

export function home(d: Draft): Draft {
  return { ...d, cursor: d.text.lastIndexOf('\n', d.cursor - 1) + 1 };
}

export function end(d: Draft): Draft {
  const nl = d.text.indexOf('\n', d.cursor);
  return { ...d, cursor: nl === -1 ? d.text.length : nl };
}

/** The grapheme boundary before `i` (6.13: never inside a combining sequence or joined emoji). */
function prevBoundary(text: string, i: number): number {
  if (i <= 0) return 0;
  const b = graphemeBounds(text);
  let prev = 0;
  for (const x of b) {
    if (x >= i) break;
    prev = x;
  }
  return prev;
}

/** The grapheme boundary after `i`. */
function nextBoundary(text: string, i: number): number {
  if (i >= text.length) return text.length;
  return graphemeBounds(text).find((x) => x > i) ?? text.length;
}

// ---- history ------------------------------------------------------------------------------------------------

/** Shell-style history: `index` counts back from the newest entry (-1 = the live draft). */
export interface History {
  entries: string[];
  index: number;
  /** The unsent draft saved when history browsing started. */
  saved: string;
}

export const EMPTY_HISTORY: History = { entries: [], index: -1, saved: '' };

export function historyPush(h: History, entry: string, max = 100): History {
  const entries = [...h.entries.filter((e) => e !== entry), entry].slice(-max);
  return { entries, index: -1, saved: '' };
}

export function historyUp(h: History, current: string): { history: History; text: string } | null {
  if (h.entries.length === 0 || h.index >= h.entries.length - 1) return null;
  const index = h.index + 1;
  const saved = h.index === -1 ? current : h.saved;
  return { history: { ...h, index, saved }, text: h.entries[h.entries.length - 1 - index]! };
}

export function historyDown(h: History): { history: History; text: string } | null {
  if (h.index <= -1) return null;
  const index = h.index - 1;
  return { history: { ...h, index }, text: index === -1 ? h.saved : h.entries[h.entries.length - 1 - index]! };
}

// ---- word editing and navigation (6.13; Astra's spec, git show v0.9.0:docs/COMPOSER-KEYS-SPEC.md) ----
// Words are whitespace-delimited tokens, deliberately: paths, @mentions and punctuation stay attached (this is not
// language-aware code editing). All boundaries are grapheme-safe (never half a surrogate pair, combining sequence or
// joined emoji).

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Grapheme start offsets in `text`, plus `text.length`. */
function graphemeBounds(text: string): number[] {
  const out: number[] = [];
  for (const g of graphemeSegmenter.segment(text)) out.push(g.index);
  out.push(text.length);
  return out;
}

const isBlank = (g: string) => g === ' ' || g === '\t';
const isSpaceOrNewline = (g: string) => isBlank(g) || g === '\n' || g === '\r';

/** Ctrl+Left: skip whitespace (crossing newlines), then move to the beginning of the preceding token. */
export function wordLeft(d: Draft): Draft {
  const b = graphemeBounds(d.text);
  let k = b.findIndex((x) => x >= d.cursor);
  if (k < 0) k = b.length - 1;
  const g = (i: number) => d.text.slice(b[i]!, b[i + 1]!);
  while (k > 0 && isSpaceOrNewline(g(k - 1))) k--;
  while (k > 0 && !isSpaceOrNewline(g(k - 1))) k--;
  return { ...d, cursor: b[k]! };
}

/** Ctrl+Right: skip the rest of the current token, then the following whitespace (crossing newlines). */
export function wordRight(d: Draft): Draft {
  const b = graphemeBounds(d.text);
  let k = b.findIndex((x) => x >= d.cursor);
  if (k < 0) k = b.length - 1;
  const last = b.length - 1;
  const g = (i: number) => d.text.slice(b[i]!, b[i + 1]!);
  while (k < last && !isSpaceOrNewline(g(k))) k++;
  while (k < last && isSpaceOrNewline(g(k))) k++;
  return { ...d, cursor: b[k]! };
}

/**
 * Ctrl+Backspace: at the start of a line, join it to the previous one (delete only the newline); otherwise delete
 * horizontal whitespace left of the cursor and then the preceding token, never crossing the line start. The text after
 * the cursor is kept exactly.
 */
export function deleteWordBackward(d: Draft): Draft {
  if (d.cursor === 0) return d;
  if (d.text[d.cursor - 1] === '\n') return { text: d.text.slice(0, d.cursor - 1) + d.text.slice(d.cursor), cursor: d.cursor - 1 };
  const b = graphemeBounds(d.text);
  let k = b.findIndex((x) => x >= d.cursor);
  if (k < 0) k = b.length - 1;
  const g = (i: number) => d.text.slice(b[i]!, b[i + 1]!);
  while (k > 0 && isBlank(g(k - 1))) k--;
  while (k > 0 && !isSpaceOrNewline(g(k - 1))) k--;
  return { text: d.text.slice(0, b[k]!) + d.text.slice(d.cursor), cursor: b[k]! };
}

// ---- visual rows (6.13: the composer grows without overwriting the bottom bar) ----------------------------------

export interface VisualRow {
  before: string;
  /** The cursor cell's content (a grapheme, or " " at the end of a line), or null when the cursor isn't on this row. */
  cursor: string | null;
  after: string;
}

/**
 * The draft as terminal rows of at most `width` columns: hard newlines kept, long lines soft-wrapped explicitly by
 * display width (wide CJK/emoji count as two), so the renderer never lets the terminal wrap on its own and the layout
 * can budget every row. The cursor occupies a cell; at the end of a full row it moves to a row of its own.
 */
export function visualRows(d: Draft, width: number, measure: (s: string) => number, clean: (s: string) => string = (s) => s): { rows: VisualRow[]; cursorRow: number } {
  const w = Math.max(1, width);
  const rows: VisualRow[] = [];
  let cursorRow = 0;
  let offset = 0;
  for (const line of d.text.split('\n')) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1;
    const gs = [...graphemeSegmenter.segment(line)].map((s) => ({ index: lineStart + s.index, text: clean(s.segment) }));
    const cursorHere = d.cursor >= lineStart && d.cursor <= lineEnd;
    let row: { gs: typeof gs; width: number } = { gs: [], width: 0 };
    const chunks: (typeof row)[] = [];
    for (const g of gs) {
      const gw = Math.max(1, measure(g.text));
      if (row.gs.length && row.width + gw > w) {
        chunks.push(row);
        row = { gs: [], width: 0 };
      }
      row.gs.push(g);
      row.width += gw;
    }
    chunks.push(row);
    chunks.forEach((c, ci) => {
      const lastChunk = ci === chunks.length - 1;
      // The grapheme that contains the cursor (robust even if an index ever lands inside a cluster).
      const at = cursorHere && d.cursor < lineEnd ? c.gs.findIndex((g, k) => g.index <= d.cursor && (k + 1 < c.gs.length ? c.gs[k + 1]!.index > d.cursor : ci === chunks.length - 1 || chunks[ci + 1]!.gs[0]!.index > d.cursor)) : -1;
      if (at >= 0) {
        cursorRow = rows.length;
        rows.push({ before: c.gs.slice(0, at).map((g) => g.text).join(''), cursor: c.gs[at]!.text, after: c.gs.slice(at + 1).map((g) => g.text).join('') });
      } else if (cursorHere && lastChunk && d.cursor === lineEnd) {
        // Cursor after the line's last character: on this row if a cell is free, else on a row of its own.
        const text = c.gs.map((g) => g.text).join('');
        if (c.width + 1 <= w) {
          cursorRow = rows.length;
          rows.push({ before: text, cursor: ' ', after: '' });
        } else {
          rows.push({ before: text, cursor: null, after: '' });
          cursorRow = rows.length;
          rows.push({ before: '', cursor: ' ', after: '' });
        }
      } else rows.push({ before: c.gs.map((g) => g.text).join(''), cursor: null, after: '' });
    });
  }
  return { rows, cursorRow };
}