import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import type { RoomSource } from './source.js';

/** Render the TUI full-screen until the user quits (Ctrl+C). Resolves when the app exits. */
export async function runTui(source: RoomSource, humanName: string): Promise<void> {
  const instance = render(<App source={source} humanName={humanName} />, { exitOnCtrlC: true });
  await instance.waitUntilExit();
}
