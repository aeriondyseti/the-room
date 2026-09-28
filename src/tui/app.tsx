// The room TUI (ROADMAP 3.1 + 3.2): header, participants, a line-accurate conversation viewport, and the composer.
// Presentation only — all behavior lives in the service; this talks to a RoomSource.
import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { randomUUID } from 'node:crypto';
import { Box, Text, useApp, useInput, usePaste, useWindowSize } from 'ink';
import type { MessageWithDeliveries, ParticipantState } from '../contracts/domain.js';
import { toErrorInfo } from '../contracts/errors.js';
import type { RoomEvent } from '../contracts/ipc.js';
import {
  COMMANDS,
  COMMAND_CATALOGUE,
  commandSuggestions,
  completeCommand,
  deleteWordBackward,
  visualRows,
  type VisualRow,
  wordLeft,
  wordRight,
  type CommandInfo,
  EMPTY_DRAFT,
  EMPTY_HISTORY,
  addressee,
  backspace,
  completeMention,
  del,
  end,
  historyDown,
  historyPush,
  historyUp,
  home,
  insert,
  left,
  parseComposer,
  parseRetryArgs,
  parseSeqArg,
  right,
  type Draft,
  type History,
} from './composer.js';
import { DELIVERY_LEGEND, colorFor, cols, conversationLines, deliveryMark, fitLine, lineText, participantsSummary, relativeTime, sanitize, usageLabel, type Line } from './format.js';
import { detailLines } from './detail.js';
import { ActivityPane } from './activity.js';
import { accountLines, activityLabel, livenessDot, participantLines, workspaceDetail } from './topbar.js';
import { leftPanelFits, leftPanelMinCols, sidePanelLines, type TuiLayout } from './sidepanel.js';
import { agentGrid, budgetGrid } from './topgrid.js';
import { surfaceStyle } from './bars.js';
import { bsIsCtrlBackspaceIn, classifyRawKey, useRawKey } from './raw-keys.js';
import type { TopBarMode } from './prefs.js';
import type { RoomSource } from './source.js';
import { COLOR_THEME, ThemeContext, useTheme, type Theme } from './theme.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import { INITIAL_VIEW, reduceView, type RoomView, type ViewAction } from './state.js';

export interface AppProps {
  source: RoomSource;
  humanName: string;
  /** Override terminal size (tests); defaults to the live window size. */
  width?: number;
  height?: number;
  /** Messages loaded on first connect. */
  historyLimit?: number;
  /** Max pages read when catching up after a reconnect (config: tuiCatchUpMaxPages). */
  catchUpMaxPages?: number;
  /** Colour or monochrome (NO_COLOR / --no-color). */
  theme?: Theme;
  /** Starting layout (6.8): top bar or left panel; /layout or Ctrl+B switches it. */
  layout?: TuiLayout;
  /** Left panel width, and the terminal width it needs (config: tuiPanelWidth / tuiPanelBreakpoint). */
  panelWidth?: number;
  panelBreakpoint?: number;
  /** Remember a layout switch (resolves false if it couldn't be saved). Absent = not remembered (e.g. demo). */
  onLayoutChange?: (layout: TuiLayout) => Promise<boolean>;
  /** Top bar density (6.10): the organised grid, or compact lines; /compact or Ctrl+T switches it. */
  topBar?: TopBarMode;
  onTopBarChange?: (mode: TopBarMode) => Promise<boolean>;
  /** The most rows the composer grows to before it scrolls (config: tuiComposerMaxRows). */
  composerMaxRows?: number;
  /**
   * Running in Windows Terminal (default: WT_SESSION set). Kevin's probe qualified its keys there: raw BS is Ctrl+Backspace,
   * LF is Ctrl+Enter, and Alt+Enter is the terminal's fullscreen. Elsewhere BS stays a plain Backspace, the hint offers
   * "\ + Enter" for a newline, and Alt+Enter also adds a line.
   */
  windowsTerminal?: boolean;
}

/** The conversation keeps at least this many rows however much the draft grows. */
const MIN_VIEWPORT_ROWS = 3;
/** Command suggestions shown at once (more are summarised as "+N more"). */
const MAX_SUGGESTIONS = 6;
/** Participant chips wrap over at most this many top-bar lines (then "+N more · /who"). */
const TOP_BAR_PARTICIPANT_LINES = 2;
/** Agent rows in the full top-bar grid (then "+N more · /who"). */
const TOP_BAR_AGENT_ROWS = 6;
/** The full grid yields to chips when it would leave the conversation fewer rows than this. */
const MIN_CONVERSATION_ROWS = 10;
/** How often the top bar re-renders its reset countdowns. */
const TOP_BAR_CLOCK_MS = 30_000;

/** Errors that prove a send never reached the service (so "Not sent" is true). Anything else is an unknown outcome. */
const DEFINITELY_NOT_SENT = new Set(['bad_request', 'unknown_recipient', 'no_recipients', 'message_too_large', 'dedup_conflict', 'identity_unresolved', 'identity_mismatch', 'not_registered', 'invalid_state', 'unsupported_version']);

type Feedback = { tone: 'ok' | 'info' | 'error'; text: string } | null;
type Overlay = 'help' | 'who' | { detail: number } | { activity: string } | null;

export function App({ theme = COLOR_THEME, ...props }: AppProps) {
  return (
    <ThemeContext.Provider value={theme}>
      <Room {...props} />
    </ThemeContext.Provider>
  );
}

function Room({
  source,
  humanName,
  width,
  height,
  historyLimit = DEFAULT_CONFIG.tuiHistoryLimit,
  catchUpMaxPages = DEFAULT_CONFIG.tuiCatchUpMaxPages,
  layout: initialLayout = 'top',
  panelWidth = DEFAULT_CONFIG.tuiPanelWidth,
  panelBreakpoint = DEFAULT_CONFIG.tuiPanelBreakpoint,
  onLayoutChange,
  topBar: initialTopBar = 'full',
  onTopBarChange,
  composerMaxRows = DEFAULT_CONFIG.tuiComposerMaxRows,
  windowsTerminal = bsIsCtrlBackspaceIn(),
}: Omit<AppProps, 'theme'>) {
  const t = useTheme();
  const { exit } = useApp();
  // Before useInput (registration order): the raw bytes of the key being handled (see raw-keys.ts).
  const rawKey = useRawKey();
  const [view, dispatch] = useReducer(reduceView, INITIAL_VIEW, (v): RoomView => ({ ...v, connection: source.status() }));
  const lastSeqRef = useRef(0);
  lastSeqRef.current = view.lastSeq;
  const firstSeqRef = useRef(0);
  firstSeqRef.current = view.items[0]?.message.seq ?? 0;
  const reload = useRoomSync(source, dispatch, historyLimit, catchUpMaxPages, lastSeqRef, firstSeqRef);

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [history, setHistory] = useState<History>(EMPTY_HISTORY);
  const [tabCycle, setTabCycle] = useState<{ base: Draft; n: number } | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [busy, setBusy] = useState(false);
  const pendingConfirm = useRef<string | null>(null);
  // A send that failed ambiguously keeps its client_message_id, so resending the same text can't duplicate (inv. 2).
  const clientId = useRef<{ text: string; id: string } | null>(null);

  const window = useWindowSize();
  const colsTotal = Math.max(20, width ?? window.columns);
  const rows = Math.max(12, height ?? window.rows);
  // A slow clock so reset countdowns ("↻ 2h12m") stay current between events.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), TOP_BAR_CLOCK_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }, []);
  // Layout (6.8): the top bar (6.6: chips + usage across the top, full-width conversation) or the left panel (the same
  // information stacked in a column). The left panel yields to the top bar, with a notice, when the terminal is too
  // narrow for a readable conversation beside it; the preference itself is kept.
  const [layout, setLayout] = useState<TuiLayout>(initialLayout);
  const leftFits = leftPanelFits(colsTotal, panelWidth, panelBreakpoint);
  const showLeft = layout === 'left' && leftFits;
  const stale = view.connection.state !== 'connected';
  // Command discovery: typing "/" (plus a partial name) lists matching commands above the composer.
  const suggestions = useMemo(() => (overlay ? [] : commandSuggestions(draft.text)), [draft.text, overlay]);
  const [suggestIdx, setSuggestIdx] = useState(0);
  useEffect(() => setSuggestIdx(0), [draft.text]);
  // The rows the suggestion list would like; what it actually gets is budgeted with the draft below (TD-0034).
  const suggestionRowsWanted = suggestions.length === 0 ? 0 : Math.min(MAX_SUGGESTIONS, suggestions.length) + (suggestions.length > MAX_SUGGESTIONS ? 1 : 0);
  // The draft as terminal rows (hard newlines and soft wraps, measured by display width), shared by layout and render.
  // Tabs are shown as two spaces (as in messages), so the measured width is the drawn width.
  const draftVisual = useMemo(() => visualRows(draft, colsTotal - 2 /* gutter */, cols, (g) => (g === '\t' ? '  ' : sanitize(g))), [draft, colsTotal]);
  const draftWanted = Math.min(composerMaxRows, draftVisual.rows.length);
  // Top bar (6.10, Kevin's mockup): AGENTS and BUDGETS as aligned, labelled grids; when a grid can't fit the width it
  // falls back to the wrapping chips / metric lines. Compact (explicit, never automatic): one line per section.
  const [topBar, setTopBar] = useState<TopBarMode>(initialTopBar);
  const topLines = useMemo((): Line[] => {
    if (showLeft) return [];
    const chips = (maxLines: number) => participantLines(view.participants, { width: colsTotal, stale, mono: t.mono, maxLines });
    const usage = () => accountLines(view.accounts, { width: colsTotal, mono: t.mono, now: clock, disconnected: stale });
    const grid = topBar === 'compact' ? null : [
      ...(agentGrid(view.participants, { width: colsTotal, stale, maxRows: TOP_BAR_AGENT_ROWS }) ?? chips(TOP_BAR_PARTICIPANT_LINES)),
      ...(budgetGrid(view.accounts, { width: colsTotal, now: clock, disconnected: stale }) ?? usage()),
    ];
    // Height guard (like the width guard): the full grid never squeezes the conversation below a readable height; on a
    // short terminal the top bar shows the wrapping chips instead (the saved density is kept).
    // While an overlay (help, /who, detail, activity) is open it gets the room: the grid yields the same way.
    // Every other row counts (6.13, TD-0027): header, banner, left-layout notice, rules, the composer as the draft needs it
    // (with feedback and suggestions) and the status bar.
    const persistent = (view.connection.state !== 'connected' || (view.notice !== null && view.loaded) ? 1 : 0) + (layout === 'left' ? 1 : 0);
    const chrome = 1 /* header */ + persistent + 1 /* rule */ + 2 /* composer rule + To */ + draftWanted + (feedback ? 1 : 0) + suggestionRowsWanted + 1 /* status */;
    const gridFits = grid !== null && !overlay && rows - grid.length - chrome >= MIN_CONVERSATION_ROWS;
    const lines = gridFits ? grid : [...chips(topBar === 'compact' ? 1 : TOP_BAR_PARTICIPANT_LINES), ...usage()];
    if (layout === 'left') lines.push(fitLine([{ text: `Left panel needs a terminal ${leftPanelMinCols(panelWidth, panelBreakpoint)}+ columns wide; showing the top bar until then.`, dim: true, italic: true }], colsTotal));
    return lines;
  }, [showLeft, layout, topBar, overlay, rows, draftWanted, feedback, suggestionRowsWanted, view.connection.state, view.notice, view.loaded, view.participants, view.accounts, colsTotal, stale, t.mono, clock, panelBreakpoint, panelWidth]);
  const convWidth = colsTotal - (showLeft ? panelWidth + 1 : 0) - 1;
  const saveGen = useRef(0);
  const switchLayout = (next: TuiLayout): Feedback => {
    setLayout(next);
    const gen = ++saveGen.current;
    const fits = next === 'top' || leftFits;
    const what = next === 'top' ? 'top bar' : 'left panel';
    const note = fits ? '' : ` The terminal is too narrow for it right now, so the top bar shows until it's wider.`;
    if (onLayoutChange) {
      void onLayoutChange(next).then((ok) => {
        // Only the latest choice reports a failure (an older, superseded save doesn't matter any more).
        if (!ok && gen === saveGen.current) setFeedback({ tone: 'error', text: `Layout: ${what} for now — the choice couldn't be saved, so the next launch uses the default.` });
      });
    }
    return { tone: 'ok', text: `Layout: ${what}${onLayoutChange ? ' (remembered)' : ''}.${note} /layout or Ctrl+B switches back.` };
  };
  const topBarGen = useRef(0);
  const switchTopBar = (next: TopBarMode): Feedback => {
    setTopBar(next);
    const gen = ++topBarGen.current;
    if (onTopBarChange) {
      void onTopBarChange(next).then((ok) => {
        if (!ok && gen === topBarGen.current) setFeedback({ tone: 'error', text: `Top bar: ${next} for now — the choice couldn't be saved.` });
      });
    }
    const where = layout === 'left' && leftFits ? ' (applies to the top-bar layout)' : '';
    return { tone: 'ok', text: `Top bar: ${next === 'compact' ? 'compact' : 'full grid'}${onTopBarChange ? ' (remembered)' : ''}${where}. /compact or Ctrl+T switches back.` };
  };
  const banner = view.connection.state !== 'connected' || (view.notice !== null && view.loaded);
  const loadFailed = !view.loaded && view.notice !== null;
  const names = useMemo(() => view.participants.map((p) => p.name), [view.participants]);

  // 6.13: the composer takes the rows its draft actually needs (soft wraps included), up to composerMaxRows and never
  // below a readable conversation; beyond that it scrolls inside itself to follow the cursor. Nothing is ever drawn over
  // the bottom bar.
  // One budget that always fits the frame (TD-0034: at 12 rows the "/" list plus a fixed 3-row conversation overflowed,
  // clipping the header and the To: row). Rows are handed out in priority order against what is actually left — never
  // independent floors that could add up to more than the terminal:
  //   essential chrome (header, banner, rules, To:, feedback, status) → one draft row → two conversation rows → the
  //   suggestion list (at least its highlighted row) → the conversation's minimum → the draft's growth → the rest.
  // If even that doesn't fit, the top bar gives up rows from its end and says so ("top bar trimmed"), never silently.
  const essentialRows = 1 /* header */ + (banner ? 1 : 0) + 1 /* rule under the top bar */ + 2 /* composer rule + To: */ + (feedback ? 1 : 0) + 1 /* status */;
  // The conversation always keeps 2 rows (a pager's content line plus its "↓ N more" marker; the side panel's summary).
  const needRows = 1 /* draft */ + 2 /* conversation */ + (suggestions.length ? 1 : 0);
  const topRoom = Math.max(0, rows - essentialRows - needRows);
  // Trimming keeps the left-layout notice (it explains why the panel isn't showing) and says what was hidden.
  const leftNotice = layout === 'left' && !showLeft ? topLines.at(-1) : undefined;
  const topBody = leftNotice ? topLines.slice(0, -1) : topLines;
  const topShown: Line[] = (() => {
    if (topLines.length <= topRoom) return topLines;
    if (topRoom === 0) return [];
    const keep = Math.max(0, topRoom - 1 - (leftNotice ? 1 : 0));
    const budgetsHidden = view.accounts.length > 0;
    const marker = fitLine([{ text: `top bar trimmed — the terminal is too short · /who${budgetsHidden ? ' · budgets hidden' : ''}`, dim: true, italic: true }], colsTotal);
    return [...topBody.slice(0, keep), marker, ...(leftNotice && topRoom >= 2 ? [leftNotice] : [])];
  })();
  let spare = Math.max(needRows, rows - essentialRows - topShown.length);
  spare -= 3; // one draft row and two conversation rows, always
  const suggestionRows = suggestions.length === 0 ? 0 : Math.min(suggestionRowsWanted, Math.max(1, spare - (MIN_VIEWPORT_ROWS - 2)));
  spare -= suggestionRows;
  // With a single row the list shows the highlighted command itself (with the "+N more" count folded in), so the
  // command Enter/Tab would run is always on screen.
  const suggestionLimit = suggestions.length === 0 ? 0 : suggestionRows >= suggestionRowsWanted ? Math.min(MAX_SUGGESTIONS, suggestions.length) : Math.max(1, suggestionRows - 1);
  const conversationExtra = Math.min(MIN_VIEWPORT_ROWS - 2, Math.max(0, spare));
  spare -= conversationExtra;
  const draftRows = 1 + Math.min(Math.max(0, draftWanted - 1), Math.max(0, spare));
  spare -= draftRows - 1;
  const composerHeight = 1 /* rule */ + 1 /* To: */ + draftRows + (feedback ? 1 : 0) + suggestionRows;
  const viewportHeight = 2 + conversationExtra + Math.max(0, spare);
  const seqById = useMemo(() => new Map(view.items.map((i) => [i.message.id, i.message.seq] as const)), [view.items]);
  const lines = useMemo(
    // -1: the conversation box has one column of left padding.
    () => conversationLines(view.items, { width: convWidth - 1, humanName, seqById }),
    [view.items, convWidth, humanName, seqById],
  );
  const scroll = useScroll(lines.length, view.items.length, viewportHeight);

  // Delivery detail overlay: its own line model and scroll offset (lines from the top).
  const [detailOffset, setDetailOffset] = useState(0);
  const detailItem = overlay !== null && typeof overlay === 'object' && 'detail' in overlay ? view.items.find((i) => i.message.seq === overlay.detail) ?? null : null;
  const detailAll = useMemo(
    () =>
      detailItem
        ? detailLines(detailItem, { width: convWidth - 1, humanName, seqById, stale: view.connection.state !== 'connected' })
        : null,
    [detailItem, convWidth, humanName, seqById, view.connection.state],
  );
  const detail = useMemo(() => {
    if (!detailAll) return null;
    const room = Math.max(1, viewportHeight - 1); // keep a row for the "more" marker
    const max = Math.max(0, detailAll.length - room);
    const off = Math.min(detailOffset, max);
    return { visible: detailAll.slice(off, off + room), below: Math.max(0, detailAll.length - off - room), max };
  }, [detailAll, detailOffset, viewportHeight]);
  // Help pages like /detail (same offset state; both reset when the overlay closes).
  const help = useMemo(() => {
    if (overlay !== 'help') return null;
    const all = helpLines();
    const room = Math.max(1, viewportHeight - 1);
    const max = Math.max(0, all.length - room);
    const off = Math.min(detailOffset, max);
    return { visible: all.slice(off, off + room), below: Math.max(0, all.length - off - room), max };
  }, [overlay, detailOffset, viewportHeight]);
  const pager = detail ?? help;
  const endLine = lines.length - scroll.offset;
  const visible = lines.slice(Math.max(0, endLine - viewportHeight), endLine);

  const edit = (next: Draft) => {
    setDraft(next);
    setTabCycle(null);
    if (feedback?.tone !== 'error' || next.text === '') setFeedback(null);
    pendingConfirm.current = null;
  };

  const run = async (label: string, work: () => Promise<Feedback | void>) => {
    setBusy(true);
    try {
      const result = await work();
      if (result) setFeedback(result);
    } catch (e) {
      const info = toErrorInfo(e);
      setFeedback({ tone: 'error', text: `${label}: ${info.message}${info.hint ? ` — ${info.hint}` : ''}` });
    } finally {
      setBusy(false);
    }
  };

  const submit = (input: string = draft.text) => {
    const parsed = parseComposer(input, names);
    if (parsed.kind === 'empty') return;
    if (parsed.kind === 'error') {
      setFeedback({ tone: 'error', text: parsed.message });
      return;
    }
    if (parsed.kind === 'message') {
      const text = input;
      if (!clientId.current || clientId.current.text !== text) clientId.current = { text, id: randomUUID() };
      const id = clientId.current.id;
      void (async () => {
        setBusy(true);
        try {
          const result = await source.request('send', { caller: { kind: 'human' }, to: parsed.to, body: parsed.body, clientMessageId: id });
          clientId.current = null;
          setHistory((h) => historyPush(h, text));
          // Keep anything typed while the send was in flight.
          setDraft((d) => (d.text === text ? EMPTY_DRAFT : d));
          scroll.toLive();
          if (result.deduplicated) setFeedback({ tone: 'info', text: 'Already sent — the room recognised this as a retry.' });
          else if (view.room.paused) setFeedback({ tone: 'info', text: 'Sent. The room is paused, so delivery is held until /resume.' });
        } catch (e) {
          const info = toErrorInfo(e);
          const notSent = DEFINITELY_NOT_SENT.has(info.code) || /^Not connected/.test(info.message);
          setFeedback(
            notSent
              ? { tone: 'error', text: `Not sent: ${info.message}${info.hint ? ` — ${info.hint}` : ''}` }
              : { tone: 'error', text: `Send outcome unknown (${info.message}). Press Enter to resend safely — the room drops duplicates; editing the text makes it a new message.` },
          );
        } finally {
          setBusy(false);
        }
      })();
      return;
    }
    const { command, args } = parsed;
    const submitted = input;
    const finish = (fb: Feedback) => {
      setHistory((h) => historyPush(h, submitted));
      setDraft((d) => (d.text === submitted ? EMPTY_DRAFT : d)); // keep text typed while the command ran
      return fb;
    };
    switch (command) {
      case 'help':
        finish(null);
        setOverlay('help');
        return;
      case 'who':
        finish(null);
        setOverlay('who');
        return;
      case 'activity': {
        const name = args.replace(/^@/, '').trim();
        if (!name) {
          setFeedback({ tone: 'error', text: 'Usage: /activity @name' });
          return;
        }
        if (!names.includes(name)) {
          setFeedback({ tone: 'error', text: `No participant named "${sanitize(name)}". /who lists them.` });
          return;
        }
        finish(null);
        setOverlay({ activity: name });
        return;
      }
      case 'detail': {
        const seq = args === '' ? (view.items.at(-1)?.message.seq ?? null) : parseSeqArg(args);
        if (seq === null) {
          setFeedback({ tone: 'error', text: args === '' ? 'No messages yet.' : 'Usage: /detail #<message number>' });
          return;
        }
        if (!view.items.some((i) => i.message.seq === seq)) {
          setFeedback({ tone: 'error', text: `No message #${seq} in view.` });
          return;
        }
        finish(null);
        setOverlay({ detail: seq });
        return;
      }
      case 'quit':
        exit();
        return;
      case 'compact': {
        const arg = args.trim().toLowerCase();
        if (arg !== '' && arg !== 'on' && arg !== 'off') {
          setFeedback({ tone: 'error', text: 'Usage: /compact [on|off] — no argument switches.' });
          return;
        }
        setFeedback(finish(switchTopBar(arg === 'on' ? 'compact' : arg === 'off' ? 'full' : topBar === 'full' ? 'compact' : 'full')));
        return;
      }
      case 'layout': {
        const arg = args.trim().toLowerCase();
        if (arg !== '' && arg !== 'top' && arg !== 'left') {
          setFeedback({ tone: 'error', text: 'Usage: /layout [top|left] — no argument switches between them.' });
          return;
        }
        setFeedback(finish(switchLayout(arg === '' ? (layout === 'top' ? 'left' : 'top') : arg)));
        return;
      }
      case 'pause':
        void run('Pause failed', async () => {
          const r = await source.request('pause', { caller: { kind: 'human' }, stopRequestBody: args || null });
          if (!r.stopRequest) return finish({ tone: 'info', text: 'Already paused — no new stop request sent. /resume to release held messages.' });
          const n = r.stopRequest.deliveries.length;
          return finish({ tone: 'ok', text: `Paused. Stop request sent to ${n} agent${n === 1 ? '' : 's'}; new messages are held until /resume.` });
        });
        return;
      case 'resume':
        void run('Resume failed', async () => {
          const r = await source.request('resume', { caller: { kind: 'human' } });
          return finish({ tone: 'ok', text: `Resumed. ${r.released} held deliver${r.released === 1 ? 'y' : 'ies'} released in order.` });
        });
        return;
      case 'restart': {
        // Graceful service restart (e.g. to load a new version): the service finishes in-flight requests, keeps every
        // queued delivery in the ledger, and never interrupts an agent; our reconnect then starts the new service.
        // Human-only by construction (the TUI connection is the human), and confirmed with a second Enter.
        if (pendingConfirm.current !== 'restart') {
          pendingConfirm.current = 'restart';
          setFeedback({ tone: 'info', text: 'Restart the room service? Queued messages are kept and no agent is interrupted. Press Enter again to confirm.' });
          return;
        }
        pendingConfirm.current = null;
        void run('Restart failed', async () => {
          await source.request('shutdown', { caller: { kind: 'human' } });
          return finish({ tone: 'ok', text: 'Room service stopped; reconnecting will start the new one.' });
        });
        return;
      }
      case 'retry': {
        const target = resolveRetry(args, view.items);
        if ('error' in target) {
          setFeedback({ tone: 'error', text: target.error });
          return;
        }
        const key = `${target.messageId}/${target.recipient}`;
        if (target.state === 'uncertain' && pendingConfirm.current !== key) {
          pendingConfirm.current = key;
          setFeedback({ tone: 'error', text: `#${target.seq} → ${target.recipient} may already have been delivered. Press Enter again to retry anyway.` });
          return;
        }
        pendingConfirm.current = null;
        void run('Retry failed', async () => {
          await source.request('retry', { caller: { kind: 'human' }, messageId: target.messageId, recipient: target.recipient });
          return finish({ tone: 'ok', text: `Retrying #${target.seq} → ${target.recipient}.` });
        });
        return;
      }
    }
  };

  usePaste((text) => {
    if (overlay) return;
    edit(insert(draft, text.replace(/\r\n?/g, '\n')));
  });

  useInput((input, key) => {
    // A key RELEASE (CSI-u event type 3, e.g. ESC[13;5:3u) is never an action: acting on press and release would
    // insert, delete or submit twice (Astra's 6.13 cross-review).
    if (key.eventType === 'release') return;
    if (overlay !== null && typeof overlay === 'object' && 'activity' in overlay) return; // the activity pane owns its keys
    if (overlay) {
      if (key.escape || key.return || input === 'q' || input === '?') {
        setOverlay(null);
        setDetailOffset(0);
        return;
      }
      if (pager) {
        const page = Math.max(1, viewportHeight - 2);
        const clamp = (n: number) => Math.min(pager.max, Math.max(0, n));
        if (key.pageDown) setDetailOffset((o) => clamp(o + page));
        else if (key.pageUp) setDetailOffset((o) => clamp(o - page));
        else if (key.downArrow) setDetailOffset((o) => clamp(o + 1));
        else if (key.upArrow) setDetailOffset((o) => clamp(o - 1));
      }
      return;
    }
    if (loadFailed && input === 'r' && draft.text === '') {
      reload();
      return;
    }
    // Scrolling
    if (key.pageUp) return scroll.page(1);
    if (key.pageDown) return scroll.page(-1);
    if (key.shift && key.upArrow) return scroll.line(1);
    if (key.shift && key.downArrow) return scroll.line(-1);
    if (key.ctrl && key.home) return scroll.toTop();
    if (key.ctrl && key.end) return scroll.toLive();
    if (key.end && draft.text === '') return scroll.toLive();

    // Keys Ink can't tell apart by itself (Kevin's Windows Terminal: Ctrl+Enter = LF, Ctrl+Backspace = BS).
    const raw = classifyRawKey(rawKey.current, { bsIsCtrlBackspace: windowsTerminal });
    if (raw === 'ctrl-enter') return edit(insert(draft, '\n'));
    if (raw === 'ctrl-backspace') return edit(deleteWordBackward(draft));

    if (key.escape) {
      if (draft.text !== '') edit(EMPTY_DRAFT);
      else setFeedback(null);
      return;
    }
    if (key.return) {
      // Ctrl+Enter inserts a newline and never sends, runs a command or confirms (checked before anything else).
      if (key.ctrl) return edit(insert(draft, '\n'));
      // Alt+Enter: in Windows Terminal it's the terminal's fullscreen (never an app shortcut; ignored if it arrives);
      // elsewhere it adds a line. It never sends.
      if (key.meta) return windowsTerminal ? undefined : edit(insert(draft, '\n'));
      if (busy) return;
      if (draft.text.slice(0, draft.cursor).endsWith('\\') && draft.cursor === draft.text.length) {
        return edit({ text: draft.text.slice(0, -1) + '\n', cursor: draft.text.length });
      }
      // A partial command name + Enter picks the highlighted suggestion (running it at once if it takes no
      // arguments) instead of failing with "unknown command". An exact name runs as typed.
      const typed = draft.text.slice(1).toLowerCase();
      if (suggestions.length > 0 && !(COMMANDS as readonly string[]).includes(typed)) {
        const picked = suggestions[suggestIdx] ?? suggestions[0]!;
        const text = completeCommand(picked);
        if (picked.args) return edit({ text, cursor: text.length });
        // Show the full command in the draft (so it clears after running), keeping any pending confirmation.
        setDraft({ text, cursor: text.length });
        setTabCycle(null);
        return submit(text);
      }
      return submit();
    }
    if (suggestions.length > 0 && (key.tab || key.upArrow || key.downArrow)) {
      if (key.tab) {
        const picked = suggestions[suggestIdx] ?? suggestions[0]!;
        const text = completeCommand(picked);
        edit({ text, cursor: text.length });
      } else {
        const n = suggestions.length;
        setSuggestIdx((i) => (key.upArrow ? (i - 1 + n) % n : (i + 1) % n));
      }
      return;
    }
    if (key.tab) {
      const base = tabCycle?.base ?? draft;
      const n = tabCycle ? tabCycle.n + 1 : 0;
      const done = completeMention(base.text, base.cursor, names, n);
      if (done) {
        setDraft(done);
        setTabCycle({ base, n });
      }
      return;
    }
    if (key.upArrow) {
      const r = historyUp(history, draft.text);
      if (r) {
        setHistory(r.history);
        edit({ text: r.text, cursor: r.text.length });
      }
      return;
    }
    if (key.downArrow) {
      const r = historyDown(history);
      if (r) {
        setHistory(r.history);
        edit({ text: r.text, cursor: r.text.length });
      }
      return;
    }
    // Modified keys before their plain forms: Ctrl+←/→ move by word; Ctrl+Backspace (or Ctrl+W) deletes a word.
    if (key.leftArrow && key.ctrl) return edit(wordLeft(draft));
    if (key.rightArrow && key.ctrl) return edit(wordRight(draft));
    if ((key.backspace && key.ctrl) || (key.ctrl && input === 'w')) return edit(deleteWordBackward(draft));
    if (key.leftArrow) return edit(left(draft));
    if (key.rightArrow) return edit(right(draft));
    if (key.home) return edit(home(draft));
    if (key.end) return edit(end(draft));
    if (key.backspace) return edit(backspace(draft));
    if (key.delete) return edit(del(draft));
    if (input === '?' && draft.text === '') return setOverlay('help');
    if (key.ctrl && input === 'b') return setFeedback(switchLayout(layout === 'top' ? 'left' : 'top'));
    if (key.ctrl && input === 't') return setFeedback(switchTopBar(topBar === 'full' ? 'compact' : 'full'));
    if (key.ctrl || key.meta || input === '') return;
    edit(insert(draft, input));
  });

  const to = addressee(draft.text, names);

  return (
    <Box flexDirection="column" width={colsTotal} height={rows} overflow="hidden" flexShrink={0}>
      <Header view={view} width={colsTotal} />
      {banner && <Banner view={view} width={colsTotal} />}
      {topShown.map((line, i) => (
        <LineView key={`top-${i}`} line={line} />
      ))}
      <Text dimColor>{'─'.repeat(colsTotal)}</Text>
      <Box flexDirection="row" height={viewportHeight}>
        {showLeft && <SidePanel view={view} width={panelWidth} height={viewportHeight} stale={stale} now={clock} humanName={humanName} />}
        <Box flexDirection="column" width={convWidth} paddingLeft={1} justifyContent={overlay ? 'flex-start' : 'flex-end'} overflow="hidden">
          {overlay === 'help' ? (
            <Box flexDirection="column" flexShrink={0}>
              {help?.visible.map((line, i) => (
                <LineView key={i} line={line} />
              ))}
              {help && help.below > 0 && <Text color={t.color('cyan')}>↓ {help.below} more line{help.below === 1 ? '' : 's'} · PgDn</Text>}
            </Box>
          ) : overlay === 'who' ? (
            <WhoOverlay participants={view.participants} />
          ) : overlay !== null && 'activity' in overlay ? (
            <ActivityPane source={source} participant={overlay.activity} width={convWidth - 1} height={viewportHeight} onClose={() => setOverlay(null)} />
          ) : overlay !== null ? (
            detail === null ? (
              <Text dimColor>Message #{overlay.detail} is no longer loaded. Esc to close.</Text>
            ) : (
              <Box flexDirection="column" flexShrink={0}>
                {detail.visible.map((line, i) => (
                  <LineView key={i} line={line} />
                ))}
                {detail.below > 0 && (
                  <Text color={t.color('cyan')}>↓ {detail.below} more line{detail.below === 1 ? '' : 's'} · PgDn</Text>
                )}
              </Box>
            )
          ) : loadFailed ? (
            <Box flexDirection="column">
              <Text color={t.color('red')} bold>Couldn't load the room.</Text>
              <Text dimColor>Press r to try again, or run `room doctor` to check the service.</Text>
            </Box>
          ) : !view.loaded ? (
            <Text dimColor>Loading room…</Text>
          ) : view.items.length === 0 ? (
            <EmptyState participants={view.participants} />
          ) : (
            visible.map((line, i) => <LineView key={i} line={line} />)
          )}
        </Box>
      </Box>
      <Composer
        width={colsTotal}
        draft={draft}
        rows={draftRows}
        visual={draftVisual}
        windowsTerminal={windowsTerminal}
        to={to}
        paused={view.room.paused}
        busy={busy}
        feedback={feedback}
        connected={view.connection.state === 'connected'}
        suggestions={suggestions}
        suggestIdx={suggestIdx}
        suggestionLimit={suggestionLimit}
        suggestionFolded={suggestionRows === 1 && suggestions.length > 1}
      />
      <StatusBar offset={scroll.offset} unseen={scroll.unseen} width={colsTotal} />
    </Box>
  );
}

/** The left panel: the side-panel line model in a fixed-width column with a rule on its right. */
function SidePanel({ view, width, height, stale, now, humanName }: { view: RoomView; width: number; height: number; stale: boolean; now: number; humanName: string }) {
  const t = useTheme();
  const lines = useMemo(
    () => sidePanelLines(view.participants, view.accounts, { width: width - 2, height, stale, mono: t.mono, now, humanName }),
    [view.participants, view.accounts, width, height, stale, t.mono, now, humanName],
  );
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="single" borderTop={false} borderBottom={false} borderLeft={false} paddingRight={1} flexShrink={0}>
      {lines.map((line, i) => (
        <LineView key={i} line={line} />
      ))}
    </Box>
  );
}

/** Resolve `/retry #N [@agent]` against what's on screen: a failed/uncertain delivery of message #N. */
function resolveRetry(
  args: string,
  items: readonly MessageWithDeliveries[],
): { messageId: string; recipient: string; seq: number; state: string } | { error: string } {
  const parsed = parseRetryArgs(args);
  if ('error' in parsed) return parsed;
  const item = items.find((i) => i.message.seq === parsed.seq);
  if (!item) return { error: `No message #${parsed.seq} in view.` };
  const retryable = item.deliveries.filter((d) => d.state === 'failed' || d.state === 'uncertain');
  const pick = parsed.recipient ? item.deliveries.find((d) => d.recipient === parsed.recipient) : retryable.length === 1 ? retryable[0] : undefined;
  if (!pick) {
    if (retryable.length === 0) return { error: `#${parsed.seq} has no failed or uncertain deliveries.` };
    return { error: `#${parsed.seq} has several retryable deliveries; name one: ${retryable.map((d) => '@' + d.recipient).join(' ')}` };
  }
  if (pick.state !== 'failed' && pick.state !== 'uncertain') return { error: `#${parsed.seq} → ${pick.recipient} is ${deliveryMark(pick).label}; only failed or uncertain deliveries can be retried.` };
  return { messageId: item.message.id, recipient: pick.recipient, seq: item.message.seq, state: pick.state };
}

// ---- data sync ------------------------------------------------------------------------------------------

/** Keeps the view in sync with the room. Returns `reload` (used by the retry key after a failed load). */
function useRoomSync(
  source: RoomSource,
  dispatch: React.Dispatch<ViewAction>,
  historyLimit: number,
  catchUpMaxPages: number,
  lastSeqRef: React.RefObject<number>,
  firstSeqRef: React.RefObject<number>,
): () => void {
  const reloadRef = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    let loading = false;
    let rerun = false;
    // Events that arrive while a snapshot is loading are buffered and re-applied on top of it, so an older
    // snapshot can never roll back a newer delivery/participant update (invariant 3).
    let buffer: RoomEvent[] | null = null;
    let previous = source.status().state;
    // Contract: subscribe replays messages only, so every (re)connect refreshes who + history too. After a
    // reconnect we page forward from the last message we have, so a long outage leaves no silent gap.
    const load = async () => {
      if (loading) {
        rerun = true; // a reconnect happened mid-load: load again for the new connection when this one ends
        return;
      }
      loading = true;
      buffer = [];
      try {
        const since = lastSeqRef.current ?? 0;
        const firstShown = firstSeqRef.current ?? 0;
        await source.request('subscribe', { afterSeq: since > 0 ? since : null });
        const who = await source.request('who', {});
        const items: MessageWithDeliveries[] = [];
        let truncated = false;
        if (since > 0) {
          // Re-read everything already on screen (its delivery states may have changed while we were away —
          // subscribe doesn't replay those) plus everything new, page by page.
          let after = Math.max(0, firstShown - 1);
          for (let page = 0; ; page++) {
            if (page >= catchUpMaxPages) {
              truncated = true;
              break;
            }
            const r = await source.request('read', { afterSeq: after, limit: historyLimit, includeDeliveries: true });
            items.push(...r.items);
            after = r.items.at(-1)?.message.seq ?? after;
            if (!r.hasMore || r.items.length === 0) break;
          }
        } else {
          items.push(...(await source.request('read', { limit: historyLimit, includeDeliveries: true })).items);
        }
        if (alive) {
          dispatch({ type: 'snapshot', items, participants: who.participants, room: who.room, ...(who.accounts ? { accounts: who.accounts } : {}) });
          dispatch({ type: 'notice', notice: truncated ? 'Reconnected, but the catch-up was too long to load fully; newest messages may be missing — restart the TUI to reload.' : null });
        }
      } catch (err) {
        if (alive) dispatch({ type: 'notice', notice: `Couldn't load the room: ${toErrorInfo(err).message}` });
      } finally {
        const queued = buffer ?? [];
        buffer = null;
        if (alive) for (const event of queued) dispatch({ type: 'event', event });
        loading = false;
        if (rerun && alive) {
          rerun = false;
          void load();
        }
      }
    };
    reloadRef.current = () => void load();
    const offEvent = source.onEvent((event) => {
      if (buffer) buffer.push(event);
      else dispatch({ type: 'event', event });
    });
    const offStatus = source.onStatus((status) => {
      dispatch({ type: 'status', status });
      if (status.state === 'connected' && previous !== 'connected') void load();
      previous = status.state;
    });
    if (previous === 'connected') void load();
    return () => {
      alive = false;
      offEvent();
      offStatus();
    };
  }, [source, dispatch, historyLimit, catchUpMaxPages, lastSeqRef, firstSeqRef]);
  return () => reloadRef.current();
}

// ---- scrolling ------------------------------------------------------------------------------------------

interface Scroll {
  offset: number;
  unseen: number;
  page(direction: 1 | -1): void;
  line(direction: 1 | -1): void;
  toTop(): void;
  toLive(): void;
}

function useScroll(lineCount: number, messageCount: number, viewportHeight: number): Scroll {
  const [state, setState] = useState({ offset: 0, unseen: 0 });
  const prev = useRef({ lineCount, messageCount });
  const maxOffset = Math.max(0, lineCount - viewportHeight);

  // Keep the viewport anchored when content arrives while scrolled up (never jump), and count what's new.
  useEffect(() => {
    const addedLines = lineCount - prev.current.lineCount;
    const addedMessages = messageCount - prev.current.messageCount;
    prev.current = { lineCount, messageCount };
    if (addedLines > 0) {
      setState((s) => (s.offset > 0 ? { offset: s.offset + addedLines, unseen: s.unseen + Math.max(0, addedMessages) } : s));
    }
  }, [lineCount, messageCount]);

  const to = (offset: number) =>
    setState((s) => {
      const next = Math.min(maxOffset, Math.max(0, offset));
      return { offset: next, unseen: next === 0 ? 0 : s.unseen };
    });
  const offset = Math.min(state.offset, maxOffset);
  return {
    offset,
    unseen: state.unseen,
    page: (d) => to(offset + d * Math.max(1, viewportHeight - 1)),
    line: (d) => to(offset + d),
    toTop: () => to(maxOffset),
    toLive: () => to(0),
  };
}

// ---- pieces ---------------------------------------------------------------------------------------------

function Header({ view, width }: { view: RoomView; width: number }) {
  const t = useTheme();
  const conn = connectionBadge(view.connection.state);
  // While disconnected the counts are stale, so only the total is shown.
  const summary = view.connection.state === 'connected' ? participantsSummary(view.participants) : participantsSummary(view.participants).slice(0, 1);
  return (
    <Box width={width} justifyContent="space-between">
      {/* The room label never shrinks or wraps (at narrow widths it did, making the header two rows and pushing every
          budgeted row down — 6.18 review); only the summary on the right truncates. */}
      <Box flexShrink={0}>
      <Text wrap="truncate">
        <Text inverse bold> vibe-pairing </Text>
        {view.room.paused && <Text color={t.color('yellow')} inverse bold> ⏸ PAUSED </Text>}
      </Text>
      </Box>
      <Text wrap="truncate">
        {summary.map((part, i) => (
          <Text key={i} color={t.color(part.color)} dimColor={part.color === undefined}>
            {i > 0 ? ' · ' : ''}
            {part.text}
          </Text>
        ))}
        <Text>  </Text>
        <Text color={t.color(conn.color)}>{conn.glyph} {conn.label}</Text>
      </Text>
    </Box>
  );
}

function connectionBadge(state: RoomView['connection']['state']): { glyph: string; label: string; color: string } {
  switch (state) {
    case 'connected':
      return { glyph: '●', label: 'connected', color: 'green' };
    case 'connecting':
      return { glyph: '◌', label: 'connecting', color: 'yellow' };
    case 'reconnecting':
      return { glyph: '◐', label: 'reconnecting', color: 'yellow' };
    case 'disconnected':
      return { glyph: '○', label: 'disconnected', color: 'red' };
  }
}

function Banner({ view, width }: { view: RoomView; width: number }) {
  const t = useTheme();
  if (view.connection.state !== 'connected') {
    const detail = view.connection.detail ? ` (${view.connection.detail})` : '';
    const text =
      view.connection.state === 'disconnected'
        ? `Not connected to the room service${detail}. Still retrying; run \`room doctor\` if this persists.`
        : view.connection.state === 'connecting'
          ? 'Connecting to the room service…'
          : `Reconnecting to the room service${detail}… what you see may be out of date.`;
    return (
      <Box width={width}>
        <Text color={t.color('yellow')} wrap="truncate">{text}</Text>
      </Box>
    );
  }
  return (
    <Box width={width}>
      <Text color={t.color('yellow')} wrap="truncate">{view.notice}</Text>
    </Box>
  );
}

export { activityLabel } from './topbar.js';

/** First-run guidance when nobody has joined yet; a short prompt once agents are here but nothing's been said. */
export function EmptyState({ participants }: { participants: readonly ParticipantState[] }) {
  const t = useTheme();
  if (participants.length === 0) {
    const steps: Array<[string, string]> = [
      ['1', 'In each agent\'s session, ask it to join: "join the room as <name>". It uses the room_join tool (or `room join --as <name>` from its shell).'],
      ['2', 'Joined agents appear here with their status. Enter sends to everyone; start with @name to pick one.'],
      ['3', 'Something off? Run `room doctor`, or see docs/ONBOARDING.md. Press ? for keys and commands.'],
    ];
    return (
      <Box flexDirection="column" flexShrink={0}>
        <Text bold>Welcome to the room — no agents have joined yet.</Text>
        <Text> </Text>
        {steps.map(([n, s]) => (
          <Box key={n} flexDirection="row">
            <Box width={3} flexShrink={0}>
              <Text color={t.color('cyan')} bold>{n}.</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="wrap">{s}</Text>
            </Box>
          </Box>
        ))}
      </Box>
    );
  }
  const names = participants.map((p) => sanitize(p.name));
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text bold>The room is quiet.</Text>
      <Text dimColor wrap="wrap">
        {`${names.length === 1 ? `${names[0]} is here.` : `${names.length} agents are here: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}.`} Type below and press Enter to message everyone, or start with @${names[0]} to pick one. Press ? for help.`}
      </Text>
    </Box>
  );
}

function Composer(props: {
  width: number;
  draft: Draft;
  rows: number;
  visual: { rows: VisualRow[]; cursorRow: number };
  windowsTerminal: boolean;
  to: { label: string; valid: boolean };
  paused: boolean;
  busy: boolean;
  feedback: Feedback;
  connected: boolean;
  suggestions: readonly CommandInfo[];
  suggestIdx: number;
  /** How many suggestions fit (the rest are summarised as "+N more"). */
  suggestionLimit: number;
  /** Only one row for the list: the highlighted command shows with the "+N more" count folded into it. */
  suggestionFolded: boolean;
}) {
  const { draft, to } = props;
  const t = useTheme();
  const accent = !props.connected ? 'gray' : props.paused ? 'yellow' : 'cyan';
  const toText = to.label === 'command' ? 'command' : `To: ${to.label}`;
  // A window of the draft's visual rows that keeps the cursor visible; ↑ / ↓ in the gutter mark rows above / below.
  const all = props.visual.rows;
  const start = Math.min(Math.max(0, props.visual.cursorRow - props.rows + 1), Math.max(0, all.length - props.rows));
  const lines = all.slice(start, start + props.rows);
  const gutter = (i: number) => (start + i === 0 ? '› ' : i === 0 && start > 0 ? '↑ ' : i === lines.length - 1 && start + lines.length < all.length ? '↓ ' : '  ');
  const hints = props.suggestions.length > 0 ? 'Tab complete · ↑/↓ choose · Enter run · Esc clear' : `Enter send · ${props.windowsTerminal ? 'Ctrl+Enter' : '\\ + Enter'} newline · Tab @name · ? help`;
  // Keep the highlighted suggestion inside the visible window.
  const n = props.suggestions.length;
  const limit = props.suggestionLimit;
  const first = n <= limit ? 0 : Math.min(Math.max(0, props.suggestIdx - limit + 1), n - limit);
  const shownSuggestions = props.suggestions.slice(first, first + limit);
  const nameCol = Math.max(0, ...props.suggestions.map((c) => c.name.length + (c.args ? c.args.length + 1 : 0))) + 3;
  return (
    <Box flexDirection="column" width={props.width}>
      {shownSuggestions.map((c, i) => {
        const selected = first + i === props.suggestIdx;
        const label = `/${c.name}${c.args ? ` ${c.args}` : ''}`;
        // Each row is fitted to the width by us (like every other line), not by Ink's nested-text truncation, which
        // mis-measures over-wide rows on narrow terminals (6.18 review: the highlighted row vanished at 30 columns).
        const row: Line = [
          // Folded (one row): the count comes first so a narrow terminal can never truncate it away.
          ...(props.suggestionFolded ? [{ text: `+${n - limit} ↑/↓ `, dim: true }] : []),
          { text: `${selected ? '▸ ' : '  '}${props.suggestionFolded ? label : label.padEnd(nameCol - 2)}`, color: 'cyan', bold: selected, inverse: selected },
          { text: ` ${c.description}`, dim: true },
        ];
        return <LineView key={c.name} line={fitLine(row, props.width)} />;
      })}
      {n > limit && !props.suggestionFolded && <LineView line={fitLine([{ text: `  +${n - limit} more · ↑/↓ to see them`, dim: true }], props.width)} />}
      <Text color={t.color(accent)}>{'─'.repeat(props.width)}</Text>
      <Box justifyContent="space-between" width={props.width}>
        <Text wrap="truncate">
          <Text color={t.color(to.valid ? accent : 'red')} bold>{toText}</Text>
          {!to.valid && <Text color={t.color('red')}> (unknown name)</Text>}
          {props.paused && <Text color={t.color('yellow')}> · room paused — deliveries held</Text>}
          {props.busy && <Text dimColor> · sending…</Text>}
        </Text>
        {props.width >= hints.length + 30 && <Text dimColor>{hints}</Text>}
      </Box>
      {lines.map((l, i) => (
        <Box key={i} width={props.width}>
          <Text color={t.color(accent)}>{gutter(i)}</Text>
          {l.before !== '' && <Text wrap="truncate">{l.before}</Text>}
          {l.cursor !== null && <Text inverse>{l.cursor}</Text>}
          {l.after !== '' && <Text wrap="truncate">{l.after}</Text>}
          {draft.text === '' && start + i === 0 && <Text dimColor wrap="truncate">Message everyone, or @name someone…</Text>}
        </Box>
      ))}
      {props.feedback && (
        <Text wrap="truncate" color={t.color(props.feedback.tone === 'error' ? 'red' : props.feedback.tone === 'ok' ? 'green' : 'cyan')}>
          {props.feedback.tone === 'error' ? '✗ ' : props.feedback.tone === 'ok' ? '✓ ' : '· '}
          {props.feedback.text}
        </Text>
      )}
    </Box>
  );
}

/**
 * The help as lines (6.10: a pager like /detail, so a growing command list never falls off a short terminal). The key
 * column is measured, so like items line up and no key runs into its description.
 */
export function helpLines(): Line[] {
  const keys: Array<[string, string]> = [
    ['Enter', 'send (to everyone unless you start with @names)'],
    ['@name …', 'address one or more agents; Tab completes names'],
    ['Ctrl+Enter, or \\ at line end', 'new line (Ctrl+Enter in Windows Terminal; Alt+Enter elsewhere)'],
    ['Ctrl+← / Ctrl+→', 'move by word'],
    ['Ctrl+Backspace, Ctrl+W', 'delete the previous word'],
    ['↑ / ↓', 'previous / next message you sent'],
    ['Esc', 'clear the draft (never interrupts an agent)'],
    ['PgUp / PgDn, Shift+↑/↓', 'scroll the conversation (and this help)'],
    ['End (empty draft), Ctrl+End', 'back to live'],
    ['Ctrl+B', 'layout: top bar ⇄ left panel'],
    ['Ctrl+T', 'top bar: full grid ⇄ compact'],
    ['Ctrl+C', 'quit'],
  ];
  const commands: Array<[string, string]> = [
    ...COMMAND_CATALOGUE.map((c): [string, string] => [`/${c.name}${c.args ? ` ${c.args}` : ''}`, c.description]),
    ['?', 'this help (with an empty draft); type / to list commands'],
  ];
  const keyWidth = Math.max(...[...keys, ...commands].map(([k]) => k.length)) + 2;
  const row = ([k, d]: [string, string]): Line => [{ text: k.padEnd(keyWidth), color: 'cyan' }, { text: d, dim: true }];
  const legend: Line = DELIVERY_LEGEND.flatMap((m): Line => [{ text: m.glyph, color: m.color }, { text: ` ${m.label}   `, dim: true }]);
  return [
    [{ text: 'Keys', bold: true }],
    ...keys.map(row),
    [{ text: ' ' }],
    [{ text: 'Commands', bold: true }],
    ...commands.map(row),
    [{ text: ' ' }],
    [{ text: 'Delivery marks', bold: true }],
    legend,
    [{ text: ' ' }],
    [{ text: 'Monochrome: set NO_COLOR=1 or run `room tui --no-color`. Esc to close.', dim: true }],
  ];
}
function WhoOverlay({ participants }: { participants: ParticipantState[] }) {
  const t = useTheme();
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text bold>Participants ({participants.length})</Text>
      {participants.length === 0 && <Text dimColor>No agents have joined yet. Agents join with `room join --as &lt;name&gt;`.</Text>}
      {participants.map((p) => {
        const dot = livenessDot(p.liveness);
        const status = activityLabel(p);
        const label = usageLabel(p.usage);
        const usage =
          label.text === 'usage n/a'
            ? `usage n/a${p.usage?.reason ? ` (${p.usage.reason})` : ''}`
            : `${label.text.replace(/\?$/, '')} · ${p.usage?.status === 'stale' ? 'stale, ' : ''}updated ${relativeTime(p.usage?.observedAt ?? null)}`;
        return (
          <Box key={p.name} flexDirection="column" flexShrink={0}>
            <Text wrap="truncate">
              <Text color={t.color(dot.color)}>{dot.glyph} </Text>
              <Text color={t.color(colorFor(p.name))} bold>{sanitize(p.name).padEnd(18)}</Text>
              <Text dimColor>{p.harness.padEnd(8)}</Text>
              <Text color={t.color(status.color)} dimColor={status.color === undefined}>{status.text.padEnd(26)}</Text>
              <Text dimColor>{usage}</Text>
            </Text>
            {p.workspace !== undefined && (
              <Text dimColor wrap="truncate">
                {'    '}
                {p.workspace?.model ? `${sanitize(p.workspace.model)} · ` : ''}
                {workspaceDetail(p.workspace)}
              </Text>
            )}
          </Box>
        );
      })}
      <Text> </Text>
      <Text dimColor>Esc to close</Text>
    </Box>
  );
}

function StatusBar({ offset, unseen, width }: { offset: number; unseen: number; width: number }) {
  const t = useTheme();
  // While scrolled, the scroll state owns the line (it must never be clipped); hints only when there's room.
  if (offset > 0) {
    return (
      <Box width={width}>
        <Text color={t.color('cyan')} wrap="truncate">
          ↑ scrolled{unseen > 0 ? ` · ${unseen} new below` : ''} · End to follow live
        </Text>
      </Box>
    );
  }
  const hints = 'PgUp/PgDn scroll · /help · Ctrl+C quit';
  return (
    <Box width={width} justifyContent="space-between">
      <Text dimColor>● live</Text>
      {width >= hints.length + 10 && <Text dimColor>{hints}</Text>}
    </Box>
  );
}

/** One segment, including bar surfaces (6.15: flat fill/track backgrounds; reverse video in monochrome). */
function SegmentText({ seg }: { seg: Line[number] }) {
  const t = useTheme();
  const s = surfaceStyle(seg, t.mono);
  return (
    <Text color={t.color(s.color)} backgroundColor={t.color(s.backgroundColor)} bold={seg.bold} dimColor={s.dim} italic={seg.italic} inverse={s.inverse} strikethrough={seg.strikethrough}>
      {s.blank ? seg.text.replace(/ /g, s.blank) : seg.text}
    </Text>
  );
}

function LineView({ line }: { line: Line }) {
  return (
    <Text wrap="truncate">
      {line.map((seg, i) => (
        <SegmentText key={i} seg={seg} />
      ))}
    </Text>
  );
}
