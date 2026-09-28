import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveRoomRoot } from './root.js';
import { joinParticipant, readRegistry, parseRegistry, migrateLegacyRegistry } from './registry.js';
const one = { harness: 'codex', session_id: '00000000-0000-4000-8000-000000000001' } as const;
const two = { harness: 'claude', session_id: '00000000-0000-4000-8000-000000000002' } as const;
async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'room-registry-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
test('concurrent joins preserve participants; repeated join is idempotent', async t => {
  const root = await fixture(t);
  await Promise.all([joinParticipant(root, 'astra', one), joinParticipant(root, 'claude', two)]);
  await joinParticipant(root, 'astra', one);
  const registry = await readRegistry(root);
  assert.deepEqual(registry.astra, one); assert.deepEqual(registry.claude, two);
  assert.equal(Object.keys(registry).length, 2);
});
test('duplicate bindings, name collisions and stale compare-and-swap do not mutate file', async t => {
  const root = await fixture(t); await joinParticipant(root, 'astra', one);
  const before = await readFile(path.join(root, 'session.toml'), 'utf8');
  await assert.rejects(joinParticipant(root, 'other', one), /Duplicate/);
  await assert.rejects(joinParticipant(root, 'astra', two), /already bound/);
  assert.equal(await readFile(path.join(root, 'session.toml'), 'utf8'), before);
  await joinParticipant(root, 'astra', two, { expectedPrevious: one });
  await assert.rejects(joinParticipant(root, 'astra', one, { expectedPrevious: one }), /already bound/);
});
test('strict minimal schema rejects extra fields, duplicate TOML tables and reserved names', () => {
  assert.throws(() => parseRegistry('[participants.astra]\nharness="codex"\nsession_id="bad"'), /Invalid/);
  assert.throws(() => parseRegistry('[participants.astra]\n[participants.astra]'));
  for (const name of ['all', 'kevin', 'constructor']) {
    assert.throws(() => parseRegistry(`[participants.${name}]\nharness="codex"\nsession_id="${one.session_id}"`), /reserved/);
  }
  assert.throws(() => parseRegistry(`[participants.astra]\nharness="codex"\nsession_id="${one.session_id}"\npid=5`), /Invalid/);
});
test('lock contention fails boundedly without deleting the owner lock', async t => {
  const root = await fixture(t); await mkdir(path.join(root, '.room'));
  const lock = path.join(root, '.room/registry.lock'); await writeFile(lock, 'other owner');
  await assert.rejects(joinParticipant(root, 'astra', one, { lockTimeoutMs: 10, lockPollMs: 2 }), /locked/);
  assert.equal(await readFile(lock, 'utf8'), 'other owner');
});
test('legacy migration preserves both native identities and makes an exact backup', async t => {
  const root = await fixture(t);
  const legacy = `[session]\nharness="claude-code"\nsession_id="${two.session_id}"\n[send]\ncommand='''\nnever execute me\n'''\n[codex]\nharness="codex"\nthread_id="${one.session_id}"\n`;
  await writeFile(path.join(root, 'session.toml'), legacy);
  const result = await migrateLegacyRegistry(root);
  assert.deepEqual(result.astra, one); assert.deepEqual(result.claude, two);
  assert.equal(Object.keys(result).length, 2);
  const backups = await readdir(path.join(root, '.room'));
  const backup = backups.find(n => n.startsWith('registry-backup-')); assert.ok(backup);
  assert.equal(await readFile(path.join(root, '.room', backup), 'utf8'), legacy);
  assert.deepEqual(await migrateLegacyRegistry(root), result);
});
test('main checkout and linked worktree resolve to the same root', async t => {
  const base = await fixture(t); const repo = path.join(base, 'repo'); const linked = path.join(base, 'linked');
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  git('init'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture');
  git('worktree', 'add', '-b', 'linked', linked);
  assert.equal(await resolveRoomRoot(repo), await resolveRoomRoot(linked));
  assert.equal(await resolveRoomRoot(base, repo), await resolveRoomRoot(repo));
  await assert.rejects(resolveRoomRoot(base, ''), /empty/);
});
