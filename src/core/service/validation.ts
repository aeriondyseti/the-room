import { RoomError } from '../../contracts/errors.js';
import { HUMAN, isHarness, type Sender } from '../../contracts/domain.js';
import type { Caller, ClientKind, NativeEvidence } from '../../contracts/ipc.js';
import type { Registry } from '../registry/registry.js';
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RoomError('bad_request','Expected an object.');
  return value as Record<string,unknown>;
}
export function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new RoomError('bad_request',`${label} must be a nonempty string.`);
  return value;
}
export function optionalText(value: unknown, label: string): string | null { return value === undefined || value === null ? null : text(value,label); }
export function integer(value: unknown, label: string, fallback: number, min = 0): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new RoomError('bad_request',`${label} must be an integer >= ${min}.`);
  return value as number;
}
export function nativeEvidence(value: unknown): NativeEvidence {
  const obj = record(value);
  if (!isHarness(obj.harness) || typeof obj.sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(obj.sessionId)) throw new RoomError('bad_request','Native identity needs a supported harness and session UUID.');
  const sources = obj.harness === 'codex' ? ['codex-env','codex-mcp-meta'] : ['claude-ancestry','claude-mcp-registry'];
  if (!sources.includes(String(obj.source))) throw new RoomError('bad_request','Identity source does not match the harness.');
  return { harness:obj.harness,sessionId:obj.sessionId.toLowerCase(),source:obj.source as NativeEvidence['source'] };
}
export function requireHuman(caller: unknown, client: ClientKind): void {
  if (record(caller).kind !== 'human' || client === 'mcp') throw new RoomError('identity_mismatch','This command requires the human CLI or TUI.');
}
export function resolveCaller(value: unknown, client: ClientKind, registry: Registry): { sender: Sender; scope: string } {
  const caller = record(value);
  if (caller.kind === 'human') { requireHuman(caller,client);return {sender:{name:HUMAN,kind:'human',identity:{mode:'human',source:'tui'}},scope:HUMAN}; }
  if (caller.kind !== 'agent') throw new RoomError('bad_request','Caller kind must be human or agent.');
  const declared = optionalText(caller.declaredName,'declaredName');
  const native = caller.native === null || caller.native === undefined ? null : nativeEvidence(caller.native);
  if (!native && client === 'mcp') throw new RoomError('identity_unresolved','MCP requires native identity on every call.');
  const entries = Object.entries(registry);
  const match = native ? entries.find(([,binding])=>binding.harness===native.harness && binding.session_id===native.sessionId) : declared && Object.hasOwn(registry,declared) ? [declared,registry[declared]!] as const : undefined;
  if (!match) throw new RoomError('not_registered','The calling session is not registered.');
  if (declared && declared!==match[0]) throw new RoomError('identity_mismatch','Declared name does not match the calling session.');
  return {sender:{name:match[0],kind:'agent',identity:{mode:native?'verified':'declared',source:native?.source??'declared'}},scope:`${match[1].harness}:${match[1].session_id}`};
}
