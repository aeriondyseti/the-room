# Claude Code MCP caller-identity probe — results

Date: 2026-09-28 · Claude Code 2.1.283 · Node 24.18.0 · Windows 11 · probe:
[`claude-identity-mcp.mjs`](claude-identity-mcp.mjs), the Claude counterpart to
Astra's `thread-id-mcp.mjs`.

**Question:** can an MCP server loaded by a Claude Code session tell which
Claude session is calling it, without being told by the model?

**Answer: yes, two independent ways that agree.** Per-call MCP metadata does
**not** carry a session id (unlike Codex).

## Method

- **Probe:** a read-only stdio MCP server with one tool, `claude_identity`.
  It reports:
  - the names of `CLAUDE*` environment variables, and values only for
    non-secret ids (the messaging token is never printed);
  - the field names of the per-call `params._meta` and any
    session/thread id fields in it;
  - its parent pid, and the nearest ancestor with a
    `~/.claude/sessions/<pid>.json` entry (read fresh on every call).
- **Sessions:** throwaway headless sessions:
  `claude -p … --model haiku --mcp-config mcp.json --strict-mcp-config
  --allowedTools mcp__idprobe__claude_identity --output-format json`, run
  from a temp directory. No user or project MCP config was changed.
  `mcp.json` = `{"mcpServers":{"idprobe":{"command":"<node.exe>","args":["<path>/claude-identity-mcp.mjs"]}}}`.
- **Ground truth:** the harness's own `session_id` from the stream's `init`
  and `result` events.
- **Cleanup:** the temp transcripts were deleted afterwards. The registry
  entries disappeared when the sessions exited.

## Results

| Run | Harness session_id | Env `CLAUDE_CODE_SESSION_ID` | Parent pid → registry `sessionId` | `_meta` fields | MCP pid |
|---|---|---|---|---|---|
| A | `146dc6db-…59db` | `146dc6db-…59db` ✓ | 54124 → `146dc6db-…59db` ✓ | `claudecode/toolUseId`, `progressToken` | 48952 |
| B (concurrent with A) | `36ebdd24-…a7ab` | `36ebdd24-…a7ab` ✓ | 66976 → `36ebdd24-…a7ab` ✓ | same | 84460 |
| C (`--resume` A) | `146dc6db-…59db` (preserved) | `146dc6db-…59db` ✓ | 78492 (new) → `146dc6db-…59db` ✓ | same | 19584 (new) |

- Each session has its own MCP server process. Concurrent sessions don't
  share one.
- The MCP server's **direct parent** is the Claude process that owns the
  registry entry, so no ancestor walk was needed. `CLAUDE_PID` is also
  present in the environment.
- `--resume` keeps the session id; the Claude pid and the MCP process are
  new. A `session.toml` binding by `session_id` survives resume.
- `clientInfo` is `claude-code` 2.1.283 (useful to tell harnesses apart).
- The MCP process environment also contains `CLAUDE_CODE_MESSAGING_SOCKET`
  and `CLAUDE_CODE_MESSAGING_TOKEN` (the session's own-pipe child token).
  They weren't needed; the token must never be logged.

## Recommendation for the room MCP server (Claude path)

1. **Primary:** on **every call**, read `~/.claude/sessions/<process.ppid>.json`
   (walk ancestors if the direct parent has no entry) and validate
   `procStart`. Its `sessionId` identifies the caller; match it against the
   `session.toml` `session_id`.
2. **Cross-check:** `CLAUDE_CODE_SESSION_ID` from the environment. If it
   disagrees with the registry, trust the registry (see below) and flag the
   mismatch.
3. **Never** infer identity from the MCP pid, cwd, `clientInfo`, or model
   input. Reject unregistered or conflicting identities (same rule as the
   Codex path).

## Not tested

- **`/clear` or `/compact` in a live interactive session.** The session id
  may change while the MCP process keeps running. If so, the environment
  value goes stale, which is why the fresh per-call registry read is the
  primary signal.
- **`--fork-session`, `--bg` sessions, and the interactive TUI launch
  path.** `-p` sessions register as `kind: "interactive"`; bg/TUI sessions
  are expected to behave the same but weren't run.
- **Approval prompts:** the tool was pre-allowed with `--allowedTools`, so
  approval UX wasn't observed.
