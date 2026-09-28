// Local TUI preferences (6.8): the viewer's layout choice, saved in the room's own runtime dir (`<room>/.room/tui.json`,
// git-ignored). Never harness config or state (invariant 8). Best effort: an unreadable or unwritable file only means the
// default layout next time; other keys in the file are preserved.
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

/** Save the layout (atomic replace, other keys kept). Resolves false when it couldn't be saved. */
export async function saveLayout(path: string, layout: TuiLayout): Promise<boolean> {
  try {
    const next = { ...(await readRaw(path)), layout };
    await mkdir(join(path, '..'), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
    await rename(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** Effective starting layout: --layout flag, else the saved choice, else ROOM_TUI_LAYOUT, else top. */
export function startingLayout(flag: string | null, saved: TuiLayout | null, configured: string): TuiLayout {
  if (flag !== null) return flag as TuiLayout;
  return saved ?? (isTuiLayout(configured) ? configured : 'top');
}
