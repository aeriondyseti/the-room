# Codex acceptance fixture — initial qualification

2026-09-28, Codex 0.157.1, Node24.18, Windows. `scripts/acceptance/codex-fixture.mjs` implements the start/turnStartedAt/stop interface for the shared 4.1 orchestrator. It creates daemon-hosted throwaway threads, restricts mutations to IDs it created, disables unrelated MCP servers only in thread-local configuration, and uses gpt-6-luna (present in native model/list). No user configuration is written. This fixture does not qualify TUI-owned sessions or implement the parked background-agent product feature.

`node scripts/acceptance/smoke-codex.mjs <absolute dist/cli/main.js>`:

- Registration through room_join succeeded on two disposable threads.
- Queue trial thread: `01a0e6d2-cbe5-7023-9c71-e544617d2331`.
- Room message creation: 07:03:02.824Z; observed task start: 07:03:02.946Z (**122ms**). Transport receipt persisted 07:03:02.956Z (**132ms** from creation).
- **Failed reply gate:** fixture reported that room_send requires approval but its approval policy is never. No reply was received in the 90-second window. Native wake succeeded; unattended messaging is not qualified.
- Explicit approval was requested from Kevin before changing fixture tool policy. That initial run did not alter policy; see the approved follow-up below.
- Both owned threads were deleted, and their room services were stopped. Local raw evidence remains under OS temporary directories `vpfix-codex-smoke-DJGeGh` and `vpfix-codex-wake-HeikuU`.

The smoke command exits nonzero when reply or turn-start evidence is absent. This result must remain in the 4.1 failure report even after a later successful configured run.

## Approved fixture-only follow-up — 2026-09-28 13:23Z

Kevin approved the pending request directly to Astra. The helper now allowlists exactly room_send, room_read, room_who and room_join, with per-tool approval_mode="approve" in the new thread's MCP configuration. The server default remains prompt. Read-only sandbox and approvalPolicy=never are unchanged; no global configuration or existing session is edited. The per-tool field is documented in the [official OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Successful smoke in `vpfix-codex-wake-Ffsybj`:

- Owned thread:01a0e82e-d976-7971-8906-e38aa6611fcd.
- Message:m-mula2nv8-28a9a989-ce07-4075-a4b6-ab95f4e7fbc3, created13:23:10.292Z.
- Turn start13:23:10.435Z (143ms); submission persisted13:23:10.447Z (155ms).
- Attributed MCP ACK at13:23:13.007Z (2.715seconds); identity source codex-mcp-meta; original delivery became replied.
- Thread deleted and fixture service stopped by the smoke runner. Raw evidence remains in the owned temp root.

This removes the specific approval blocker. The original failed trial remains part of the report; the full20-trial and four-agent qualification are still required.
