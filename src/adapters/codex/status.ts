// Read-only shared-daemon status. No thread starts/resumes/loads.
import type { LivenessProbe } from '../../contracts/adapter.js';
import { readCodexDaemon, type DaemonReadOptions, type DaemonLaunch } from './daemon-read.js';
export type StatusOptions = DaemonReadOptions;

const unknown = (): LivenessProbe => ({ liveness: 'unknown', activity: 'unknown' });
export function statusEvidence(value: unknown): LivenessProbe {
  if (!value || typeof value !== 'object') return unknown();
  const s = value as { type?: unknown; activeFlags?: unknown };
  if (s.type === 'idle') return { liveness: 'online', activity: 'idle' };
  if (s.type === 'active') {
    if (!Array.isArray(s.activeFlags) || s.activeFlags.some(f => typeof f !== 'string')) return unknown();
    if (s.activeFlags.includes('waitingOnApproval')) return { liveness: 'online', activity: 'waiting_permission' };
    // Unknown flags can introduce new waiting states; don't silently call those busy.
    if (s.activeFlags.length > 0) return { liveness: 'online', activity: 'unknown' };
    return { liveness: 'online', activity: 'busy' };
  }
  // notLoaded is local to this daemon: an independent TUI may still own the thread.
  return unknown();
}

export async function probeCodexStatus(options:StatusOptions, threadId:string, launch?:DaemonLaunch):Promise<LivenessProbe> {
  const result=await readCodexDaemon(options,{method:'thread/read',threadId},launch);
  if(!result.ok || !result.value || typeof result.value!=='object')return unknown();
  const thread=(result.value as {thread?:{id?:unknown;status?:unknown}}).thread;
  return thread?.id===threadId ? statusEvidence(thread.status) : unknown();
}
