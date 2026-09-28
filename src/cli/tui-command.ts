// `room tui [--demo]`. Kept separate from main.ts so the CLI (2.3) and TUI (3.x) evolve independently.
import { loadConfig } from '../core/config.js';
import { resolveRoomRoot } from '../core/registry/root.js';
import { toErrorInfo } from '../contracts/errors.js';

export const TUI_USAGE = `room tui [--demo]

Open this repository's room in the current terminal pane: watch the conversation and delivery
states, see who's connected, and message every agent at once (or @name one).

Options:
  --demo   Show a sample room (no service needed) — useful for trying the interface`;

export async function runTuiCommand(argv: string[], err: (s: string) => void = console.error): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(TUI_USAGE);
    return 0;
  }
  const config = loadConfig();
  const { runTui } = await import('../tui/run.js');
  if (argv.includes('--demo')) {
    const { demoSource } = await import('../tui/demo.js');
    await runTui(demoSource(), config.humanDisplayName);
    return 0;
  }
  let root: string;
  try {
    root = await resolveRoomRoot(process.cwd(), config.roomRoot ?? undefined);
  } catch (e) {
    const info = toErrorInfo(e);
    err(`room tui: ${info.message}${info.hint ? `\n  ${info.hint}` : ''}`);
    return 2;
  }
  const { ClientRoomSource } = await import('../tui/client-source.js');
  const source = new ClientRoomSource({ roomRoot: root });
  source.start();
  try {
    await runTui(source, config.humanDisplayName);
  } finally {
    source.close();
  }
  return 0;
}
