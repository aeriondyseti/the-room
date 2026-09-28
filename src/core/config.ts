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
};

/** Build the effective config from defaults + environment. Invalid numeric overrides throw (never silently ignored). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RoomConfig {
  const config: RoomConfig = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(ENV_KEYS) as (keyof RoomConfig)[]) {
    const raw = env[ENV_KEYS[key]];
    if (raw === undefined || raw === '') continue;
    const current = DEFAULT_CONFIG[key];
    if (typeof current === 'number') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`${ENV_KEYS[key]} must be a positive integer, got "${raw}"`);
      (config as unknown as Record<string, unknown>)[key] = n;
    } else {
      (config as unknown as Record<string, unknown>)[key] = raw;
    }
  }
  return config;
}

export const CONFIG_ENV_KEYS: Readonly<Record<keyof RoomConfig, string>> = ENV_KEYS;
