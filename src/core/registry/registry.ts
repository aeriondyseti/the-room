import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink, mkdir, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { isValidParticipantName, type Harness } from '../../contracts/domain.js';
import { loadConfig } from '../config.js';

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
    throw new Error('Invalid participant: use only harness (codex or claude) and a native session_id UUID.');
  }
  return { harness: v.harness, session_id: v.session_id.toLowerCase() };
}
export function parseRegistry(text: string): Registry {
  const doc = parse(text);
  if (Object.keys(doc).some(k => k !== 'participants')) throw new Error('Legacy or unknown registry tables; run explicit registry migration first.');
  if (doc.participants === undefined) return Object.create(null) as Registry;
  if (!object(doc.participants)) throw new Error('participants must be a TOML table.');
  const result: Registry = Object.create(null) as Registry;
  for (const [name, value] of Object.entries(doc.participants)) {
    if (!isValidParticipantName(name)) throw new Error(`Invalid or reserved participant name: ${name}`);
    const b = binding(value);
    if (Object.values(result).some(p => equal(p, b))) throw new Error('Duplicate native binding; use one participant name per session.');
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
  if (!Number.isFinite(timeout) || timeout < 0 || !Number.isFinite(poll) || poll <= 0) throw new Error('Invalid registry lock timing configuration.');
  const dir = path.join(root, '.room'); await mkdir(dir, { recursive: true });
  const lock = path.join(dir, 'registry.lock'); const start = Date.now();
  let handle;
  for (;;) {
    try { handle = await open(lock, 'wx'); break; }
    catch (e) {
      if (code(e) !== 'EEXIST') throw e;
      if (Date.now() - start >= timeout) throw new Error('Registry is locked; retry, or verify the lock owner has exited before removing .room/registry.lock.');
      await new Promise(resolve => setTimeout(resolve, poll));
    }
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, created: new Date().toISOString() })); return await operation(); }
  finally { await handle.close(); await unlink(lock); }
}
async function writeRegistry(root: string, registry: Registry): Promise<void> {
  const text = stringify({ participants: registry }); parseRegistry(text);
  const target = path.join(root, 'session.toml'); const temp = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx');
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, target);
  }
  finally { await unlink(temp).catch(e => { if (code(e) !== 'ENOENT') throw e; }); }
}
export async function joinParticipant(root: string, name: string, input: Binding, options: RegistryOptions = {}): Promise<Registry> {
  const normalized = binding(input);
  parseRegistry(stringify({ participants: { [name]: normalized } }));
  return locked(root, options, async () => {
    const registry = await readRegistry(root); const previous = registry[name];
    if (previous && !equal(previous, normalized) && (!options.expectedPrevious || !equal(previous, binding(options.expectedPrevious)))) {
      throw new Error('Participant name already bound; confirm the previous binding explicitly before rejoining with a new session.');
    }
    if (!previous && options.expectedPrevious) throw new Error('Previous binding no longer exists; reread registry before rejoining.');
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
      throw new Error('Unrecognized legacy registry; preserve it and migrate the verified identities manually.');
    }
    if (Object.keys(doc).some(k => !['session', 'current', 'protocol', 'send', 'notes', 'codex'].includes(k))) throw new Error('Unknown legacy tables; migrate manually to avoid losing information.');
    const registry = parseRegistry(stringify({ participants: {
      claude: { harness: 'claude', session_id: doc.session.session_id },
      astra: { harness: 'codex', session_id: doc.codex.thread_id },
    } }));
    await copyFile(file, path.join(root, '.room', `registry-backup-${randomUUID()}.toml`), constants.COPYFILE_EXCL);
    await writeRegistry(root, registry); return registry;
  });
}
