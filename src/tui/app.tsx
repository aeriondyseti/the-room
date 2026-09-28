// The room TUI (ROADMAP 3.1 + 3.2): header, participants, a line-accurate conversation viewport, and the composer.
// Presentation only — all behavior lives in the service; this talks to a RoomSource.
import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { randomUUID } from 'node:crypto';
import { Box, Text, useApp, useInput, usePaste, useWindowSize } from 'ink';
import type { MessageWithDeliveries, ParticipantState } from '../contracts/domain.js';
import { toErrorInfo } from '../contracts/errors.js';
import type { RoomEvent } from '../contracts/ipc.js';
import {
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
import { DELIVERY_LEGEND, colorFor, conversationLines, deliveryMark, fitLine, lineText, participantsSummary, relativeTime, sanitize, usageLabel, type Line } from './format.js';
import { detailLines } from './detail.js';
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
  /** Participant panel width and the terminal width at which it appears (config: tuiPanelWidth / tuiPanelBreakpoint). */
  panelWidth?: number;
  panelBreakpoint?: number;
  /** Max pages read when catching up after a reconnect (config: tuiCatchUpMaxPages). */
  catchUpMaxPages?: number;
  /** Colour or monochrome (NO_COLOR / --no-color). */
  theme?: Theme;
}

const MAX_DRAFT_ROWS = 5;
/** Layout guard (not a preference): below this the conversation column is unreadable, so the panel yields. */
const MIN_CONVERSATION_WIDTH = 30;

/** Errors that prove a send never reached the service (so "Not sent" is true). Anything else is an unknown outcome. */
const DEFINITELY_NOT_SENT = new Set(['bad_request', 'unknown_recipient', 'no_recipients', 'message_too_large', 'dedup_conflict', 'identity_unresolved', 'identity_mismatch', 'not_registered', 'invalid_state', 'unsupported_version']);

type Feedback = { tone: 'ok' | 'info' | 'error'; text: string } | null;
type Overlay = 'help' | 'who' | { detail: number } | null;

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
  panelWidth = DEFAULT_CONFIG.tuiPanelWidth,
  panelBreakpoint = DEFAULT_CONFIG.tuiPanelBreakpoint,
  catchUpMaxPages = DEFAULT_CONFIG.tuiCatchUpMaxPages,
}: Omit<AppProps, 'theme'>) {
  const t = useTheme();
  const { exit } = useApp();
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
  // The panel never squeezes the conversation below a readable width, whatever the tunables say.
  const showPanel = colsTotal >= Math.max(panelBreakpoint, panelWidth + 1 + MIN_CONVERSATION_WIDTH);
  const convWidth = colsTotal - (showPanel ? panelWidth + 1 : 0) - 1;
  const banner = view.connection.state !== 'connected' || (view.notice !== null && view.loaded);
  const loadFailed = !view.loaded && view.notice !== null;
  const names = useMemo(() => view.participants.map((p) => p.name), [view.participants]);

  const draftRows = Math.min(MAX_DRAFT_ROWS, draft.text.split('\n').length);
  const composerHeight = 1 /* rule */ + 1 /* To: */ + draftRows + (feedback ? 1 : 0);
  const viewportHeight = Math.max(3, rows - 1 /* header */ - (banner ? 1 : 0) - composerHeight - 1 /* status */);

  const seqById = useMemo(() => new Map(view.items.map((i) => [i.message.id, i.message.seq] as const)), [view.items]);
  const lines = useMemo(
    // -1: the conversation box has one column of left padding.
    () => conversationLines(view.items, { width: convWidth - 1, humanName, seqById }),
    [view.items, convWidth, humanName, seqById],
  );
  const scroll = useScroll(lines.length, view.items.length, viewportHeight);

  // Delivery detail overlay: its own line model and scroll offset (lines from the top).
  const [detailOffset, setDetailOffset] = useState(0);
  const detailItem = overlay !== null && typeof overlay === 'object' ? view.items.find((i) => i.message.seq === overlay.detail) ?? null : null;
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

  const submit = () => {
    const parsed = parseComposer(draft.text, names);
    if (parsed.kind === 'empty') return;
    if (parsed.kind === 'error') {
      setFeedback({ tone: 'error', text: parsed.message });
      return;
    }
    if (parsed.kind === 'message') {
      const text = draft.text;
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
    const submitted = draft.text;
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
    if (overlay) {
      if (key.escape || key.return || input === 'q' || input === '?') {
        setOverlay(null);
        setDetailOffset(0);
        return;
      }
      if (detail) {
        const page = Math.max(1, viewportHeight - 2);
        const clamp = (n: number) => Math.min(detail.max, Math.max(0, n));
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

    if (key.escape) {
      if (draft.text !== '') edit(EMPTY_DRAFT);
      else setFeedback(null);
      return;
    }
    if (key.return) {
      if (busy) return;
      if (key.meta) return edit(insert(draft, '\n'));
      if (draft.text.slice(0, draft.cursor).endsWith('\\') && draft.cursor === draft.text.length) {
        return edit({ text: draft.text.slice(0, -1) + '\n', cursor: draft.text.length });
      }
      return submit();
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
    if (key.leftArrow) return edit(left(draft));
    if (key.rightArrow) return edit(right(draft));
    if (key.home) return edit(home(draft));
    if (key.end) return edit(end(draft));
    if (key.backspace) return edit(backspace(draft));
    if (key.delete) return edit(del(draft));
    if (input === '?' && draft.text === '') return setOverlay('help');
    if (key.ctrl || key.meta || input === '') return;
    edit(insert(draft, input));
  });

  const to = addressee(draft.text, names);

  return (
    <Box flexDirection="column" width={colsTotal} height={rows}>
      <Header view={view} width={colsTotal} />
      {banner && <Banner view={view} width={colsTotal} />}
      <Box flexDirection="row" height={viewportHeight}>
        {showPanel && (
          <Participants participants={view.participants} humanName={humanName} height={viewportHeight} stale={view.connection.state !== 'connected'} panelWidth={panelWidth} />
        )}
        <Box flexDirection="column" width={convWidth} paddingLeft={1} justifyContent={overlay ? 'flex-start' : 'flex-end'} overflow="hidden">
          {overlay === 'help' ? (
            <HelpOverlay />
          ) : overlay === 'who' ? (
            <WhoOverlay participants={view.participants} />
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
        to={to}
        paused={view.room.paused}
        busy={busy}
        feedback={feedback}
        connected={view.connection.state === 'connected'}
      />
      <StatusBar offset={scroll.offset} unseen={scroll.unseen} width={colsTotal} />
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
          dispatch({ type: 'snapshot', items, participants: who.participants, room: who.room });
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
      <Text>
        <Text inverse bold> vibe-pairing </Text>
        {view.room.paused && <Text color={t.color('yellow')} inverse bold> ⏸ PAUSED </Text>}
      </Text>
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

function Participants({ participants, humanName, height, stale, panelWidth }: { participants: ParticipantState[]; humanName: string; height: number; stale: boolean; panelWidth: number }) {
  const t = useTheme();
  // Two rows per participant (name, then status); keep room for the title and footer.
  const capacity = Math.max(0, Math.floor((height - 4) / 2));
  const shown = participants.slice(0, capacity);
  const hidden = participants.length - shown.length;
  return (
    <Box flexDirection="column" width={panelWidth} borderStyle="single" borderTop={false} borderBottom={false} borderLeft={false} paddingRight={1}>
      <Text dimColor bold>PARTICIPANTS{stale ? ' · stale' : ''}</Text>
      {participants.length === 0 && <Text dimColor>none yet</Text>}
      {shown.map((p) => {
        // While disconnected we can't vouch for liveness: grey everything out (invariant 3).
        const live = stale ? { glyph: '◌', color: 'gray' } : livenessDot(p.liveness);
        const status = stale ? { text: 'last known: ' + activityLabel(p).text } : activityLabel(p);
        const label = usageLabel(p.usage);
        // Monochrome can't show the warning colour, so a high reading gets a "!" instead.
        const usage = t.mono && label.color ? { ...label, text: `${label.text}!` } : label;
        // Leave a clear gap between a long name and its usage label: truncate the name, never the usage.
        const nameRoom = panelWidth - 2 /* padding+border */ - 2 /* glyph */ - (stale ? 0 : usage.text.length + 1);
        const name = lineText(fitLine([{ text: sanitize(p.name) }], Math.max(4, nameRoom)));
        return (
          <Box key={p.name} flexDirection="column">
            <Box justifyContent="space-between" width={panelWidth - 2}>
              <Text>
                <Text color={t.color(live.color)}>{live.glyph} </Text>
                <Text color={t.color(stale ? 'gray' : colorFor(p.name))} bold>{name}</Text>
              </Text>
              {!stale && <Text color={t.color(usage.color)} dimColor={usage.dim}>{usage.text}</Text>}
            </Box>
            <Text wrap="truncate" color={t.color(status.color)} dimColor={status.color === undefined}>
              {'  '}{status.text}
            </Text>
          </Box>
        );
      })}
      {hidden > 0 && <Text dimColor>+{hidden} more · /who</Text>}
      <Text> </Text>
      <Text dimColor wrap="truncate">you: {humanName}</Text>
    </Box>
  );
}

function livenessDot(l: ParticipantState['liveness']): { glyph: string; color: string } {
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

/** Short status under a participant's name. Attention states get a color; the rest stay dim. */
export function activityLabel(p: ParticipantState): { text: string; color?: string } {
  const pending = p.pending > 0 ? ` · ${p.pending} queued` : '';
  if (p.liveness === 'offline') return { text: `offline${pending}` };
  if (p.liveness === 'rebind_needed') return { text: `rebind needed${pending}`, color: 'yellow' };
  if (p.activity === 'waiting_permission') return { text: `needs approval${pending}`, color: 'yellow' };
  if (p.activity === 'unknown') return { text: `status unknown${pending}` };
  return { text: `${p.activity}${pending}` };
}

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
  to: { label: string; valid: boolean };
  paused: boolean;
  busy: boolean;
  feedback: Feedback;
  connected: boolean;
}) {
  const { draft, to } = props;
  const t = useTheme();
  const accent = !props.connected ? 'gray' : props.paused ? 'yellow' : 'cyan';
  const toText = to.label === 'command' ? 'command' : `To: ${to.label}`;
  const lines = draftLines(draft, props.rows);
  const hints = 'Enter send · Alt+Enter newline · Tab @name · ? help';
  return (
    <Box flexDirection="column" width={props.width}>
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
          <Text color={t.color(accent)}>{i === 0 ? '› ' : '  '}</Text>
          {l.before !== '' && <Text>{l.before}</Text>}
          {l.cursor !== null && <Text inverse>{l.cursor}</Text>}
          {l.after !== '' && <Text wrap="truncate">{l.after}</Text>}
          {draft.text === '' && i === 0 && <Text dimColor wrap="truncate">Message everyone, or @name someone…</Text>}
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

/** Split the draft into display rows (last `rows` lines around the cursor) with the cursor cell marked. */
function draftLines(draft: Draft, rows: number): Array<{ before: string; cursor: string | null; after: string }> {
  const all = draft.text.split('\n');
  const before = draft.text.slice(0, draft.cursor);
  const cursorRow = before.split('\n').length - 1;
  const cursorCol = before.length - (before.lastIndexOf('\n') + 1);
  const start = Math.max(0, Math.min(cursorRow - rows + 1, all.length - rows));
  return all.slice(start, start + rows).map((text, idx) => {
    const row = start + idx;
    if (row !== cursorRow) return { before: sanitize(text), cursor: null, after: '' };
    const cp = Array.from(text.slice(cursorCol))[0];
    return {
      before: sanitize(text.slice(0, cursorCol)),
      cursor: cp !== undefined ? sanitize(cp) : ' ',
      after: cp !== undefined ? sanitize(text.slice(cursorCol + cp.length)) : '',
    };
  });
}

function HelpOverlay() {
  const t = useTheme();
  const keys: Array<[string, string]> = [
    ['Enter', 'send (to everyone unless you start with @names)'],
    ['@name …', 'address one or more agents; Tab completes names'],
    ['Alt+Enter, or \\ at line end', 'new line'],
    ['↑ / ↓', 'previous / next message you sent'],
    ['Esc', 'clear the draft (never interrupts an agent)'],
    ['PgUp / PgDn, Shift+↑/↓', 'scroll the conversation'],
    ['End (empty draft), Ctrl+End', 'back to live'],
    ['Ctrl+C', 'quit'],
  ];
  const commands: Array<[string, string]> = [
    ['/pause [message]', 'hold new deliveries and ask every agent to stop'],
    ['/resume', 'release held deliveries in order'],
    ['/retry #N [@agent]', 're-send a failed or uncertain delivery'],
    ['/detail [#N]', 'delivery detail: attempts, evidence, errors'],
    ['/who', 'participants and their status'],
    ['/restart', 'restart the room service (e.g. after an upgrade); keeps queued messages'],
    ['/help or ?', 'this help'],
  ];
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text bold>Keys</Text>
      {keys.map(([k, d]) => (
        <Text key={k} wrap="truncate">
          <Text color={t.color('cyan')}>{k.padEnd(27)}</Text>
          <Text dimColor>{d}</Text>
        </Text>
      ))}
      <Text> </Text>
      <Text bold>Commands</Text>
      {commands.map(([k, d]) => (
        <Text key={k} wrap="truncate">
          <Text color={t.color('cyan')}>{k.padEnd(27)}</Text>
          <Text dimColor>{d}</Text>
        </Text>
      ))}
      <Text> </Text>
      <Text bold>Delivery marks</Text>
      <Text wrap="truncate">
        {DELIVERY_LEGEND.map((m, i) => (
          <Text key={i}>
            <Text color={t.color(m.color)}>{m.glyph}</Text>
            <Text dimColor> {m.label}   </Text>
          </Text>
        ))}
      </Text>
      <Text> </Text>
      <Text dimColor wrap="truncate">Monochrome: set NO_COLOR=1 or run `room tui --no-color`. Esc to close.</Text>
    </Box>
  );
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
          <Text key={p.name} wrap="truncate">
            <Text color={t.color(dot.color)}>{dot.glyph} </Text>
            <Text color={t.color(colorFor(p.name))} bold>{sanitize(p.name).padEnd(18)}</Text>
            <Text dimColor>{p.harness.padEnd(8)}</Text>
            <Text color={t.color(status.color)} dimColor={status.color === undefined}>{status.text.padEnd(26)}</Text>
            <Text dimColor>{usage}</Text>
          </Text>
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

function LineView({ line }: { line: Line }) {
  const t = useTheme();
  return (
    <Text wrap="truncate">
      {line.map((seg, i) => (
        <Text key={i} color={t.color(seg.color)} bold={seg.bold} dimColor={seg.dim} italic={seg.italic} inverse={seg.inverse}>
          {seg.text}
        </Text>
      ))}
    </Text>
  );
}
