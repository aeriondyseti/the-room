export { ClaudeAdapter, activityOf, claudeAdapterOptionsFrom, type ClaudeAdapterOptions } from './adapter.js';
export {
  defaultRegistryDeps,
  isLocalPipePath,
  keyHashForPipe,
  lookupSession,
  resolveClaudeConfigDir,
  type ClaudeRegistryDeps,
  type ClaudeSessionRecord,
  type SessionLookup,
} from './registry.js';
export { buildAuthFrame, buildUserFrame, sendToPipe, type PipeSendOutcome } from './pipe.js';
