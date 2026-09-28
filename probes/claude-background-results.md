# Claude Code background-session checks — results

Date: 2026-09-28 · Claude Code 2.1.283 · Windows 11. These are checks for
the **parked** background-agents idea in [IDEAS.md](../IDEAS.md); they are
not a proposal commitment.

**Method:** four throwaway `--bg` Haiku sessions (`bgprobe-perm`,
`bgprobe-stop`, `bgprobe-stop2`, plus one copy of `bgprobe-stop2`), started
in a scratch directory. The pipe injector refused any target not named
`bgprobe-*`. No user sessions or config were touched. Everything was
stopped, removed, and its transcripts deleted afterwards.

Evidence labels: **VERIFIED** = observed · **DOCUMENTED** = docs/help ·
**INFERRED** = deduced, not confirmed.

## Summary

| Question | Result |
|---|---|
| Watch a background agent with no TUI? | **Yes.** Registry `status`/`waitingFor`, the live transcript JSONL, `claude logs`, `claude agents --json` |
| Approve a permission prompt with no TUI? | **No.** It can only be *denied* (priority `now` message) or handed to `claude attach` / agent view |
| Hard stop? | **Yes.** `claude stop <id>` in under 1 s kills the process and its child processes. The session resumes on the same id; the interrupted tool call is marked unfinished |
| Soft interrupt (cancel the turn, keep the process)? | **No external path found.** A `now` message doesn't cancel a running tool |
| Live transcript during tool calls? | **Yes,** within about 1–3 s, except for tool calls waiting on permission |

## Lifecycle (VERIFIED unless noted)

- `claude --bg [-n name] "prompt"` starts a session and prints a short id.
  Other commands:
  - `claude agents`: agent view (interactive).
  - `claude agents --json [--all]`: machine-readable, no TUI needed.
  - `claude attach <id>`, `claude logs <id>` (recent screen output).
  - `claude stop|kill <id>`, `claude rm <id>`, `claude respawn <id>|--all`.
- `-n` sets the registry `name`, which is shown in `agents --json`.
- **Gotcha:** `--allowedTools` takes several values in a row and swallowed
  the prompt; the session started idle. Put another flag after it, or send
  the prompt in later.
- `claude --bg --resume <sid>` with no other flags restarts the **same**
  session id. Adding flags creates a copy with a **new** id (the CLI
  prints a note).
- `attach` opens the full TUI and `←` detaches (DOCUMENTED, not tested).

## Q1 — Permission prompts

Command: `claude --bg -n bgprobe-perm --model haiku --permission-mode manual
"Use the Write tool to create hello.txt…"`

- **It blocks.** The registry showed
  `"status":"waiting","waitingFor":"permission prompt"`, and
  `agents --json` showed `"state":"blocked"`. `claude logs` showed the
  normal prompt (Yes / Yes-and-allow / No). VERIFIED
- **The pending `tool_use` isn't in the transcript while waiting.** It was
  written only when the prompt was resolved (issued 05:04:31, written
  05:06:29). Use the registry `waitingFor` field or `logs` to detect
  pending approvals, not the JSONL. VERIFIED
- **A pipe message with priority `next`** just queues (a
  `queue-operation` line); the prompt stays up. VERIFIED
- **A pipe message with priority `now` denies the pending tool** ("The
  user doesn't want to proceed with this tool use…"). The queued messages
  are then delivered and the turn finishes. **Deny-and-redirect, not
  approve.** VERIFIED
- **No approve path without a TUI:**
  - The pipe's control actions are only `notify_when_idle`,
    `peer_idle_notice`, `peer_message_status` and the `*artifact_replies*`
    family. `permission_request`/`permission_response` strings belong to
    the remote-control/teammate-mailbox bridge. INFERRED (binary strings)
  - The docs route approval through `claude attach` or agent view.
    DOCUMENTED
  - `--permission-prompts host|none` is only for `-p` mode. DOCUMENTED
- A hook fired while the session was waiting (probably a notification
  hook). INFERRED

## Q2 — Hard stop and resume

Command: `claude --bg -n bgprobe-stop2 --allowedTools "Bash(ping *)" …
"Run ping -n 90 127.0.0.1"`, then `claude stop <id>` while busy.

- **Immediate.** Under 1 s. The claude process and its child `PING.EXE`
  both exited, the registry entry was removed, and `agents --json --all`
  showed `"state":"stopped"`. The transcript ends on a `tool_use` with no
  result. VERIFIED
- **Resume** (`claude --resume <sid> -p … --model haiku`) kept the same
  session id. The loader inserted "[Tool call interrupted: the session
  ended before this call's result was recorded…]", and the model correctly
  reported the ping didn't finish. VERIFIED
- **No soft interrupt from outside:** a `now` message sent during the ping
  was delivered only after the ping finished (about 85 s later). The docs
  list Ctrl+C in the TUI, Ctrl+X in agent view, and `/stop`; there's no CLI
  `interrupt` subcommand. VERIFIED / DOCUMENTED
- Side finding: the Bash tool itself rejects a standalone `sleep 90`
  ("Blocked: standalone sleep 90"), so ping was used for the long
  command. VERIFIED

## Q3 — Live transcript

A watcher polling every second saw each `tool_use` within 1–3 s of being
issued (before its result), and each `tool_result` within about 1 s of the
command finishing. Injected messages appear immediately as
enqueue/dequeue lines. The one exception is a permission-pending tool call
(Q1). VERIFIED

## Implications for the room-TUI control point

- **Observation** works headlessly: registry `status`/`waitingFor` and the
  live JSONL (`claude agents --json` and `claude logs` as extras).
- **Approvals** are the main gap for Claude. Options:
  1. Start agents with pre-scoped `--allowedTools` or `--permission-mode`
     so they never prompt.
  2. When `waitingFor: "permission prompt"` appears, the TUI hands off to
     `claude attach <id>` for Kevin.
  3. Deny-and-redirect with a `now` message.
- **Interrupting** is either lossy (`claude stop`: the process and its
  children are killed, the tool's outcome is unknown, but the session
  resumes cleanly) or unavailable (no soft cancel).

## Safety caveats

- Anyone who can read `~/.claude/sessions` (anything running as the user)
  can inject messages into, and with `now` auto-deny tools in, **any**
  session.
- Injected text reaches the model framed as "Another Claude session sent a
  message".
- `claude rm` keeps transcripts. `claude stop` doesn't roll back a
  half-finished command.
