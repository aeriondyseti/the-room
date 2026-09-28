#!/usr/bin/env node
// `room` entry point. Sprint 0.1 provides only --version/--help; commands arrive in 2.3 (CLI) and 3.x (TUI).
import { realpathSync } from 'node:fs';
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
  try {
    return pathToFileURL(realpathSync(argv1)).href === pathToFileURL(realpathSync(fileURLToPath(moduleUrl))).href;
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) process.exitCode = run(process.argv.slice(2));
