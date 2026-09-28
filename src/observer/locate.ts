// Locate a native session's transcript file (shared by the usage observer and the activity reader). Read-only.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const SAFE_ID = /^[A-Za-z0-9-]+$/;

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function sortedDesc(dir: string): Promise<string[]> {
  return (await safeReaddir(dir)).filter((d) => /^\d+$/.test(d)).sort((a, b) => b.localeCompare(a));
}

/** `<claudeProjectsDir>/<project>/<sessionId>.jsonl`, in any project directory. */
export async function claudeTranscriptPaths(claudeProjectsDir: string, sessionId: string): Promise<string[]> {
  if (!SAFE_ID.test(sessionId)) return [];
  const found: string[] = [];
  for (const dir of await safeReaddir(claudeProjectsDir)) {
    const path = join(claudeProjectsDir, dir, `${sessionId}.jsonl`);
    if (await isFile(path)) found.push(path);
  }
  return found;
}

/** `<codexSessionsDir>/YYYY/MM/DD/rollout-*-<threadId>.jsonl`, newest dates first; `cache` remembers hits. */
export async function codexRolloutPath(codexSessionsDir: string, threadId: string, cache?: Map<string, string>): Promise<string | null> {
  const cached = cache?.get(threadId);
  if (cached && (await isFile(cached))) return cached;
  if (!SAFE_ID.test(threadId)) return null;
  const suffix = `-${threadId}.jsonl`;
  for (const year of await sortedDesc(codexSessionsDir)) {
    for (const month of await sortedDesc(join(codexSessionsDir, year))) {
      for (const day of await sortedDesc(join(codexSessionsDir, year, month))) {
        const dir = join(codexSessionsDir, year, month, day);
        const hit = (await safeReaddir(dir)).find((f) => f.startsWith('rollout-') && f.endsWith(suffix));
        if (hit) {
          const path = join(dir, hit);
          cache?.set(threadId, path);
          return path;
        }
      }
    }
  }
  return null;
}
