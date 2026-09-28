// Integration: the TUI against the real room service (1.2) — auto-start, send from the composer, see it arrive.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { RoomClient } from '../ipc/client.js';
import { App } from './app.js';
import { ClientRoomSource } from './client-source.js';
import { waitFor } from './test-utils.js';

const plain = (s: string | undefined) => (s ?? '').replace(/\u001B\[[0-9;]*m/g, '');
const root = mkdtempSync(join(tmpdir(), 'vp-tui-real-'));
execFileSync('git', ['init', '-q', root]);
const source = new ClientRoomSource({ roomRoot: root });

after(async () => {
  cleanup();
  source.close();
  try {
    const admin = await RoomClient.connect(root, { client: 'cli', autoStart: false });
    await admin.request('shutdown', { caller: { kind: 'human' } }).catch(() => {});
    admin.close();
  } catch {
    // service already gone
  }
  await new Promise((r) => setTimeout(r, 300));
  rmSync(root, { recursive: true, force: true });
});

test('room tui: auto-starts the service, sends from the composer, and shows the message from the event stream', { timeout: 30_000 }, async () => {
  // Register one agent so a broadcast has a recipient (join from a CLI connection with synthetic native evidence).
  source.start();
  const ui = render(<App source={source} humanName="Kevin" width={100} height={20} />);
  await waitFor(() => plain(ui.lastFrame()), /● connected/, 15_000);
  const cli = await RoomClient.connect(root, { client: 'cli', autoStart: false });
  await cli.request('join', { name: 'astra', native: { harness: 'codex', sessionId: '01a0e605-0000-7000-8000-000000000001', source: 'codex-env' } });
  cli.close();

  ui.stdin.write('hello from the real room');
  await new Promise((r) => setTimeout(r, 50));
  ui.stdin.write('\r');
  const frame = await waitFor(() => plain(ui.lastFrame()), /Kevin → everyone[\s\S]*hello from the real room/, 10_000);
  assert.match(frame, /astra/, 'the delivery row names the enrolled agent');
});
