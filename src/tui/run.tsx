import React from 'react';
import { render } from 'ink';
import { App, type AppProps } from './app.js';
import type { RoomSource } from './source.js';

/** Render the TUI full-screen until the user quits (Ctrl+C). Resolves when the app exits. */
export async function runTui(source: RoomSource, humanName: string, options: Omit<AppProps, 'source' | 'humanName'> = {}): Promise<void> {
  const instance = render(<App source={source} humanName={humanName} {...options} />, { exitOnCtrlC: true });
  await instance.waitUntilExit();
}
