// 7.6: the /settings pane. Owns its keys while open (like the activity pane): ↑↓ choose, ←→ change, r default,
// Enter save, Esc close (discarding unsaved edits). Saving is one settings_update with only the edited keys.
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { toErrorInfo } from '../contracts/errors.js';
import { fitLine, type Line } from './format.js';
import { canSave, draftProblem, initialSettings, isDirty, settingsKey, settingsLines, type SettingsState } from './settings-view.js';
import type { RoomSource } from './source.js';
import { useTheme } from './theme.js';

export interface SettingsResult {
  tone: 'ok' | 'info' | 'error';
  text: string;
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

export function SettingsPane(props: { source: RoomSource; width: number; height: number; onClose: (result: SettingsResult | null) => void }) {
  const [state, setState] = useState<SettingsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    props.source.request('settings_get', {}).then(
      (view) => live && setState(initialSettings(view)),
      (e: unknown) => live && setError(`Couldn't load settings: ${toErrorInfo(e).message}`),
    );
    return () => {
      live = false;
    };
    // Loaded once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A save that settles after the pane closed must not touch whatever is on screen by then.
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
  }, []);

  useInput((input, key) => {
    // Like the app: a key RELEASE (CSI-u event type 3) is never an action, or each step would apply twice.
    if (key.eventType === 'release') return;
    // While a save is in flight nothing (not even Esc) may claim the edits were discarded.
    if (saving) return;
    if (key.escape || input === 'q') {
      return props.onClose(state && isDirty(state) ? { tone: 'info', text: 'Settings unchanged (edits discarded).' } : null);
    }
    if (!state) return;
    const edit = (k: 'up' | 'down' | 'left' | 'right' | 'reset') => {
      setError(null);
      setState(settingsKey(state, k));
    };
    if (key.upArrow) return edit('up');
    if (key.downArrow) return edit('down');
    if (key.leftArrow) return edit('left');
    if (key.rightArrow) return edit('right');
    if (input === 'r') return edit('reset');
    if (key.return) {
      if (!canSave(state)) return props.onClose(null);
      const repairing = state.view.problem !== undefined;
      const problem = draftProblem(state);
      if (problem) return setError(problem);
      setSaving(true);
      setError(null);
      props.source.request('settings_update', { caller: { kind: 'human' }, patch: state.draft }).then(
        (view) => {
          if (!mounted.current) return;
          const env = view.overridden.length ? ` (${view.overridden.length} still set by environment)` : '';
          props.onClose({ tone: 'ok', text: repairing ? `Settings file repaired and saved; delivery uses it from now on${env}.` : `Settings saved; they apply to messages sent from now on${env}.` });
        },
        (e: unknown) => {
          if (!mounted.current) return;
          const info = toErrorInfo(e);
          setSaving(false);
          setError(`Not saved: ${info.message}${info.hint ? ` — ${info.hint}` : ''}`);
        },
      );
    }
  });

  const width = Math.max(10, props.width);
  let lines: Line[];
  if (!state) lines = [fitLine([{ text: error ?? 'Loading settings…', color: error ? 'red' : undefined, dim: !error }], width), [], fitLine([{ text: 'Esc close', dim: true }], width)];
  else {
    lines = settingsLines(state, width);
    if (saving) lines.push(fitLine([{ text: 'Saving…', dim: true }], width));
    // Service-side errors (the draft check already shows inline in the panel).
    else if (error && error !== draftProblem(state)) lines.push(fitLine([{ text: error, color: 'red' }], width));
  }
  const shown = lines.slice(0, Math.max(1, props.height));
  return (
    <Box flexDirection="column" flexShrink={0}>
      {shown.map((line, i) => (
        <LineView key={i} line={line} />
      ))}
    </Box>
  );
}
