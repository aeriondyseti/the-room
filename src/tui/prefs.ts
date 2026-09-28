// Local TUI preferences (6.8): the viewer's layout choice, saved in the room's own runtime dir (`<room>/.room/tui.json`,
// git-ignored). Never harness config or state (invariant 8). Best effort: an unreadable or unwritable file only means the
// default layout next time; other keys in the file are preserved.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isTuiLayout, type TuiLayout } from './sidepanel.js';

export function tuiPrefsPath(roomRoot: string): string {
  return join(roomRoot, '.room', 'tui.json');
}

async function readRaw(path: string): Promise<Record<string, unknown>> {
  try {
    const v = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function readSavedLayout(path: string): Promise<TuiLayout | null> {
  const layout = (await readRaw(path)).layout;
  return isTuiLayout(layout) ? layout : null;
}

/** Top bar density (6.10): the full organised grid, or one compact line per section. */
export type TopBarMode = 'full' | 'compact';
export const isTopBarMode = (v: unknown): v is TopBarMode => v === 'full' || v === 'compact';

export async function readSavedTopBar(path: string): Promise<TopBarMode | null> {
  const mode = (await readRaw(path)).topBar;
  return isTopBarMode(mode) ? mode : null;
}

// Saves run one at a time, in request order, so a quick toggle can never persist an older choice over a newer one.
let queue: Promise<unknown> = Promise.resolve();

/** Save the layout (atomic replace, other keys kept). Resolves false when it couldn't be saved. */
export function saveLayout(path: string, layout: TuiLayout): Promise<boolean> {
  return savePrefs(path, { layout });
}

/** Save the top bar density (same file, same guarantees). */
export function saveTopBar(path: string, topBar: TopBarMode): Promise<boolean> {
  return savePrefs(path, { topBar });
}

function savePrefs(path: string, patch: Record<string, unknown>): Promise<boolean> {
  const run = queue.then(() => writePrefs(path, patch));
  queue = run;
  return run;
}

async function writePrefs(path: string, patch: Record<string, unknown>): Promise<boolean> {
  try {
    const next = { ...(await readRaw(path)), ...patch };
    await mkdir(join(path, '..'), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
    await rename(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** Effective starting layout: --layout flag, else the saved choice, else ROOM_TUI_LAYOUT, else top. */
export function startingLayout(flag: TuiLayout | null, saved: TuiLayout | null, configured: TuiLayout): TuiLayout {
  return flag ?? saved ?? configured;
}
