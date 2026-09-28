#!/usr/bin/env node
// `room` entry point. Sprint 0.1 provides only --version/--help; commands arrive in 2.3 (CLI) and 3.x (TUI).
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VERSION } from '../version.js';

const USAGE = `room ${VERSION} — local chat room for coding agents

Usage: room <command> [options]

Commands (coming in later sprints): tui, send, read, who, join, doctor, pause, resume, shutdown

Options:
  --version   Print the version
  --help      Show this help`;

export function run(argv: string[], out: (s: string) => void = console.log, err: (s: string) => void = console.error): number {
  const [first] = argv;
  if (first === '--version' || first === '-v') {
    out(VERSION);
    return 0;
  }
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    out(USAGE);
    return 0;
  }
  err(`room: unknown or not-yet-implemented command "${first}". Run \`room --help\`.`);
  return 2;
}

/** True when this module is the process entry point (not when imported by tests). */
export function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) return false;
  return canonical(argv1) === canonical(fileURLToPath(moduleUrl));
}

/** Resolve symlinks when possible; fall back to the absolute path rather than silently failing. */
function canonical(path: string): string {
  let resolved = resolve(path);
  try {
    resolved = realpathSync(resolved);
  } catch {
    // e.g. the file was replaced after launch: compare the unresolved absolute paths instead.
  }
  const href = pathToFileURL(resolved).href;
  return process.platform === 'win32' ? href.toLowerCase() : href;
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'tui') {
    const { runTuiCommand } = await import('./tui-command.js');
    process.exitCode = await runTuiCommand(argv.slice(1));
  } else {
    process.exitCode = run(argv);
  }
}
