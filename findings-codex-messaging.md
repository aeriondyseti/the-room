# Findings: Codex inter-session messaging

Investigation date: 2026-09-27 · Codex CLI 0.157.1 · Windows 11

**Question:** can an external process deliver a message into a specific,
running, interactive Codex session so that it **starts a turn when idle** and
is **queued when busy**? This is the wake requirement from
[proposal-claude.md](proposal-claude.md).

**Answer: yes.** `codex queue --thread <id> --message <text>` does exactly
that. Verified end-to-end on throwaway sessions.

Evidence labels: **VERIFIED** = observed in the experiment or logs ·
**DOCUMENTED** = official docs / CLI help · **INFERRED** = deduced from
evidence, not confirmed.

## Summary

| Question | Result | Evidence |
|---|---|---|
| Idle interactive TUI starts a turn on a queued message? | Yes, about 2.5–8 s latency | VERIFIED |
| Busy TUI? | Queued; runs as its **own next turn** right after the current one ends (not injected mid-turn) | VERIFIED |
| Thread not open in any TUI? | Message persists; runs as soon as the thread is resumed in a TUI | VERIFIED |
| Auth needed on the local socket? | No | VERIFIED |
| How a session learns its own thread id | `CODEX_THREAD_ID` (and the identical `CODEX_SESSION_ID`) are set in every shell command the session runs | VERIFIED |
| Stop hook can force continuation? | `{"decision":"block","reason":"..."}` continues, using `reason` as a new prompt | DOCUMENTED |
| PostToolUse hook can inject context? | `hookSpecificOutput.additionalContext` | DOCUMENTED |

## How it works

1. `codex queue --thread <id> --message "<text>"` returns in about 0.1 s and
   prints `Queued message <id> for thread <tid>.` (VERIFIED)
2. The CLI connects to the shared, always-running app-server daemon over
   `C:\Users\Kevin\.codex\app-server-control\app-server-control.sock` (found
   via `codex app-server daemon version`). It sends a single JSON-RPC call,
   `thread/queue/add`. (VERIFIED from `~/.codex/logs_2.sqlite`, read-only)
3. The daemon stores the message in `~/.codex/queue_1.sqlite`:
   - Table `queued_items(id, thread_id, payload_json, queue_order,
     created_at_ms, updated_at_ms)`.
   - Triggers bump a per-thread revision counter in
     `queued_thread_revisions`.
   - The table held 0 rows before and after testing. (VERIFIED)
4. The interactive TUI does **not** connect to that daemon. It runs its own
   in-process app-server; its MCP servers are children of the TUI process.
   The TUI appears to poll the sqlite file for its thread (INFERRED from the
   2.5–8 s latency and silence in between). It then logs
   `thread/queue/changed` → a `TurnInput` submission → `turn/started`.
   (Log sequence VERIFIED; polling INFERRED)

### Relevant app-server JSON-RPC methods

Taken from the generated schema (`codex app-server generate-json-schema`,
output kept in `C:\Users\Kevin\.claude\jobs\67b7bc1e\tmp\schema`, see
`v2/ThreadQueue*.json`, `TurnSteerParams.json`). Only `thread/queue/add` was
exercised, via the CLI.

- `thread/queue/add {threadId, clientUserMessageId, input: UserInput[]}`
- `thread/queue/list`, `/start`, `/delete`, `/reorder`, `/update`, plus the
  `thread/queue/changed` notification
- `turn/steer {threadId, expectedTurnId, input}` — injects input into the
  **running** turn (a candidate for mid-turn delivery; untested)
- `turn/start`, `thread/inject_items` (appends history without starting a
  turn), `thread/loaded/list`
- `codex app-server proxy` bridges stdio to the control socket, for scripting
  JSON-RPC directly

## How it was tested

A subagent ran the experiment in isolation. It never messaged or modified
any of the user's existing Codex sessions.

1. **Setup:** created a scratch folder
   `C:\Users\Kevin\.claude\jobs\67b7bc1e\tmp\codex-test` and ran `git init`
   there. The folder was trusted through a `-c` config override for the run
   only, so nothing was written to `~/.codex/config.toml`.
2. **Created a thread** with a cheap `codex exec` run to get a thread id.
3. **Test A — no TUI attached:** ran
   `codex queue --thread <id> --message "reply with the word PONG"`.
   - The message sat in the queue; nothing processed it.
   - Resuming that thread in an interactive TUI then ran it immediately and
     the agent answered PONG.
4. **Test B — idle TUI:** opened the thread in an interactive TUI in a
   separate WezTerm window, with hooks disabled, and let it sit idle.
   - Queued `PING2` from another shell.
   - The TUI started a turn on its own after about 2.5 s.
5. **Test C — busy TUI:** queued a message that made the agent run a 15 s
   sleep, then queued `AFTER` about 5 s later, while that turn was still
   running.
   - `AFTER` was **not** injected into the running turn.
   - It ran as a separate turn about 13 ms after the first turn finished.
6. **Logs:** confirmed the transport and event sequence by reading
   `~/.codex/logs_2.sqlite` and `queue_1.sqlite` read-only (schema and row
   counts only).
7. **Hooks:** read the official docs at learn.chatgpt.com/docs/hooks
   (developers.openai.com/codex/hooks redirects there).
8. **Cleanup:** closed the test TUI, force-deleted both throwaway threads
   (`01a0e612-77a6…` and `01a0e612-520e…`), and removed the scratch folder.

Not tested: `codex agents` is an interactive browser and could not be driven
from a script, so it's unconfirmed whether it lists these sessions.

## Hooks (DOCUMENTED)

Every hook receives on stdin: `session_id`, `transcript_path`, `cwd`,
`hook_event_name`, `model` and `permission_mode`; turn-scoped hooks also get
`turn_id`. The docs don't state that `session_id` equals the thread id. In
practice `CODEX_THREAD_ID` and `CODEX_SESSION_ID` were identical.

- **Stop:** `{"decision":"block","reason":"..."}` makes Codex continue, with
  `reason` as a new user prompt. `continue`, `stopReason` and
  `systemMessage` are also supported.
- **PostToolUse:** `hookSpecificOutput.additionalContext` injects model
  context. `decision:"block"` does not undo the tool call; it replaces the
  tool result with the hook's feedback.
- **UserPromptSubmit:** can block or add context; exit code 2 also blocks.
- The `hooks` feature is stable and on by default.

## Stability

- `codex queue` and `codex agents` carry **no** experimental label.
- `app-server`, `remote-control`, `generate-ts` and `generate-json-schema`
  are marked `[experimental]`.
- The feature `daemon_auto_start` is stable and enabled.
- The TUI polling `queue_1.sqlite` is an implementation detail (INFERRED),
  not a documented contract. Depend on the `codex queue` CLI (or
  `thread/queue/add`), not on the sqlite file.

## Implications for vibe-pairing

- **Idle wake for Codex is solved:** the dispatcher shells out to
  `codex queue --thread <id> --message "<room message>"`. No PTY injection is
  needed.
- **Registration:** the first hook firing (or `room up`) records
  `name → CODEX_THREAD_ID` in `.room/agents/<name>.json`.
- **Busy agents:** queued messages wait for the current turn to end. For
  real-time mid-turn delivery, use a `PostToolUse` hook with
  `additionalContext`, as the proposal already plans (`turn/steer` is an
  untested alternative).
- **Stop hook:** can hand unread room messages back as a new prompt, which
  also covers parking. That gives the same model as the Claude side.
- **Constraint:** a thread must be open in a TUI for a queued message to
  run. A closed agent picks up its backlog when resumed, so nothing is lost.
- **Latency budget:** 2.5–8 s fits the 5 s acceptance target only some of
  the time. Either relax the target for Codex to about 10 s, or look into
  `turn/start` / `turn/steer` over the socket for faster delivery.
