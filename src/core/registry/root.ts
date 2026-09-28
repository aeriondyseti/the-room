import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);

/** Worktrees resolve to the checkout owning the common git directory. */
export async function resolveRoomRoot(cwd = process.cwd(), override = process.env.ROOM_ROOT): Promise<string> {
  if (override !== undefined) {
    if (!override.trim()) throw new Error('ROOM_ROOT is empty; specify an existing room directory.');
    const root = await realpath(path.resolve(cwd, override));
    if (!(await stat(root)).isDirectory()) throw new Error('ROOM_ROOT must be a directory.');
    return root;
  }
  const git = async (...args: string[]) => (await exec('git', ['-C', cwd, 'rev-parse', ...args], { windowsHide: true })).stdout.trim();
  if (await git('--is-bare-repository') === 'true') throw new Error('Bare repository has no room checkout; set ROOM_ROOT explicitly.');
  const common = await realpath(await git('--path-format=absolute', '--git-common-dir'));
  if (path.basename(common).toLowerCase() !== '.git') {
    throw new Error('Nonstandard common git directory; set ROOM_ROOT to the shared checkout explicitly.');
  }
  return realpath(path.dirname(common));
}
