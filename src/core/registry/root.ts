import { RoomError } from '../../contracts/errors.js';
import { execFile } from 'node:child_process';
import { realpath, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// Git hooks and parent tools can export repository-local variables that override `git -C`.
// Keep user/global configuration and PATH, but bind discovery to this caller's cwd instead.
// List qualified with Git 2.53.0.windows.1 `rev-parse --local-env-vars`; numbered entries accompany COUNT.
// Keep GIT_CEILING_DIRECTORIES / GIT_DISCOVERY_ACROSS_FILESYSTEM: these are user discovery policy.
const localGitVariables = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX',
  'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR',
]);
export function roomGitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => {
    const name = key.toUpperCase();
    return !localGitVariables.has(name) && !/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name);
  }));
}

/** Worktrees resolve to the checkout owning the common git directory. */
export async function resolveRoomRoot(cwd = process.cwd(), override = process.env.ROUNDTABLE_ROOT): Promise<string> {
  if (override !== undefined) {
    if (!override.trim()) throw new RoomError('bad_request', 'ROUNDTABLE_ROOT is empty; specify an existing room directory.');
    const root = await realpath(path.resolve(cwd, override));
    if (!(await stat(root)).isDirectory()) throw new RoomError('bad_request', 'ROUNDTABLE_ROOT must be a directory.');
    return root;
  }
  const env = roomGitEnvironment(process.env);
  const git = async (...args: string[]) => (await exec('git', ['-C', cwd, 'rev-parse', ...args], { windowsHide: true, env })).stdout.trim();
  if (await git('--is-bare-repository') === 'true') throw new RoomError('bad_request', 'Bare repository has no room checkout; set ROUNDTABLE_ROOT explicitly.');
  const common = await realpath(await git('--path-format=absolute', '--git-common-dir'));
  if (path.basename(common).toLowerCase() !== '.git') {
    throw new RoomError('bad_request', 'Nonstandard common git directory; set ROUNDTABLE_ROOT to the shared checkout explicitly.');
  }
  return realpath(path.dirname(common));
}

/**
 * The state directory was `.room/` before the project became agent-roundtable. Move it to `.roundtable/` once, before
 * anything creates the new directory, so an existing room keeps its ledger, settings and preferences. A directory that
 * a service started before the rename still holds open cannot be moved on Windows; that is reported, never worked around,
 * because creating a second, empty state directory would orphan the room's history. When both directories exist and the
 * old one holds a ledger, that is reported too: the choice of which to keep is the human's.
 */
export async function adoptLegacyStateDir(root: string): Promise<'adopted' | 'none'> {
  const legacy = path.join(root, '.room'), current = path.join(root, '.roundtable');
  const exists = async (target: string): Promise<boolean> => {
    try { await stat(target); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
  };
  const isDirectory = async (target: string): Promise<boolean> => {
    try { return (await stat(target)).isDirectory(); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
  };
  if (!(await isDirectory(legacy))) return 'none';
  if (await isDirectory(current)) {
    // Both exist. Never move over state, and never carry on as if the earlier history were not there.
    if (!(await exists(path.join(legacy, 'room.db')))) return 'none';
    throw new RoomError('invalid_state', 'Both .room/ (earlier history) and .roundtable/ exist in this room, so the earlier history is not in use. Run `roundtable shutdown`, then keep one: delete .roundtable/ to adopt the earlier history on the next command, or delete .room/ to discard it.');
  }
  try { await rename(legacy, current); }
  catch (e) {
    if (await isDirectory(current) && !(await isDirectory(legacy))) return 'adopted'; // another process moved it first
    throw new RoomError('invalid_state', `Found earlier state in .room/ but could not move it to .roundtable/ (${(e as NodeJS.ErrnoException).code ?? 'unknown error'}). A service started before the rename is probably still running: run \`roundtable shutdown\`, then retry.`);
  }
  return 'adopted';
}

/** True while earlier state waits in `.room/`: not yet moved, or left beside a `.roundtable/` with its ledger. Reads only. */
export async function legacyStatePending(root: string): Promise<boolean> {
  const present = async (target: string): Promise<boolean> => {
    try { await stat(target); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
  };
  if (!(await present(path.join(root, '.room')))) return false;
  return !(await present(path.join(root, '.roundtable'))) || await present(path.join(root, '.room', 'room.db'));
}
