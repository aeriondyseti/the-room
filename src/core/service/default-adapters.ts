import { ClaudeAdapter, claudeAdapterOptionsFrom, defaultRegistryDeps, resolveClaudeConfigDir } from '../../adapters/claude/index.js';
import type { DeliveryAdapter } from '../../contracts/adapter.js';
import { loadConfig } from '../config.js';
/** Production wiring; tests inject their own adapters and never inherit live native transports. */
export function defaultAdapters():DeliveryAdapter[]{
 const config=loadConfig();
 return [new ClaudeAdapter(claudeAdapterOptionsFrom(config,defaultRegistryDeps(resolveClaudeConfigDir(config.claudeConfigDir),config.claudeProcStartTimeoutMs)))];
}
