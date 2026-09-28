// The room TUI (ROADMAP 3.1): header, participants, a line-accurate conversation viewport, and a status bar.
// Presentation only — all behavior lives in the service; this talks to a RoomSource.
import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { ParticipantState } from '../contracts/domain.js';
import { toErrorInfo } from '../contracts/errors.js';
import { conversationLines, colorFor, type Line } from './format.js';
import type { RoomSource } from './source.js';
import { INITIAL_VIEW, reduceView, type RoomView, type ViewAction } from './state.js';

export interface AppProps {
  source: RoomSource;
  humanName: string;
  /** Override terminal size (tests); defaults to the live window size. */
  width?: number;
  height?: number;
  /** Messages loaded on (re)connect. */
  historyLimit?: number;
}

const PANEL_WIDTH = 26;
const WIDE_ENOUGH_FOR_PANEL = 90;

export function App({ source, humanName, width, height, historyLimit = 500 }: AppProps) {
  const [view, dispatch] = useReducer(reduceView, INITIAL_VIEW, (v): RoomView => ({ ...v, connection: source.status() }));
  useRoomSync(source, dispatch, historyLimit);

  const window = useWindowSize();
  const cols = Math.max(20, width ?? window.columns);
  const rows = Math.max(8, height ?? window.rows);
  const showPanel = cols >= WIDE_ENOUGH_FOR_PANEL;
  const convWidth = cols - (showPanel ? PANEL_WIDTH + 1 : 0) - 1;
  const banner = view.connection.state !== 'connected' || view.notice !== null;
  const viewportHeight = rows - 2 /* header + status */ - (banner ? 1 : 0);

  const seqById = useMemo(() => new Map(view.items.map((i) => [i.message.id, i.message.seq] as const)), [view.items]);
  const lines = useMemo(
    // -1: the conversation box has one column of left padding.
    () => conversationLines(view.items, { width: convWidth - 1, humanName, seqById }),
    [view.items, convWidth, humanName, seqById],
  );
  const scroll = useScroll(lines.length, view.items.length, viewportHeight);

  const end = lines.length - scroll.offset;
  const visible = lines.slice(Math.max(0, end - viewportHeight), end);

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Header view={view} width={cols} />
      {banner && <Banner view={view} width={cols} />}
      <Box flexDirection="row" height={viewportHeight}>
        {showPanel && <Participants participants={view.participants} humanName={humanName} height={viewportHeight} />}
        <Box flexDirection="column" width={convWidth} paddingLeft={1} justifyContent="flex-end">
          {!view.loaded ? (
            <Text dimColor>Loading room…</Text>
          ) : view.items.length === 0 ? (
            <EmptyState />
          ) : (
            visible.map((line, i) => <LineView key={i} line={line} />)
          )}
        </Box>
      </Box>
      <StatusBar scroll={scroll} width={cols} />
    </Box>
  );
}

// ---- data sync ------------------------------------------------------------------------------------------

function useRoomSync(source: RoomSource, dispatch: React.Dispatch<ViewAction>, historyLimit: number): void {
  useEffect(() => {
    let alive = true;
    let loading = false;
    let previous = source.status().state;
    // Contract: subscribe replays messages only, so every (re)connect refreshes who + recent history too.
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        await source.request('subscribe', { afterSeq: null });
        const [who, read] = await Promise.all([
          source.request('who', {}),
          source.request('read', { limit: historyLimit, includeDeliveries: true }),
        ]);
        if (alive) {
          dispatch({ type: 'snapshot', items: read.items, participants: who.participants, room: who.room });
          dispatch({ type: 'notice', notice: null });
        }
      } catch (err) {
        if (alive) dispatch({ type: 'notice', notice: `Couldn't load the room: ${toErrorInfo(err).message}` });
      } finally {
        loading = false;
      }
    };
    const offEvent = source.onEvent((event) => dispatch({ type: 'event', event }));
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
  }, [source, dispatch, historyLimit]);
}

// ---- scrolling ------------------------------------------------------------------------------------------

export interface ScrollState {
  /** Lines scrolled up from the live bottom (0 = following live). */
  offset: number;
  /** Messages that arrived below the viewport while scrolled up. */
  unseen: number;
}

function useScroll(lineCount: number, messageCount: number, viewportHeight: number): ScrollState {
  const [state, setState] = useState<ScrollState>({ offset: 0, unseen: 0 });
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

  useInput((input, key) => {
    const page = Math.max(1, viewportHeight - 1);
    const to = (offset: number) =>
      setState((s) => {
        const next = Math.min(maxOffset, Math.max(0, offset));
        return { offset: next, unseen: next === 0 ? 0 : s.unseen };
      });
    if (key.pageUp) to(state.offset + page);
    else if (key.pageDown) to(state.offset - page);
    else if (key.upArrow) to(state.offset + 1);
    else if (key.downArrow) to(state.offset - 1);
    else if (key.home) to(maxOffset);
    else if (key.end) to(0);
    else if (input === 'G') to(0);
  });

  return { offset: Math.min(state.offset, maxOffset), unseen: state.unseen };
}

// ---- pieces ---------------------------------------------------------------------------------------------

function Header({ view, width }: { view: RoomView; width: number }) {
  const conn = connectionBadge(view.connection.state);
  const agents = view.participants.length;
  return (
    <Box width={width} justifyContent="space-between">
      <Text>
        <Text inverse bold> vibe-pairing </Text>
        {view.room.paused && <Text color="yellow" inverse bold> ⏸ PAUSED </Text>}
      </Text>
      <Text>
        <Text dimColor>{agents === 1 ? '1 agent' : `${agents} agents`}  </Text>
        <Text color={conn.color}>{conn.glyph} {conn.label}</Text>
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
  if (view.connection.state !== 'connected') {
    const detail = view.connection.detail ? ` (${view.connection.detail})` : '';
    const text =
      view.connection.state === 'disconnected'
        ? `Not connected to the room service${detail}. Run \`room doctor\` if this persists.`
        : `Reconnecting to the room service${detail}… what you see may be out of date.`;
    return (
      <Box width={width}>
        <Text color="yellow" wrap="truncate">{text}</Text>
      </Box>
    );
  }
  return (
    <Box width={width}>
      <Text color="yellow" wrap="truncate">{view.notice}</Text>
    </Box>
  );
}

function Participants({ participants, humanName, height }: { participants: ParticipantState[]; humanName: string; height: number }) {
  // Two rows per participant (name, then status); keep room for the title and footer.
  const capacity = Math.max(0, Math.floor((height - 4) / 2));
  const shown = participants.slice(0, capacity);
  const hidden = participants.length - shown.length;
  return (
    <Box flexDirection="column" width={PANEL_WIDTH} borderStyle="single" borderTop={false} borderBottom={false} borderLeft={false} paddingRight={1}>
      <Text dimColor bold>PARTICIPANTS</Text>
      {participants.length === 0 && <Text dimColor>none yet</Text>}
      {shown.map((p) => {
        const live = livenessDot(p.liveness);
        const status = activityLabel(p);
        return (
          <Box key={p.name} flexDirection="column">
            <Text wrap="truncate">
              <Text color={live.color}>{live.glyph} </Text>
              <Text color={colorFor(p.name)} bold>{p.name}</Text>
            </Text>
            <Text wrap="truncate" color={status.color} dimColor={status.color === undefined}>
              {'  '}{status.text}
            </Text>
          </Box>
        );
      })}
      {hidden > 0 && <Text dimColor>+{hidden} more</Text>}
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

function EmptyState() {
  return (
    <Box flexDirection="column">
      <Text bold>The room is quiet.</Text>
      <Text dimColor>Messages between you and the agents appear here as they're sent.</Text>
      <Text dimColor>Agents join with `room join --as &lt;name&gt;` (or the room_join tool).</Text>
    </Box>
  );
}

function StatusBar({ scroll, width }: { scroll: ScrollState; width: number }) {
  return (
    <Box width={width} justifyContent="space-between">
      {scroll.offset > 0 ? (
        <Text color="cyan">
          ↑ scrolled{scroll.unseen > 0 ? ` · ${scroll.unseen} new below` : ''} · End to follow live
        </Text>
      ) : (
        <Text dimColor>● live</Text>
      )}
      <Text dimColor>PgUp/PgDn scroll · Home/End · Ctrl+C quit</Text>
    </Box>
  );
}

function LineView({ line }: { line: Line }) {
  return (
    <Text wrap="truncate">
      {line.map((seg, i) => (
        <Text key={i} color={seg.color} bold={seg.bold} dimColor={seg.dim} italic={seg.italic} inverse={seg.inverse}>
          {seg.text}
        </Text>
      ))}
    </Text>
  );
}
