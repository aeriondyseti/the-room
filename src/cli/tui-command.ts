// `roundtable tui [--demo] [--no-color]`. Kept separate from main.ts so the CLI (2.3) and TUI (3.x) evolve independently.
import { backoffSchedule, loadConfig } from '../core/config.js';
import { adoptLegacyStateDir, resolveRoomRoot } from '../core/registry/root.js';
import { toErrorInfo } from '../contracts/errors.js';

export const TUI_USAGE = `roundtable tui [--demo] [--no-color] [--layout top|left]

Open this repository's room in the current terminal pane: watch the conversation and delivery
states, see who's connected, and message every agent at once (or @name one).

Options:
  --demo       Show a sample room (no service needed) — useful for trying the interface
  --no-color   Monochrome display (also: NO_COLOR=1, or TERM=dumb)
  --layout     top (top bar) or left (side panel). Inside the TUI, /layout or Ctrl+B switches, and
               the choice is remembered for this room (.roundtable/tui.json). Default: ROUNDTABLE_TUI_LAYOUT, else top.`;

/** The value of `--layout <v>` / `--layout=<v>`; undefined when absent, null when given without a value. */
export function layoutFlag(argv: readonly string[]): string | null | undefined {
  const i = argv.findIndex((a) => a === '--layout' || a.startsWith('--layout='));
  if (i < 0) return undefined;
  const a = argv[i]!;
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : (argv[i + 1] ?? null);
}

export async function runTuiCommand(argv: string[], err: (s: string) => void = console.error): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(TUI_USAGE);
    return 0;
  }
  const config = loadConfig();
  const { runTui } = await import('../tui/run.js');
  const { themeFrom } = await import('../tui/theme.js');
  const { isTuiLayout } = await import('../tui/sidepanel.js');
  const { readSavedLayout, readSavedTopBar, saveLayout, saveTopBar, startingLayout, tuiPrefsPath } = await import('../tui/prefs.js');
  // Invalid layout settings fail loudly (never silently ignored).
  const flag = layoutFlag(argv);
  if (flag !== undefined && !isTuiLayout(flag)) {
    err(`roundtable tui: --layout must be "top" or "left"${flag ? `, got "${flag}"` : ''}`);
    return 2;
  }
  if (!isTuiLayout(config.tuiLayout)) {
    err(`roundtable tui: ROUNDTABLE_TUI_LAYOUT must be "top" or "left", got "${config.tuiLayout}"`);
    return 2;
  }
  const display = {
    theme: themeFrom(process.env, argv),
    historyLimit: config.tuiHistoryLimit,
    catchUpMaxPages: config.tuiCatchUpMaxPages,
    panelWidth: config.tuiPanelWidth,
    panelBreakpoint: config.tuiPanelBreakpoint,
    composerMaxRows: config.tuiComposerMaxRows,
  };
  if (argv.includes('--demo')) {
    const { demoSource } = await import('../tui/demo.js');
    // The demo never writes preferences.
    await runTui(demoSource(), config.humanDisplayName, { ...display, layout: startingLayout(flag ?? null, null, config.tuiLayout) });
    return 0;
  }
  let root: string;
  try {
    root = await resolveRoomRoot(process.cwd(), config.roomRoot ?? undefined);
    await adoptLegacyStateDir(root);
  } catch (e) {
    const info = toErrorInfo(e);
    err(`roundtable tui: ${info.message}${info.hint ? `\n  ${info.hint}` : ''}`);
    return 2;
  }
  const { ClientRoomSource } = await import('../tui/client-source.js');
  const source = new ClientRoomSource({
    roomRoot: root,
    backoffMs: backoffSchedule(config.tuiReconnectMinMs, config.tuiReconnectMaxMs),
    failuresBeforeDisconnected: config.tuiFailuresBeforeDisconnected,
  });
  source.start();
  const prefs = tuiPrefsPath(root);
  const layout = startingLayout(flag ?? null, await readSavedLayout(prefs), config.tuiLayout);
  try {
    const topBar = (await readSavedTopBar(prefs)) ?? 'full';
    await runTui(source, config.humanDisplayName, { ...display, layout, onLayoutChange: (next) => saveLayout(prefs, next), topBar, onTopBarChange: (next) => saveTopBar(prefs, next) });
  } finally {
    source.close();
  }
  return 0;
}
