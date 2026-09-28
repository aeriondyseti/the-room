import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveRoomRoot, roomGitEnvironment } from './root.js';
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
  for (const name of ['all', 'human', 'system']) {
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
  assert.deepEqual(parseRegistry(await readFile(path.join(root, 'session.toml'), 'utf8')), result);
  assert.equal(Object.keys(result).length, 2);
  const backups = await readdir(path.join(root, '.room'));
  const backup = backups.find(n => n.startsWith('registry-backup-')); assert.ok(backup);
  assert.equal(await readFile(path.join(root, '.room', backup), 'utf8'), legacy);
  assert.deepEqual(await migrateLegacyRegistry(root), result);
});
test('main checkout and linked worktree resolve to the same root', async t => {
  const base = await fixture(t); const repo = path.join(base, 'repo'); const linked = path.join(base, 'linked');
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, env: roomGitEnvironment(process.env) });
  git('init'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture');
  git('worktree', 'add', '-b', 'linked', linked);
  assert.equal(await resolveRoomRoot(repo), await resolveRoomRoot(linked));
  assert.equal(await resolveRoomRoot(base, repo), await resolveRoomRoot(repo));
  await assert.rejects(resolveRoomRoot(base, ''), /empty/);
});

test('unsupported tables are refused without changing the original registry', async t => {
  const root = await fixture(t);
  const content = '[custom]\nvalue="preserve me"\n';
  await writeFile(path.join(root, 'session.toml'), content);
  await assert.rejects(joinParticipant(root, 'astra', one), /unknown registry tables/);
  assert.equal(await readFile(path.join(root, 'session.toml'), 'utf8'), content);
});
test('two independent processes serialize registry writes', async t => {
  const root = await fixture(t);
  const { spawn } = await import('node:child_process');
  const moduleUrl = new URL('./registry.js', import.meta.url).href;
  const run = (name: string, binding: typeof one | typeof two) => new Promise<void>((resolve, reject) => {
    const script = `import {joinParticipant} from ${JSON.stringify(moduleUrl)}; await joinParticipant(process.argv[1], process.argv[2], JSON.parse(process.argv[3]));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, name, JSON.stringify(binding)], { windowsHide: true });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  await Promise.all([run('astra', one), run('claude', two)]);
  assert.equal(Object.keys(await readRegistry(root)).length, 2);
});

test('rename retries only transient sharing errors without deleting original', async t => {
  const root = await fixture(t); const source = path.join(root, 'temp');const target = path.join(root,'session.toml');
  await writeFile(source,'new');await writeFile(target,'old');
  const {renameWithRetry} = await import('./registry.js');const {rename} = await import('node:fs/promises');
  let attempts = 0;
  await renameWithRetry(source,target,async(a,b)=>{if(++attempts===1){assert.equal(await readFile(target,'utf8'),'old');throw Object.assign(new Error('sharing'),{code:'EBUSY'});}await rename(a,b);});
  assert.equal(attempts,2);assert.equal(await readFile(target,'utf8'),'new');
});
test('registry errors expose recovery codes and reject a file as room root', async t => {
  const root=await fixture(t);await joinParticipant(root,'astra',one);
  await assert.rejects(joinParticipant(root,'astra',two),{code:'rebind_conflict'});
  await assert.rejects(joinParticipant(root,'second',one),{code:'duplicate_binding'});
  await assert.rejects(joinParticipant(root,'missing',two,{expectedPrevious:one}),{code:'rebind_conflict'});
  await assert.rejects(resolveRoomRoot(root,path.join(root,'session.toml')),{code:'bad_request'});
});
