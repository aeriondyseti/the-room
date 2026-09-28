# Live check: `room mcp` identifies a real Claude session (ROADMAP 2.6)

- **Date:** 2026-09-28 · Claude Code 2.1.283 · Windows 11 · session `67b7bc1e-0c3e-4ffa-9d51-a88eb52d61d8`
  (pid 32064).
- **Method:**
  - A script run from the Claude session's Bash tool spawns `node dist/cli/main.js mcp` (stdio) against a
    throwaway git repo room.
  - It calls `room_join {name:"claude"}`, then `room_who`, then `room_send {to:"human"}`.
  - It reads the registry back with a CLI connection, then shuts that service down.

## Finding 1: the ancestor walk can't cross Git Bash
The chain is `node (mcp) → node (script) → timeout.exe → timeout.exe → <pid not in the process table>`.
- Git Bash (MSYS) fork emulation leaves Windows parent pids pointing at processes that have already exited,
  so no walk from a Claude Bash-tool shell reaches `claude.exe`.
- A PowerShell-tool chain does work: `pwsh → cmd.exe → claude.exe`.
- A harness-launched MCP server (the normal path) has `claude.exe` as its direct parent (see
  probes/claude-identity-results.md), so it's unaffected.

## Fix
After the walk fails, fall back to the environment Claude exports to its tools:
- Look up the registry record at `CLAUDE_PID`.
- Accept it only when it is **live**, its start time is **verified**, and its `sessionId` equals
  `CLAUDE_CODE_SESSION_ID`, so two independent signals agree.

The walk depth default also went from 4 to 8, because shells and launchers stack up. The walk stays safe:
ancestors must be verified, and another harness in the chain stops it.

## Result (after the fix)
```
room_join → Joined as "claude" (claude). Others can now reach you with to: "claude".
room_who  → Participants (1): - claude (claude): unknown
room_send → Sent #1 (id m-…) to human.
registered: [{"name":"claude","harness":"claude","sessionId":"67b7bc1e-0c3e-4ffa-9d51-a88eb52d61d8"}]
```

Registering the Codex side on live sessions needs a thread resume (MCP), or the 2.3 CLI's
`room join --as astra` (via `CODEX_THREAD_ID`). That's done in 4.1 together with migrating the repo's legacy
`session.toml`.
