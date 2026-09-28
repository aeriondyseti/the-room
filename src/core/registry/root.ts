import { RoomError } from '../../contracts/errors.js';
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// Git hooks and parent tools can export repository-local variables that override `git -C`.
// Keep user/global configuration and PATH, but bind discovery to this caller's cwd instead.
// List qualified with `git rev-parse --local-env-vars`; numbered config entries accompany COUNT.
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
export async function resolveRoomRoot(cwd = process.cwd(), override = process.env.ROOM_ROOT): Promise<string> {
  if (override !== undefined) {
    if (!override.trim()) throw new RoomError('bad_request', 'ROOM_ROOT is empty; specify an existing room directory.');
    const root = await realpath(path.resolve(cwd, override));
    if (!(await stat(root)).isDirectory()) throw new RoomError('bad_request', 'ROOM_ROOT must be a directory.');
    return root;
  }
  const env = roomGitEnvironment(process.env);
  const git = async (...args: string[]) => (await exec('git', ['-C', cwd, 'rev-parse', ...args], { windowsHide: true, env })).stdout.trim();
  if (await git('--is-bare-repository') === 'true') throw new RoomError('bad_request', 'Bare repository has no room checkout; set ROOM_ROOT explicitly.');
  const common = await realpath(await git('--path-format=absolute', '--git-common-dir'));
  if (path.basename(common).toLowerCase() !== '.git') {
    throw new RoomError('bad_request', 'Nonstandard common git directory; set ROOM_ROOT to the shared checkout explicitly.');
  }
  return realpath(path.dirname(common));
}
