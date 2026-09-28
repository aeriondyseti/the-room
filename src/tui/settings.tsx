// 7.6: the /settings pane. Owns its keys while open (like the activity pane): ↑↓ choose, ←→ change, r default,
// Enter save, Esc close (discarding unsaved edits). Saving is one settings_update with only the edited keys.
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { toErrorInfo } from '../contracts/errors.js';
import { fitLine, type Line } from './format.js';
import { draftProblem, initialSettings, isDirty, settingsKey, settingsLines, type SettingsState } from './settings-view.js';
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

  useInput((input, key) => {
    if (key.escape || (input === 'q' && !saving)) {
      return props.onClose(state && isDirty(state) ? { tone: 'info', text: 'Settings unchanged (edits discarded).' } : null);
    }
    if (!state || saving) return;
    if (key.upArrow) return setState(settingsKey(state, 'up'));
    if (key.downArrow) return setState(settingsKey(state, 'down'));
    if (key.leftArrow) return setState(settingsKey(state, 'left'));
    if (key.rightArrow) return setState(settingsKey(state, 'right'));
    if (input === 'r') return setState(settingsKey(state, 'reset'));
    if (key.return) {
      if (!isDirty(state)) return props.onClose(null);
      const problem = draftProblem(state);
      if (problem) return setError(problem);
      setSaving(true);
      setError(null);
      props.source.request('settings_update', { caller: { kind: 'human' }, patch: state.draft }).then(
        (view) => {
          const env = view.overridden.length ? ` (${view.overridden.length} still set by environment)` : '';
          props.onClose({ tone: 'ok', text: `Settings saved; they apply to messages sent from now on${env}.` });
        },
        (e: unknown) => {
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
