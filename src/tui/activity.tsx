// Activity pane (ROADMAP 6.1): one agent's observed tool calls, results and messages, read-only and presentation
// only. Opened with `/activity @name`; Esc returns to the room. Honest about coverage: an unreadable or unsupported
// transcript is labelled, evicted history says so, and a catching-up reader is never shown as complete.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ActivityItem, ActivityPage, ActivityStreamId } from '../contracts/activity.js';
import { fitLine, formatTime, sanitize, wrapText, type Line } from './format.js';
import type { RoomSource } from './source.js';
import { useTheme } from './theme.js';

export type ActivityFilter = 'all' | 'tools' | 'errors';
const FILTERS: ActivityFilter[] = ['all', 'tools', 'errors'];
const PAGE = 200;

/** Glyph + colour per item kind (every state has a glyph, so monochrome loses nothing). */
function mark(item: ActivityItem): { glyph: string; color?: string } {
  switch (item.kind) {
    case 'tool_call':
      return { glyph: '▸', color: 'cyan' };
    case 'tool_result':
      // Only an explicit isError:false is shown as success; unknown (undefined) stays neutral (invariant 3).
      return item.isError === true ? { glyph: '✗', color: 'red' } : item.isError === false ? { glyph: '✓', color: 'green' } : { glyph: '◂' };
    case 'message':
      return item.role === 'user' ? { glyph: '›', color: 'yellow' } : { glyph: '‹', color: 'magenta' };
    case 'turn_start':
      return { glyph: '┌' };
    case 'turn_end':
      return { glyph: '└' };
  }
}

export function visibleItems(items: readonly ActivityItem[], filter: ActivityFilter): ActivityItem[] {
  if (filter === 'tools') return items.filter((i) => i.kind === 'tool_call' || i.kind === 'tool_result');
  if (filter === 'errors') return items.filter((i) => i.isError === true);
  return [...items];
}

/** Line model: one line per item, plus wrapped detail under expanded items. Returns the line index of each item. */
export function activityLines(
  items: readonly ActivityItem[],
  opts: { width: number; selected: number; expanded: ReadonlySet<number> },
): { lines: Line[]; starts: number[] } {
  const lines: Line[] = [];
  const starts: number[] = [];
  items.forEach((item, idx) => {
    starts.push(lines.length);
    const m = mark(item);
    const sel = idx === opts.selected;
    const head: Line = [
      { text: sel ? '▶ ' : '  ', bold: sel },
      { text: item.at ? formatTime(item.at) : '--:--', dim: true },
      { text: ' ' },
      { text: m.glyph, color: m.color },
      { text: ' ' },
      ...(item.tool ? [{ text: `${sanitize(item.tool)} `, bold: true, color: m.color }] : []),
      { text: sanitize(item.summary), dim: item.kind === 'turn_start' || item.kind === 'turn_end' },
    ];
    lines.push(fitLine(head, opts.width));
    if (opts.expanded.has(item.seq)) {
      const body = item.detail ?? '';
      if (body === '') lines.push([{ text: '      (no detail)', dim: true }]);
      for (const t of wrapText(body, Math.max(10, opts.width - 6))) lines.push([{ text: '      ' }, { text: t }]);
      if (item.detailTruncated) lines.push([{ text: '      … truncated (detail cap reached)', dim: true, italic: true }]);
    }
  });
  return { lines, starts };
}

function LineView({ line }: { line: Line }) {
  const t = useTheme();
  return (
    <Text wrap="truncate">
      {line.map((s, i) => (
        <Text key={i} color={t.color(s.color)} bold={s.bold} dimColor={s.dim} italic={s.italic} inverse={s.inverse}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

export function ActivityPane(props: { source: RoomSource; participant: string; width: number; height: number; onClose: () => void }) {
  const t = useTheme();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [page, setPage] = useState<ActivityPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [selected, setSelected] = useState(-1); // -1 = follow the newest item
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const stream = useRef<ActivityStreamId | null>(null);

  const load = async () => {
    try {
      const p = await props.source.request('activity', { participant: props.participant, limit: PAGE });
      stream.current = p.stream;
      setPage(p);
      setItems(p.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
    return props.source.onEvent((e) => {
      if (e.type !== 'activity.appended' || e.stream.participant !== props.participant) return;
      const same = stream.current && stream.current.sessionId === e.stream.sessionId && stream.current.generation === e.stream.generation;
      if (e.reset || !same) {
        setExpanded(new Set());
        setSelected(-1);
        void load(); // new binding or rotated transcript: start over rather than mixing streams
        return;
      }
      setItems((prev) => {
        const last = prev.at(-1)?.seq ?? 0;
        return [...prev, ...e.items.filter((i) => i.seq > last)];
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.source, props.participant]);

  const shown = useMemo(() => visibleItems(items, filter), [items, filter]);
  const sel = selected < 0 || selected >= shown.length ? shown.length - 1 : selected;
  const width = Math.max(20, props.width - 1);
  const { lines, starts } = useMemo(() => activityLines(shown, { width, selected: sel, expanded }), [shown, width, sel, expanded]);

  const loadOlder = async () => {
    const earliest = items[0]?.seq;
    if (earliest === undefined || !stream.current) return;
    try {
      const p = await props.source.request('activity', { participant: props.participant, stream: stream.current, beforeSeq: earliest, limit: PAGE });
      if (p.reset) return void load();
      setPage((old) => (old ? { ...old, olderEvicted: p.olderEvicted, hasMore: p.hasMore } : p));
      setItems((prev) => [...p.items.filter((i) => i.seq < (prev[0]?.seq ?? Infinity)), ...prev]);
      setSelected((s) => (s < 0 ? s : s + p.items.length));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useInput((input, key) => {
    if (key.escape || input === 'q') return props.onClose();
    if (key.upArrow) return setSelected(Math.max(0, sel - 1));
    if (key.downArrow) return setSelected(sel + 1 >= shown.length ? -1 : sel + 1);
    if (key.end) return setSelected(-1);
    if (key.return || input === ' ') {
      const item = shown[sel];
      if (!item) return;
      setSelected(sel);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(item.seq)) next.delete(item.seq);
        else next.add(item.seq);
        return next;
      });
      return;
    }
    if (input === 'f') {
      setFilter((f) => FILTERS[(FILTERS.indexOf(f) + 1) % FILTERS.length]!);
      setSelected(-1);
      return;
    }
    if (key.pageUp || input === 'o') return void loadOlder();
  });

  // Viewport: keep the selected item visible (bottom-anchored when following live).
  const room = Math.max(1, props.height - 3);
  const anchor = sel >= 0 && starts[sel] !== undefined ? starts[sel]! : lines.length - 1;
  const endLine = Math.min(lines.length, Math.max(room, anchor + 1 + (expanded.has(shown[sel]?.seq ?? -1) ? room - 1 : 0)));
  const visible = lines.slice(Math.max(0, endLine - room), endLine);

  const cov = page?.coverage;
  const covText = !page ? 'loading…' : cov === 'full' ? (page.backlog ? 'catching up…' : 'live') : cov === 'partial' ? 'partial' : 'unavailable';
  const covColor = !page ? undefined : cov === 'full' ? (page.backlog ? 'yellow' : 'green') : cov === 'partial' ? 'yellow' : 'red';
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text wrap="truncate">
        <Text bold>Activity · {sanitize(props.participant)}</Text>
        <Text dimColor>{page?.stream ? ` (${page.stream.harness})` : ''} · filter: {filter} · </Text>
        <Text color={t.color(covColor)}>{t.mono && cov && cov !== 'full' ? '! ' : ''}{sanitize(covText)}</Text>
      </Text>
      {page && cov !== 'full' && page.reason && (
        // The reason is what the user needs: its own wrapped line, never cut off at the end of the header.
        <Text color={t.color(covColor)} wrap="wrap">{cov === 'partial' ? 'Partial coverage: ' : 'Unavailable: '}{sanitize(page.reason)}</Text>
      )}
      {error && <Text color={t.color('red')} wrap="truncate">✗ {sanitize(error)}</Text>}
      {page?.olderEvicted && (visible.length === 0 || starts[0] === 0) && <Text dimColor wrap="truncate">… earlier activity isn't retained</Text>}
      {page && shown.length === 0 && !error && (
        <Text dimColor wrap="truncate">{cov === 'unavailable' ? 'No activity to show (see above).' : filter === 'all' ? 'No activity observed yet.' : `Nothing matches the "${filter}" filter.`}</Text>
      )}
      {visible.map((line, i) => (
        <LineView key={i} line={line} />
      ))}
      <Text dimColor wrap="truncate">↑/↓ select · Enter expand · f filter · PgUp older · End live · Esc back</Text>
    </Box>
  );
}
