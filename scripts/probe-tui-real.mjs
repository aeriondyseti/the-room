// Diagnostic: render the TUI headlessly against a real room (read-only: never sends) and print the sidebar state
// plus participant events over a short window. Usage: node scripts/probe-tui-real.mjs <room root> [seconds] [distDir]
import React from 'react';
import { render } from 'ink-testing-library';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const seconds = Number(process.argv[3] ?? 12);
const dist = resolve(process.argv[4] ?? 'dist');
const { App } = await import(pathToFileURL(`${dist}/tui/app.js`).href);
const { ClientRoomSource } = await import(pathToFileURL(`${dist}/tui/client-source.js`).href);
const source = new ClientRoomSource({ roomRoot: root });
source.onEvent((e) => { if (e.type === 'participant.updated') console.log('event participant.updated', e.participant.name, e.participant.liveness, e.participant.activity); });
source.start();
const ui = render(React.createElement(App, { source, humanName: 'Kevin', width: 110, height: 20 }));
await new Promise((r) => setTimeout(r, seconds * 1000));
console.log((ui.lastFrame() ?? '').replace(/\u001B\[[0-9;]*m/g, '').split('\n').slice(0, 10).join('\n'));
ui.unmount();
source.close();
process.exit(0);
