// Tunables (CLAUDE.md: "Tunables in config, not literals"). Every value can be overridden via ROOM_* env.

export interface RoomConfig {
  /** Max envelope characters for `codex queue --message` (Windows command-line budget; proposal "Message envelope"). */
  codexMaxEnvelopeChars: number;
  /** Max envelope characters for the Claude messaging pipe. */
  claudeMaxEnvelopeChars: number;
  /** Preview length used by the oversized-message reference fallback. */
  oversizePreviewChars: number;
  /** How long a client waits for an auto-started service to become ready. */
  serviceStartTimeoutMs: number;
  /** Timeout for one IPC request. */
  ipcRequestTimeoutMs: number;
  /** Timeout for one adapter submission. */
  adapterTimeoutMs: number;
  /** Default page size for `read`. */
  readPageSize: number;
  /** Display name for the human in the TUI and envelopes. */
  humanDisplayName: string;
  /** Explicit room root override (else resolved from git). */
  roomRoot: string | null;
  /** Explicit Codex executable (else resolved from PATH). */
  codexExecutable: string | null;
  /** Max wait to acquire the session.toml registry lock before failing with an actionable error. */
  registryLockTimeoutMs: number;
  /** Poll interval while waiting for the registry lock. */
  registryLockPollMs: number;
  /** Claude config dir holding `projects/` transcripts (else CLAUDE_CONFIG_DIR, else ~/.claude). */
  claudeConfigDir: string | null;
  /** Codex home holding `sessions/` rollouts (else CODEX_HOME, else ~/.codex). */
  codexHome: string | null;
  /** A usage reading older than this is labelled `stale` (values still shown). */
  usageStaleMs: number;
  /**
   * Known context-window sizes by model id, for transcripts that don't record the limit (Claude). A model not
   * listed keeps `limitTokens: null` (no percentage). Override with ROOM_CONTEXT_LIMITS="model=tokens,model=tokens".
   */
  contextLimits: Readonly<Record<string, number>>;
}

export const DEFAULT_CONFIG: Readonly<RoomConfig> = Object.freeze({
  codexMaxEnvelopeChars: 24_000,
  claudeMaxEnvelopeChars: 900_000,
  oversizePreviewChars: 2_000,
  serviceStartTimeoutMs: 10_000,
  ipcRequestTimeoutMs: 30_000,
  adapterTimeoutMs: 30_000,
  readPageSize: 50,
  humanDisplayName: 'Kevin',
  roomRoot: null,
  codexExecutable: null,
  registryLockTimeoutMs: 5_000,
  registryLockPollMs: 50,
  claudeConfigDir: null,
  codexHome: null,
  usageStaleMs: 15 * 60_000,
  // Source: Kevin, 2026-09-28 ("your context limit is 1M tokens") for this deployment's Claude model.
  contextLimits: Object.freeze({ 'claude-opus-5-5': 1_000_000 }),
});

const ENV_KEYS: Record<keyof RoomConfig, string> = {
  codexMaxEnvelopeChars: 'ROOM_CODEX_MAX_ENVELOPE_CHARS',
  claudeMaxEnvelopeChars: 'ROOM_CLAUDE_MAX_ENVELOPE_CHARS',
  oversizePreviewChars: 'ROOM_OVERSIZE_PREVIEW_CHARS',
  serviceStartTimeoutMs: 'ROOM_SERVICE_START_TIMEOUT_MS',
  ipcRequestTimeoutMs: 'ROOM_IPC_REQUEST_TIMEOUT_MS',
  adapterTimeoutMs: 'ROOM_ADAPTER_TIMEOUT_MS',
  readPageSize: 'ROOM_READ_PAGE_SIZE',
  humanDisplayName: 'ROOM_HUMAN_NAME',
  roomRoot: 'ROOM_ROOT',
  codexExecutable: 'ROOM_CODEX_EXECUTABLE',
  registryLockTimeoutMs: 'ROOM_REGISTRY_LOCK_TIMEOUT_MS',
  registryLockPollMs: 'ROOM_REGISTRY_LOCK_POLL_MS',
  claudeConfigDir: 'ROOM_CLAUDE_CONFIG_DIR',
  codexHome: 'ROOM_CODEX_HOME',
  usageStaleMs: 'ROOM_USAGE_STALE_MS',
  contextLimits: 'ROOM_CONTEXT_LIMITS',
};

/** Build the effective config from defaults + environment. Invalid numeric overrides throw (never silently ignored). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RoomConfig {
  const config: RoomConfig = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(ENV_KEYS) as (keyof RoomConfig)[]) {
    const raw = env[ENV_KEYS[key]];
    if (raw === undefined || raw === '') continue;
    const current = DEFAULT_CONFIG[key];
    if (typeof current === 'number') {
      const n = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${ENV_KEYS[key]} must be a positive decimal integer, got "${raw}"`);
      (config as unknown as Record<string, unknown>)[key] = n;
    } else if (typeof current === 'object' && current !== null) {
      (config as unknown as Record<string, unknown>)[key] = { ...current, ...parseLimits(ENV_KEYS[key], raw) };
    } else {
      (config as unknown as Record<string, unknown>)[key] = raw;
    }
  }
  return config;
}

export const CONFIG_ENV_KEYS: Readonly<Record<keyof RoomConfig, string>> = ENV_KEYS;

/** Parse "model=tokens,model=tokens" (merged over the defaults); malformed entries throw. */
function parseLimits(envName: string, raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^([A-Za-z0-9._:-]+)=([0-9]+)$/.exec(part);
    const n = m ? Number(m[2]) : Number.NaN;
    if (!m || !Number.isSafeInteger(n) || n <= 0) throw new Error(`${envName} entries must look like model=tokens, got "${part}"`);
    out[m[1]!] = n;
  }
  return out;
}
