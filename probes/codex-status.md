# Codex participant status (2.1b)

VERIFIED on Windows, codex-cli 0.157.1, 2026-09-28.

- Read-only shared-daemon `thread/list` returned the enrolled Astra thread
  `01a0e605-2485-7693-a111-97e35d22a97e` with `status: {type: active, activeFlags: []}`;
  `thread/loaded/list` included that same ID. Other entries included idle and notLoaded.
- Production adapter smoke using `CodexAdapter(codexOptionsFrom(loadConfig(), cwd)).probe(target)`
  returned `{liveness: online, activity: busy}` using only initialize/initialized/thread/read.
- `codex app-server generate-ts --out .room/status-schema` confirmed ThreadStatus tags
  notLoaded, idle, systemError, active; active flags waitingOnApproval and waitingOnUserInput;
  thread/read accepts includeTurns:false. Generated files stay ignored.
- Protocol reads go through a short-lived `codex app-server proxy --sock <home>/app-server-control/app-server-control.sock`
  subprocess. No daemon start, turn start, queue insertion, resume, configuration edits, or database writes.
  Reader closes only its own proxy after success/failure/timeout, never the shared daemon.
- No raw response bodies, transcripts, or stderr are persisted. Tests use a separate fake byte tunnel.

Mapping: idle -> online/idle; active with empty flags -> online/busy; waitingOnApproval ->
online/waiting_permission. Other active flags -> online/unknown until the room has a corresponding
activity state. notLoaded, systemError, missing thread, bad reply or unavailable daemon -> unknown.
An independent TUI may own a thread absent from this shared daemon, so absence is never offline/rebind.

Bounds: ROOM_CODEX_STATUS_TIMEOUT_MS (3000), ROOM_CODEX_STATUS_MAX_BYTES (4194304 total received bytes).
Existing participant monitor controls refresh cadence (default 5 seconds). Status is sampled evidence,
not an assertion that the process cannot change between samples. Delivery continues independently.

Validation: 206 tests passed with FORCE_COLOR=1. Unforced redirected output exposed two pre-existing
TUI color assertions; reported to their owner. Live probe reported busy as above. No fixture threads
created and no working session interrupted during these checks.
