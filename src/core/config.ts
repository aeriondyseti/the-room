// Tunables (AGENTS.md: "Tunables in config, not literals"). Every value can be overridden via ROOM_* env.

export interface RoomConfig {
  workspaceReadBytes: number;
  workspaceScanEntries: number;
  workspaceTimeoutMs: number;
  workspaceGitMaxBytes: number;
  workspaceGitCacheMs: number;
  /** Conservative CreateProcess budget including executable, quoting and NUL. */
  codexStatusTimeoutMs: number;
  codexStatusMaxBytes: number;
  codexCommandLineBudget: number;
  /** Queue CLI output limit; exceeding it makes acceptance uncertain. */
  codexMaxOutputBytes: number;
  /** Retry reachability checks for queued recipients without model polling. */
  dispatchPollMs: number;
  /** Poll interval for detached service readiness. */
  servicePollMs: number;
  /** Bounded SQLite lock-contention wait. */
  sqliteBusyTimeoutMs: number;
  /** Max envelope characters for `codex queue --message` (Windows command-line budget; pre-build proposal "Message envelope"). */
  codexMaxEnvelopeChars: number;
  /** Max envelope characters for the Claude messaging pipe. */
  claudeMaxEnvelopeChars: number;
  /** Preview length used by the oversized-message reference fallback. */
  oversizePreviewChars: number;
  /** M7: cap the reason repeated in urgent native envelopes. */
  urgentReasonMaxChars: number;
  /** How long a client waits for an auto-started service to become ready. */
  serviceStartTimeoutMs: number;
  /** Timeout for one IPC request. */
  ipcRequestTimeoutMs: number;
  /** Timeout for one adapter submission. */
  adapterTimeoutMs: number;
  /** Default page size for `read`. */
  readPageSize: number;
  inboxPageBytes: number;
  inboxPartBytes: number;
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
  /** Claude config dir holding `sessions/` and `projects/` (else CLAUDE_CONFIG_DIR, else ~/.claude). */
  claudeConfigDir: string | null;
  /**
   * After writing a message to a Claude pipe, how long to watch for the receiver closing the connection before
   * reporting `submitted`. A close inside this window is reported `uncertain` (the protocol has no auth ack, so a
   * rejected token is indistinguishable from a close after delivery — plan/debt/claude-auth-rejection-uncertain.md).
   */
  claudeSubmitSettleMs: number;
  /** Timeout for the process start-time query used to detect pid reuse. */
  claudeProcStartTimeoutMs: number;
  /** How long a Claude process start time is cached (pid-reuse check); a stale value can only cause a clean connect failure. */
  claudeProcStartCacheMs: number;
  /** How often the service refreshes participant liveness, activity and usage. */
  participantRefreshMs: number;
  /** M8: how long an agent kick proposal remains open for unanimous online votes. */
  kickProposalTtlMs: number;
  /** Codex home holding `sessions/` rollouts (else CODEX_HOME, else ~/.codex). */
  codexHome: string | null;
  /** A usage reading older than this is labelled `stale` (values still shown). */
  usageStaleMs: number;
  /**
   * Known context-window sizes by model id, for transcripts that don't record the limit (Claude). A model not
   * listed keeps `limitTokens: null` (no percentage). Override with ROOM_CONTEXT_LIMITS="model=tokens,model=tokens".
   */
  contextLimits: Readonly<Record<string, number>>;
  /** TUI: default layout, 'top' (top bar) or 'left' (side panel); a choice saved with /layout wins over it. */
  tuiLayout: string;
  /** TUI: left panel width in columns. */
  tuiPanelWidth: number;
  /** TUI: the left panel shows only when the terminal is at least this wide (else the top bar, with a notice). */
  tuiPanelBreakpoint: number;
  /** TUI: the most rows the composer grows to before it scrolls (always bounded by the terminal's free rows). */
  tuiComposerMaxRows: number;
  /** TUI: messages loaded on first connect. */
  tuiHistoryLimit: number;
  /** TUI: max pages read when catching up after a reconnect (beyond it, a notice says history may be missing). */
  tuiCatchUpMaxPages: number;
  /** TUI: first reconnect delay; doubles per failure up to tuiReconnectMaxMs. */
  tuiReconnectMinMs: number;
  tuiReconnectMaxMs: number;
  /** TUI: consecutive connection failures before the header says "disconnected" (it keeps retrying). */
  tuiFailuresBeforeDisconnected: number;
  /** Activity view (6.1): cap on one item's detail text, in bytes (longer is cut and labelled "truncated"). */
  activityDetailBytes: number;
  /** Activity items retained per stream (older ones are evicted and reported as unavailable, never empty). */
  activityWindowItems: number;
  /** When a transcript is first observed, start this many bytes before its end (older history isn't loaded). */
  activityStartBytes: number;
  /** A single transcript line longer than this is skipped (counted as oversized; never parsed from its middle). */
  activityMaxLineBytes: number;
  /** Upper bound read from one transcript per poll (the rest is read later; the view shows "catching up"). */
  activityReadBytes: number;
  /** How often the service polls participants' transcripts for new activity. */
  activityPollMs: number;
  /** How often each subscription-usage source is sampled (bounded: per source, never per participant or render). */
  accountsPollMs: number;
  /** On shutdown, how long to wait for an in-flight observation pass before abandoning it (it then writes nothing). */
  monitorStopGraceMs: number;
  /** A usage reading older than this is shown as stale (values kept, labelled). */
  accountsStaleMs: number;
  /**
   * 'on' to read Claude plan usage (incl. model-specific weekly limits such as Fable) from Anthropic's usage endpoint
   * with the signed-in Claude Code login (read per request, memory only). 'off' (default) uses only the statusline tap.
   */
  claudeUsageApi: string;
  /** Timeout for one Claude usage-endpoint request. */
  claudeUsageTimeoutMs: number;
}

export const DEFAULT_CONFIG: Readonly<RoomConfig> = Object.freeze({
  workspaceReadBytes: 2 * 1024 * 1024,
  workspaceScanEntries: 10000,
  workspaceTimeoutMs: 3000,
  workspaceGitMaxBytes: 2 * 1024 * 1024,
  workspaceGitCacheMs: 15000,
  codexStatusTimeoutMs: 3000,
  codexStatusMaxBytes: 4 * 1024 * 1024,
  codexCommandLineBudget: 30000,
  codexMaxOutputBytes: 65536,
  dispatchPollMs: 1000,
  servicePollMs: 50,
  sqliteBusyTimeoutMs: 5000,
  codexMaxEnvelopeChars: 24_000,
  claudeMaxEnvelopeChars: 900_000,
  oversizePreviewChars: 2_000,
  urgentReasonMaxChars: 500,
  serviceStartTimeoutMs: 10_000,
  ipcRequestTimeoutMs: 30_000,
  adapterTimeoutMs: 30_000,
  readPageSize: 50,
  inboxPageBytes: 65536,
  inboxPartBytes: 4096,
  humanDisplayName: 'Kevin',
  roomRoot: null,
  codexExecutable: null,
  registryLockTimeoutMs: 5_000,
  registryLockPollMs: 50,
  claudeConfigDir: null,
  claudeSubmitSettleMs: 300,
  claudeProcStartTimeoutMs: 5_000,
  claudeProcStartCacheMs: 30_000,
  participantRefreshMs: 5_000,
  kickProposalTtlMs: 10 * 60_000,
  codexHome: null,
  usageStaleMs: 15 * 60_000,
  // Source: Kevin, 2026-09-28 ("your context limit is 1M tokens") for this deployment's Claude model.
  contextLimits: Object.freeze({ 'claude-opus-5-5': 1_000_000 }),
  tuiLayout: 'top',
  tuiPanelWidth: 34,
  tuiPanelBreakpoint: 90,
  tuiComposerMaxRows: 12,
  tuiHistoryLimit: 500,
  tuiCatchUpMaxPages: 50,
  tuiReconnectMinMs: 250,
  tuiReconnectMaxMs: 5_000,
  tuiFailuresBeforeDisconnected: 3,
  activityDetailBytes: 4_096,
  activityWindowItems: 500,
  activityStartBytes: 512 * 1024,
  activityMaxLineBytes: 1024 * 1024,
  activityReadBytes: 4 * 1024 * 1024,
  activityPollMs: 2_000,
  accountsPollMs: 120_000,
  monitorStopGraceMs: 500,
  accountsStaleMs: 15 * 60_000,
  claudeUsageApi: 'off',
  claudeUsageTimeoutMs: 5_000,
});

const ENV_KEYS: Record<keyof RoomConfig, string> = {
  workspaceReadBytes: 'ROOM_WORKSPACE_READ_BYTES',
  workspaceScanEntries: 'ROOM_WORKSPACE_SCAN_ENTRIES',
  workspaceTimeoutMs: 'ROOM_WORKSPACE_TIMEOUT_MS',
  workspaceGitMaxBytes: 'ROOM_WORKSPACE_GIT_MAX_BYTES',
  workspaceGitCacheMs: 'ROOM_WORKSPACE_GIT_CACHE_MS',
  codexStatusTimeoutMs: 'ROOM_CODEX_STATUS_TIMEOUT_MS',
  codexStatusMaxBytes: 'ROOM_CODEX_STATUS_MAX_BYTES',
  codexCommandLineBudget: 'ROOM_CODEX_COMMAND_LINE_BUDGET',
  codexMaxOutputBytes: 'ROOM_CODEX_MAX_OUTPUT_BYTES',
  dispatchPollMs: 'ROOM_DISPATCH_POLL_MS',
  servicePollMs: 'ROOM_SERVICE_POLL_MS',
  sqliteBusyTimeoutMs: 'ROOM_SQLITE_BUSY_TIMEOUT_MS',
  codexMaxEnvelopeChars: 'ROOM_CODEX_MAX_ENVELOPE_CHARS',
  claudeMaxEnvelopeChars: 'ROOM_CLAUDE_MAX_ENVELOPE_CHARS',
  oversizePreviewChars: 'ROOM_OVERSIZE_PREVIEW_CHARS',
  urgentReasonMaxChars: 'ROOM_URGENT_REASON_MAX_CHARS',
  serviceStartTimeoutMs: 'ROOM_SERVICE_START_TIMEOUT_MS',
  ipcRequestTimeoutMs: 'ROOM_IPC_REQUEST_TIMEOUT_MS',
  adapterTimeoutMs: 'ROOM_ADAPTER_TIMEOUT_MS',
  readPageSize: 'ROOM_READ_PAGE_SIZE',
  inboxPageBytes: 'ROOM_INBOX_PAGE_BYTES',
  inboxPartBytes: 'ROOM_INBOX_PART_BYTES',
  humanDisplayName: 'ROOM_HUMAN_NAME',
  roomRoot: 'ROOM_ROOT',
  codexExecutable: 'ROOM_CODEX_EXECUTABLE',
  registryLockTimeoutMs: 'ROOM_REGISTRY_LOCK_TIMEOUT_MS',
  registryLockPollMs: 'ROOM_REGISTRY_LOCK_POLL_MS',
  claudeConfigDir: 'ROOM_CLAUDE_CONFIG_DIR',
  claudeSubmitSettleMs: 'ROOM_CLAUDE_SUBMIT_SETTLE_MS',
  claudeProcStartTimeoutMs: 'ROOM_CLAUDE_PROC_START_TIMEOUT_MS',
  claudeProcStartCacheMs: 'ROOM_CLAUDE_PROC_START_CACHE_MS',
  participantRefreshMs: 'ROOM_PARTICIPANT_REFRESH_MS',
  kickProposalTtlMs: 'ROOM_KICK_PROPOSAL_TTL_MS',
  codexHome: 'ROOM_CODEX_HOME',
  usageStaleMs: 'ROOM_USAGE_STALE_MS',
  contextLimits: 'ROOM_CONTEXT_LIMITS',
  tuiLayout: 'ROOM_TUI_LAYOUT',
  tuiPanelWidth: 'ROOM_TUI_PANEL_WIDTH',
  tuiPanelBreakpoint: 'ROOM_TUI_PANEL_BREAKPOINT',
  tuiComposerMaxRows: 'ROOM_TUI_COMPOSER_MAX_ROWS',
  tuiHistoryLimit: 'ROOM_TUI_HISTORY_LIMIT',
  tuiCatchUpMaxPages: 'ROOM_TUI_CATCH_UP_MAX_PAGES',
  tuiReconnectMinMs: 'ROOM_TUI_RECONNECT_MIN_MS',
  tuiReconnectMaxMs: 'ROOM_TUI_RECONNECT_MAX_MS',
  tuiFailuresBeforeDisconnected: 'ROOM_TUI_FAILURES_BEFORE_DISCONNECTED',
  activityDetailBytes: 'ROOM_ACTIVITY_DETAIL_BYTES',
  activityWindowItems: 'ROOM_ACTIVITY_WINDOW_ITEMS',
  activityStartBytes: 'ROOM_ACTIVITY_START_BYTES',
  activityMaxLineBytes: 'ROOM_ACTIVITY_MAX_LINE_BYTES',
  activityReadBytes: 'ROOM_ACTIVITY_READ_BYTES',
  activityPollMs: 'ROOM_ACTIVITY_POLL_MS',
  accountsPollMs: 'ROOM_ACCOUNTS_POLL_MS',
  monitorStopGraceMs: 'ROOM_MONITOR_STOP_GRACE_MS',
  accountsStaleMs: 'ROOM_ACCOUNTS_STALE_MS',
  claudeUsageApi: 'ROOM_CLAUDE_USAGE_API',
  claudeUsageTimeoutMs: 'ROOM_CLAUDE_USAGE_TIMEOUT_MS',
};

/** Doubling reconnect schedule from min to max (inclusive), e.g. 250, 500, 1000, 2000, 4000, 5000. */
export function backoffSchedule(minMs: number, maxMs: number): number[] {
  const out: number[] = [];
  for (let d = Math.max(1, minMs); d < maxMs; d *= 2) out.push(d);
  out.push(Math.max(minMs, maxMs));
  return out;
}

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
