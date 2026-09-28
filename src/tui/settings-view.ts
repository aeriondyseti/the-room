// 7.6: the /settings panel — room delivery settings (hold, batching), edited by the human. Pure state + rendering;
// app.tsx wires keys and the settings_get / settings_update requests.
import type { DeliverySettings, DeliverySettingsPatch, RoomSettingsView } from '../contracts/settings.js';
import { fitLine, type Line } from './format.js';

export const SETTING_KEYS = ['deliveryHoldMs', 'batchHeld', 'batchMaxHoldMs'] as const satisfies ReadonlyArray<keyof DeliverySettings>;
type Key = (typeof SETTING_KEYS)[number];

const LABEL: Record<Key, string> = {
  deliveryHoldMs: 'Hold before delivery',
  batchHeld: 'Batch held messages',
  batchMaxHoldMs: 'Longest batch hold',
};
const HELP: Record<Key, string> = {
  deliveryHoldMs: 'Ordinary messages wait this long, so a quick withdraw works. 0 = off.',
  batchHeld: 'Messages from one sender to one recipient during the hold arrive as one delivery (needs a hold above 0).',
  batchMaxHoldMs: 'Each batched message restarts the hold, but never beyond this from the first.',
};
export const MS_STEP = 100;
export const MS_MAX = 60_000;

/**
 * A settings file the service could not use: delivery continues on the last good values (or the defaults), and a save
 * from the panel writes a repaired file. Read structurally so the panel works with the view the service returns.
 */
export interface SettingsProblem {
  source: string;
  code: string;
  message: string;
  fallback: 'last_good' | 'defaults';
}
export type SettingsViewData = RoomSettingsView & { problem?: SettingsProblem };

export interface SettingsState {
  view: SettingsViewData;
  /** Unsaved edits: a value, or null to reset that key to its default. */
  draft: DeliverySettingsPatch;
  selected: number;
}

/** Enter has something to save: edits, or a broken settings file to repair (an empty patch rewrites it). */
export function canSave(s: SettingsState): boolean {
  return isDirty(s) || s.view.problem !== undefined;
}

export function initialSettings(view: SettingsViewData): SettingsState {
  return { view, draft: {}, selected: 0 };
}

/** The value the panel shows as saved-to-be: a draft edit, a pending reset (the default), or the configured value. */
function pending<K extends Key>(s: SettingsState, key: K): DeliverySettings[K] {
  const d = s.draft[key];
  if (d === null) return s.view.defaults[key];
  return d !== undefined ? (d as DeliverySettings[K]) : s.view.configured[key];
}

function set<K extends Key>(s: SettingsState, key: K, value: DeliverySettings[K] | null): SettingsState {
  const draft = { ...s.draft };
  // An edit back to the saved value is no edit at all (keeps "unsaved" honest).
  if (value !== null && value === s.view.configured[key]) delete draft[key];
  else draft[key] = value as never;
  return { ...s, draft };
}

export type SettingsKey = 'up' | 'down' | 'left' | 'right' | 'reset';

export function settingsKey(s: SettingsState, key: SettingsKey): SettingsState {
  const n = SETTING_KEYS.length;
  if (key === 'up') return { ...s, selected: (s.selected + n - 1) % n };
  if (key === 'down') return { ...s, selected: (s.selected + 1) % n };
  const k = SETTING_KEYS[s.selected]!;
  if (key === 'reset') return set(s, k, null);
  if (k === 'batchHeld') return set(s, k, !pending(s, k));
  const cur = pending(s, k);
  const next = Math.min(MS_MAX, Math.max(0, cur + (key === 'right' ? MS_STEP : -MS_STEP)));
  return set(s, k, next);
}

export function isDirty(s: SettingsState): boolean {
  return Object.keys(s.draft).length > 0;
}

/** Client-side check before saving (the service validates too): the batch cap can't be shorter than the hold. */
export function draftProblem(s: SettingsState): string | null {
  const hold = pending(s, 'deliveryHoldMs'), max = pending(s, 'batchMaxHoldMs');
  return max < hold ? `Longest batch hold (${ms(max)}) must be at least the hold before delivery (${ms(hold)}).` : null;
}

export function ms(v: number): string {
  if (v === 0) return 'off';
  return v % 1000 === 0 ? `${v / 1000}s` : v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)}s`;
}

function show(key: Key, v: DeliverySettings[Key]): string {
  return key === 'batchHeld' ? (v ? 'on' : 'off') : ms(v as number);
}

/** Panel lines at `width`: one row per setting, its status, the selected row's help, and the key hints. */
export function settingsLines(s: SettingsState, width: number): Line[] {
  const out: Line[] = [fitLine([{ text: 'ROOM SETTINGS', dim: true, bold: true }, { text: '  apply to messages sent after saving', dim: true }], width)];
  const problem = s.view.problem;
  if (problem) {
    out.push(
      fitLine([{ text: `  The ${problem.source === 'file' ? 'settings file' : problem.source} can't be used (${problem.code}): ${problem.message}`, color: 'red' }], width),
      fitLine([{ text: `  Delivering with ${problem.fallback === 'last_good' ? 'the last good settings' : 'the default settings'} meanwhile; Enter saves a repaired file.`, color: 'red', dim: true }], width),
    );
  }
  out.push([]);
  const labelW = Math.max(...SETTING_KEYS.map((k) => LABEL[k].length));
  SETTING_KEYS.forEach((k, i) => {
    const sel = i === s.selected;
    const value = pending(s, k);
    const edited = k in s.draft;
    const overridden = s.view.overridden.includes(k);
    const status: Line = [];
    const unsaved = s.draft[k] === null ? ' · reset to default (unsaved)' : ' · unsaved';
    if (overridden) status.push({ text: `  in effect: ${show(k, s.view.effective[k])} (set by environment)${edited ? unsaved : ''}`, color: 'yellow' });
    else if (edited) status.push({ text: s.draft[k] === null ? '  reset to default (unsaved)' : '  unsaved', color: 'yellow' });
    else if (value !== s.view.defaults[k]) status.push({ text: `  changed · default ${show(k, s.view.defaults[k])}`, dim: true });
    else status.push({ text: '  default', dim: true });
    // A hold of 0 turns batching (and its cap) off in the service, so say so rather than show them as active.
    if (k !== 'deliveryHoldMs' && pending(s, 'deliveryHoldMs') === 0) status.push({ text: ' · no effect while the hold is off', dim: true, italic: true });
    out.push(fitLine([
      { text: sel ? '› ' : '  ', color: 'cyan', bold: true },
      { text: LABEL[k].padEnd(labelW), bold: sel },
      { text: '  ' },
      { text: sel ? `‹ ${show(k, value)} ›` : `  ${show(k, value)}  `, color: sel ? 'cyan' : undefined, bold: sel },
      ...status,
    ], width));
  });
  const k = SETTING_KEYS[s.selected]!;
  out.push([], fitLine([{ text: '  ' + HELP[k], dim: true, italic: true }], width));
  if (s.view.overridden.includes(k)) out.push(fitLine([{ text: '  Saved here, but an environment variable wins until it is unset.', dim: true, italic: true }], width));
  const draftIssue = draftProblem(s);
  if (draftIssue) out.push(fitLine([{ text: '  ' + draftIssue, color: 'red' }], width));
  const enter = isDirty(s) ? 'Enter save' : s.view.problem ? 'Enter repair file' : 'Enter close';
  out.push([], fitLine([{ text: `↑↓ choose · ←→ change · r default · ${enter} · Esc ${isDirty(s) ? 'discard' : 'close'}`, dim: true }], width));
  return out;
}
