import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RoomSettingsView } from '../contracts/settings.js';
import { lineCols, lineText } from './format.js';
import { draftProblem, initialSettings, isDirty, ms, settingsKey, settingsLines, type SettingsKey, type SettingsState } from './settings-view.js';

const defaults = { deliveryHoldMs: 500, batchHeld: true, batchMaxHoldMs: 2000 };
const view = (over: Partial<RoomSettingsView> = {}): RoomSettingsView => ({ defaults, configured: { ...defaults }, effective: { ...defaults }, overridden: [], ...over });
const press = (s: SettingsState, ...keys: SettingsKey[]) => keys.reduce(settingsKey, s);
const text = (s: SettingsState, width = 100) => settingsLines(s, width).map(lineText).join('\n');

test('durations read naturally', () => {
  assert.equal(ms(0), 'off');
  assert.equal(ms(500), '500 ms');
  assert.equal(ms(2000), '2s');
  assert.equal(ms(1500), '1.5s');
});

test('arrows move the selection and wrap', () => {
  const s = initialSettings(view());
  assert.equal(press(s, 'up').selected, 2);
  assert.equal(press(s, 'down', 'down', 'down').selected, 0);
});

test('left/right step milliseconds by 100 within 0..60000, and toggle batching', () => {
  let s = initialSettings(view());
  s = press(s, 'right', 'right');
  assert.equal(s.draft.deliveryHoldMs, 700);
  s = press(initialSettings(view({ configured: { ...defaults, deliveryHoldMs: 0 } })), 'left');
  assert.equal(s.draft.deliveryHoldMs, undefined, 'already at 0: no change, so no edit');
  s = press(initialSettings(view({ configured: { ...defaults, deliveryHoldMs: 60_000 } })), 'right');
  assert.equal(isDirty(s), false);
  s = press(initialSettings(view()), 'down', 'right');
  assert.equal(s.draft.batchHeld, false);
});

test('an edit back to the saved value is not "unsaved"', () => {
  const s = press(initialSettings(view()), 'right', 'left');
  assert.equal(isDirty(s), false);
  assert.doesNotMatch(text(s), /unsaved/);
});

test('reset asks to remove the saved key and shows the default', () => {
  const s = press(initialSettings(view({ configured: { ...defaults, deliveryHoldMs: 900 } })), 'reset');
  assert.equal(s.draft.deliveryHoldMs, null);
  assert.match(text(s), /Hold before delivery\s+‹ 500 ms ›\s+reset to default \(unsaved\)/);
});

test('status marks default, changed and unsaved values', () => {
  const t = text(initialSettings(view({ configured: { ...defaults, batchMaxHoldMs: 3000 }, effective: { ...defaults, batchMaxHoldMs: 3000 } })));
  assert.match(t, /Hold before delivery\s+‹ 500 ms ›\s+default/);
  assert.match(t, /Longest batch hold\s+3s\s+changed · default 2s/);
  assert.match(text(press(initialSettings(view()), 'right')), /‹ 600 ms ›\s+unsaved/);
});

test('an environment override is shown with the value actually in effect', () => {
  const s = initialSettings(view({ configured: { ...defaults, deliveryHoldMs: 800 }, effective: { ...defaults, deliveryHoldMs: 0 }, overridden: ['deliveryHoldMs'] }));
  const t = text(s);
  assert.match(t, /‹ 800 ms ›\s+in effect: off \(set by environment\)/);
  assert.match(t, /an environment variable wins until it is unset/);
});

test('a batch cap shorter than the hold is flagged before saving', () => {
  let s = initialSettings(view({ configured: { ...defaults, batchMaxHoldMs: 500 } }));
  assert.equal(draftProblem(s), null);
  s = press(s, 'right');
  assert.match(draftProblem(s) ?? '', /must be at least the hold/);
  assert.match(text(s), /must be at least the hold before delivery \(600 ms\)/);
});

test('every line fits the width, and the hints say discard only when there are edits', () => {
  const s = press(initialSettings(view()), 'right');
  for (const w of [30, 60, 100]) for (const l of settingsLines(s, w)) assert.ok(lineCols(l) <= w, `${w}: ${lineText(l)}`);
  assert.match(text(s), /Esc discard/);
  assert.match(text(initialSettings(view())), /Esc close/);
});

test('an overridden row still shows its unsaved edit or reset', () => {
  const s = initialSettings(view({ configured: { ...defaults, deliveryHoldMs: 800 }, effective: { ...defaults, deliveryHoldMs: 0 }, overridden: ['deliveryHoldMs'] }));
  assert.match(text(press(s, 'right')), /in effect: off \(set by environment\) · unsaved/);
  assert.match(text(press(s, 'reset')), /in effect: off \(set by environment\) · reset to default \(unsaved\)/);
});
test('with the hold off, batching and its cap say they have no effect', () => {
  const t = text(initialSettings(view({ configured: { ...defaults, deliveryHoldMs: 0 }, effective: { ...defaults, deliveryHoldMs: 0 } })));
  assert.match(t, /Batch held messages\s+on\s+default · no effect while the hold is off/);
  assert.match(t, /Longest batch hold\s+2s\s+default · no effect while the hold is off/);
  assert.doesNotMatch(text(initialSettings(view())), /no effect/);
});
test('a broken settings file is explained, with the fallback in use and the repair key', () => {
  const problem = { source: 'file' as const, code: 'invalid_json', message: 'Unexpected token } at 12', fallback: 'last_good' as const };
  const s = initialSettings({ ...view(), problem });
  const t = text(s);
  assert.match(t, /The settings file can't be used \(invalid_json\): Unexpected token \} at 12/);
  assert.match(t, /Delivering with the last good settings meanwhile; Enter saves a repaired file\./);
  assert.match(t, /Enter repair file · Esc close/);
  assert.match(text(initialSettings({ ...view(), problem: { ...problem, fallback: 'defaults' } })), /Delivering with the default settings/);
  for (const l of settingsLines(s, 40)) assert.ok(lineCols(l) <= 40, lineText(l));
  assert.match(text(initialSettings(view())), /Enter close · Esc close/);
});