// Render the TUI against the demo room at a few terminal sizes (for UX passes and before/after notes).
// Usage: npm run build && node scripts/preview-tui.mjs [WxH ...] [--keys "a|b|ENTER"] [--mono] [--empty | --quiet]
//   --mono   monochrome theme (as NO_COLOR / --no-color)
//   --empty  first run: no agents, no messages · --quiet: agents joined, no messages yet
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../dist/tui/app.js';
import { demoSource } from '../dist/tui/demo.js';
import { FakeRoomSource } from '../dist/tui/fake-source.js';
import { MONO_THEME, COLOR_THEME } from '../dist/tui/theme.js';

const args = process.argv.slice(2);
const ki = args.indexOf('--keys');
const keys = ki >= 0 ? args.splice(ki, 2)[1] : '';
const take = (f) => { const i = args.indexOf(f); if (i >= 0) args.splice(i, 1); return i >= 0; };
const theme = take('--mono') ? MONO_THEME : COLOR_THEME;
const empty = take('--empty');
const quiet = take('--quiet');
const demoParticipants = (await demoSource().request('who', {})).participants;
const makeSource = () => {
  if (empty) return new FakeRoomSource({ roomLabel: 'new', participants: [] });
  if (quiet) return new FakeRoomSource({ roomLabel: 'quiet', participants: demoParticipants });
  return demoSource();
};
const sizes = (args.length ? args : ['110x26', '72x20']).map((s) => s.split('x').map(Number));
for (const [w, h] of sizes) {
  const inst = render(React.createElement(App, { source: makeSource(), humanName: 'Kevin', width: w, height: h, theme }));
  void empty; void quiet;
  await new Promise((r) => setTimeout(r, 150));
  for (const k of keys.split('|').filter(Boolean)) { inst.stdin.write(k === 'ENTER' ? '\r' : k === 'ESC' ? '\u001b' : k); await new Promise((r) => setTimeout(r, 60)); }
  await new Promise((r) => setTimeout(r, 100));
  console.log(`===== ${w}x${h}${keys ? ` keys=${keys}` : ''} =====`);
  console.log(inst.lastFrame());
  inst.unmount();
}
process.exit(0);
