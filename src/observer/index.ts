export { UsageObserver, type UsageCursor, type UsageObserverOptions } from './observer.js';
export { parseClaudeRecord, parseCodexRecord, type TokenCounters, type UsageSample } from './parsers.js';
export { readNew, type TailCursor, type TailRead } from './jsonl-tail.js';

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RoomConfig } from '../core/config.js';
import type { UsageObserverOptions } from './observer.js';

/** Observer options from room config + standard harness env vars. */
export function usageObserverOptionsFrom(config: RoomConfig, env: NodeJS.ProcessEnv = process.env): UsageObserverOptions {
  const claudeDir = config.claudeConfigDir ?? env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
  const codexHome = config.codexHome ?? env['CODEX_HOME'] ?? join(homedir(), '.codex');
  return { claudeProjectsDir: join(claudeDir, 'projects'), codexSessionsDir: join(codexHome, 'sessions'), staleMs: config.usageStaleMs };
}
