import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink, mkdir, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { isValidParticipantName, type Harness } from '../../contracts/domain.js';
import { loadConfig } from '../config.js';
import { RoomError } from '../../contracts/errors.js';

export interface Binding { harness: Harness; session_id: string }
export type Registry = Record<string, Binding>;
export interface RegistryOptions { lockTimeoutMs?: number; lockPollMs?: number; expectedPrevious?: Binding }
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const code = (e: unknown) => (e as NodeJS.ErrnoException).code;
const equal = (a: Binding, b: Binding) => a.harness === b.harness && a.session_id === b.session_id;
function binding(v: unknown): Binding {
  if (!object(v) || Object.keys(v).sort().join(',') !== 'harness,session_id' ||
      (v.harness !== 'codex' && v.harness !== 'claude') || typeof v.session_id !== 'string' || !idPattern.test(v.session_id)) {
    throw new RoomError('bad_request', 'Invalid participant: use only harness (codex or claude) and a native session_id UUID.');
  }
  return { harness: v.harness, session_id: v.session_id.toLowerCase() };
}
export function parseRegistry(text: string): Registry {
  const doc = parse(text);
  if (Object.keys(doc).some(k => k !== 'participants')) throw new RoomError('invalid_state', 'Legacy or unknown registry tables; run explicit registry migration first.');
  if (doc.participants === undefined) return Object.create(null) as Registry;
  if (!object(doc.participants)) throw new RoomError('bad_request', 'participants must be a TOML table.');
  const result: Registry = Object.create(null) as Registry;
  for (const [name, value] of Object.entries(doc.participants)) {
    if (!isValidParticipantName(name)) throw new RoomError('bad_request', `Invalid or reserved participant name: ${name}`);
    const b = binding(value);
    if (Object.values(result).some(p => equal(p, b))) throw new RoomError('duplicate_binding', 'Duplicate native binding; use one participant name per session.');
    result[name] = b;
  }
  return result;
}
export async function readRegistry(root: string): Promise<Registry> {
  try { return parseRegistry(await readFile(path.join(root, 'session.toml'), 'utf8')); }
  catch (e) { if (code(e) === 'ENOENT') return Object.create(null) as Registry; throw e; }
}
async function locked<T>(root: string, options: RegistryOptions, operation: () => Promise<T>): Promise<T> {
  const config = loadConfig();
  const timeout = options.lockTimeoutMs ?? config.registryLockTimeoutMs;
  const poll = options.lockPollMs ?? config.registryLockPollMs;
  if (!Number.isFinite(timeout) || timeout < 0 || !Number.isFinite(poll) || poll <= 0) throw new RoomError('bad_request', 'Invalid registry lock timing configuration.');
  const dir = path.join(root, '.room'); await mkdir(dir, { recursive: true });
  const lock = path.join(dir, 'registry.lock'); const start = Date.now();
  let handle;
  for (;;) {
    try { handle = await open(lock, 'wx'); break; }
    catch (e) {
      if (code(e) !== 'EEXIST') throw e;
      if (Date.now() - start >= timeout) throw new RoomError('invalid_state', 'Registry is locked; retry, or verify the lock owner has exited before removing .room/registry.lock.');
      await new Promise(resolve => setTimeout(resolve, poll));
    }
  }
  const ownership = JSON.stringify({ pid: process.pid, nonce: randomUUID(), created: new Date().toISOString() });
  let result: T | undefined; let operationError: unknown; let cleanupError: unknown;
  try { await handle.writeFile(ownership); result = await operation(); } catch (error) { operationError = error; }
  try { await handle.close(); } catch (error) { cleanupError = error; }
  try {
    if (await readFile(lock, 'utf8') === ownership) await unlink(lock);
    else throw new RoomError('invalid_state', 'Registry lock ownership changed; inspect the lock before retrying.');
  } catch (error) { cleanupError ??= error; }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw new RoomError('invalid_state', 'Registry operation completed but lock cleanup failed; reread registry and inspect .room/registry.lock before retrying.');
  return result as T;
}
async function writeRegistry(root: string, registry: Registry): Promise<void> {
  const text = stringify({ participants: registry }); parseRegistry(text);
  const target = path.join(root, 'session.toml'); const temp = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx');
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await renameWithRetry(temp, target);
  }
  finally { await unlink(temp).catch(e => { if (code(e) !== 'ENOENT') throw e; }); }
}
export async function joinParticipant(root: string, name: string, input: Binding, options: RegistryOptions = {}): Promise<Registry> {
  const normalized = binding(input);
  parseRegistry(stringify({ participants: { [name]: normalized } }));
  return locked(root, options, async () => {
    const registry = await readRegistry(root); const previous = registry[name];
    if (previous && !equal(previous, normalized) && (!options.expectedPrevious || !equal(previous, binding(options.expectedPrevious)))) {
      throw new RoomError('rebind_conflict', 'Participant name already bound; confirm the previous binding explicitly before rejoining with a new session.');
    }
    if (!previous && options.expectedPrevious) throw new RoomError('rebind_conflict', 'Previous binding no longer exists; reread registry before rejoining.');
    registry[name] = normalized;
    await writeRegistry(root, registry); return registry;
  });
}
/** Explicit, backed-up migration; never interprets embedded send commands. */
export async function migrateLegacyRegistry(root: string, options: RegistryOptions = {}): Promise<Registry> {
  return locked(root, options, async () => {
    const file = path.join(root, 'session.toml'); const text = await readFile(file, 'utf8'); const doc = parse(text);
    if (doc.participants !== undefined) return parseRegistry(text);
    if (!object(doc.session) || !object(doc.codex) || doc.session.harness !== 'claude-code' || doc.codex.harness !== 'codex') {
      throw new RoomError('invalid_state', 'Unrecognized legacy registry; preserve it and migrate the verified identities manually.');
    }
    if (Object.keys(doc).some(k => !['session', 'current', 'protocol', 'send', 'notes', 'codex'].includes(k))) throw new RoomError('invalid_state', 'Unknown legacy tables; migrate manually to avoid losing information.');
    const registry = parseRegistry(stringify({ participants: {
      claude: { harness: 'claude', session_id: doc.session.session_id },
      astra: { harness: 'codex', session_id: doc.codex.thread_id },
    } }));
    await copyFile(file, path.join(root, '.room', `registry-backup-${randomUUID()}.toml`), constants.COPYFILE_EXCL);
    await writeRegistry(root, registry); return registry;
  });
}

/** Windows scanners/editors can hold a file briefly without share-delete. Never delete the target. */
export async function renameWithRetry(source: string, target: string, renameFile = rename): Promise<void> {
  const config = loadConfig(); const deadline = Date.now() + config.registryLockTimeoutMs;
  for (;;) {
    try { await renameFile(source, target); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code(error) ?? '') || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, config.registryLockPollMs));
    }
  }
}
