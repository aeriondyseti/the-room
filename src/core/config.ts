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
  /** Claude config dir holding `sessions/` (else CLAUDE_CONFIG_DIR, else ~/.claude). */
  claudeConfigDir: string | null;
  /**
   * After writing a message to a Claude pipe, how long to watch for the receiver closing the connection
   * (e.g. an auth rejection) before reporting `submitted`. A close inside this window is reported `uncertain`.
   */
  claudeSubmitSettleMs: number;
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
  claudeSubmitSettleMs: 300,
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
  claudeSubmitSettleMs: 'ROOM_CLAUDE_SUBMIT_SETTLE_MS',
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
    } else {
      (config as unknown as Record<string, unknown>)[key] = raw;
    }
  }
  return config;
}

export const CONFIG_ENV_KEYS: Readonly<Record<keyof RoomConfig, string>> = ENV_KEYS;
