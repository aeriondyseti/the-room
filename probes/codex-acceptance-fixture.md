# Codex acceptance fixture — initial qualification

2026-09-28, Codex 0.157.1, Node24.18, Windows. `scripts/acceptance/codex-fixture.mjs` implements the start/turnStartedAt/stop interface for the shared 4.1 orchestrator. It creates daemon-hosted throwaway threads, restricts mutations to IDs it created, disables unrelated MCP servers only in thread-local configuration, and uses gpt-6-luna (present in native model/list). No user configuration is written. This fixture does not qualify TUI-owned sessions or implement the parked background-agent product feature.

`node scripts/acceptance/smoke-codex.mjs <absolute dist/cli/main.js>`:

- Registration through room_join succeeded on two disposable threads.
- Queue trial thread: `01a0e6d2-cbe5-7023-9c71-e544617d2331`.
- Room message creation: 07:03:02.824Z; observed task start: 07:03:02.946Z (**122ms**). Transport receipt persisted 07:03:02.956Z (**132ms** from creation).
- **Failed reply gate:** fixture reported that room_send requires approval but its approval policy is never. No reply was received in the 90-second window. Native wake succeeded; unattended messaging is not qualified.
- Explicit approval to pre-approve only the room tools in disposable fixtures has been requested from Kevin. No policy workaround or configuration expansion was attempted.
- Both owned threads were deleted, and their room services were stopped. Local raw evidence remains under OS temporary directories `vpfix-codex-smoke-DJGeGh` and `vpfix-codex-wake-HeikuU`.

The smoke command exits nonzero when reply or turn-start evidence is absent. This result must remain in the 4.1 failure report even after a later successful configured run.
