import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveRoomRoot, roomGitEnvironment } from './root.js';

test('discovery strips repository-local Git variables without mutating parent environment', () => {
  const env = { PATH: 'path', GIT_CONFIG_GLOBAL: 'global', GIT_CONFIG_SYSTEM: 'system', GIT_DIR: 'foreign',
    git_work_tree: 'foreign', GIT_COMMON_DIR: 'foreign', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true' };
  assert.deepEqual(roomGitEnvironment(env), { PATH: 'path', GIT_CONFIG_GLOBAL: 'global', GIT_CONFIG_SYSTEM: 'system' });
  assert.equal(env.GIT_DIR, 'foreign');
});

test('real Git discovery ignores inherited foreign repo/config and still shares linked worktrees', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'room git env '));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = path.join(base, 'selected'), foreign = path.join(base, 'foreign'), linked = path.join(base, 'linked tree');
  const env = roomGitEnvironment(process.env);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env, windowsHide: true, stdio: 'pipe' });
  for (const dir of [repo, foreign]) { await mkdir(dir); git(dir, 'init'); }
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture');
  git(repo, 'worktree', 'add', '-b', 'linked', linked);
  const polluted: NodeJS.ProcessEnv = { ...env, GIT_DIR: path.join(foreign, '.git'), GIT_COMMON_DIR: path.join(foreign, '.git'),
    GIT_WORK_TREE: foreign, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true' };
  delete polluted.ROOM_ROOT;
  const script = `import {resolveRoomRoot} from ${JSON.stringify(new URL('./root.js', import.meta.url).href)}; console.log(await resolveRoomRoot(process.argv[1]));`;
  for (const dir of [repo, linked]) {
    const actual = execFileSync(process.execPath, ['--input-type=module', '-e', script, dir], { env: polluted, windowsHide: true, encoding: 'utf8' }).trim();
    assert.equal(actual, await realpath(repo));
  }
  const bare = path.join(base, 'bare'); await mkdir(bare); git(bare, 'init', '--bare');
  await assert.rejects(resolveRoomRoot(bare), { code: 'bad_request' });
  assert.equal(await resolveRoomRoot(bare, repo), await realpath(repo));
});
