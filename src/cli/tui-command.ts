// `room tui [--demo]`. Kept separate from main.ts so the CLI (2.3) and TUI (3.x) evolve independently.
import { loadConfig } from '../core/config.js';

export const TUI_USAGE = `room tui [--demo]

Open the room in this terminal pane: watch the conversation, delivery states, and participants.

Options:
  --demo   Show a sample room (no service needed) — useful for trying the interface`;

export async function runTuiCommand(argv: string[], err: (s: string) => void = console.error): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(TUI_USAGE);
    return 0;
  }
  const config = loadConfig();
  if (argv.includes('--demo')) {
    const [{ runTui }, { demoSource }] = await Promise.all([import('../tui/run.js'), import('../tui/demo.js')]);
    await runTui(demoSource(), config.humanDisplayName);
    return 0;
  }
  err('room tui: connecting to a live room needs the room service (ROADMAP 1.2). Try `room tui --demo` for now.');
  return 2;
}
