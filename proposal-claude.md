# the-room — proposal (Claude)

A greatly simplified successor to claudex-pair: a real-time chat room where
multiple coding agents in the same repo coordinate with each other, and the
user oversees and directs them.

Status: **proposal only — no code yet.** Revised 2026-09-27: both idle-wake
paths are now **verified**. See
[findings-claude-messaging.md](findings-claude-messaging.md) and
[findings-codex-messaging.md](findings-codex-messaging.md).

## 1. The problem

claudex-pair's wake mechanism is model-driven: every agent must keep a
listener armed (fused `pair send` → wait, re-arm after each timeout). Its own
docs (`docs/ENHANCEMENTS.md` U3) call re-arming "still a remembering
problem." Whenever a model ends its turn without re-arming, nothing wakes it
until a human types. A Claude `Stop` hook was proposed but never built, and
the broker's IPC sockets dropped fused sends mid-session
(`docs/PEER-MODEL.md`).

**Design rule: the model is never responsible for waking itself.** Wake-ups
come from harness mechanisms that fire regardless of model discipline. Both
harnesses have native inter-session messaging, and the-room uses it
directly.

## 2. Wake mechanisms per harness

| | Idle → start a turn | Busy → deliver promptly | Trying to stop |
|---|---|---|---|
| **Claude Code** | **Native pipe push (VERIFIED):** write `{"type":"auth",…}` + `{"type":"user",…,"priority":"next"}` to the session's `\\.\pipe\LOCAL\cc-msg-*`. The session starts a turn. | `PostToolUse` hook adds unread messages as `additionalContext`. A pipe message with `next` priority also arrives between tool calls. | `Stop` hook: unread messages → `{"decision":"block","reason":<messages>}` |
| **Codex 0.157** | **`codex queue --thread <id> --message …` (VERIFIED):** an idle TUI starts a turn in 2.5–8 s | `PostToolUse` hook, `additionalContext`. (`codex queue` alone waits until the turn ends.) | `stop` hook, `{"decision":"block","reason":…}` (DOCUMENTED) |
| **agy (optional)** | when-idle queue / `stream-json` (unverified) | `hooks.json` | `hooks.json` |

**Fallbacks**, used only if a primary path breaks:
- **Claude:** Channels (a supported MCP push, but it needs
  `--dangerously-load-development-channels` at launch) and
  `asyncRewake` hooks.
- **Codex:** `turn/start` / `turn/steer` JSON-RPC over the app-server socket.
- **Both:** a PTY-injection wrapper as a last resort. It is no longer
  expected to be needed.

Hooks read the log file directly, so if the dispatcher is down you lose only
idle push, never messages.

## 3. Architecture

Deliberately small. No broker, no turn token, no driver/navigator roles, no
grants.

- **`.room/log.jsonl`** — append-only source of truth:
  `{seq, ts, from, to, text, kind}`. Appends take a lock file.
- **`.room/cursors/<name>`** — last `seq` delivered to each agent.
- **`.room/agents/<name>.json`** — presence and wake address:
  - `harness`, `state` (`busy` / `idle` / `paused`), status line, last seen,
  - Claude: `pid`, `sessionId`, `messagingSocketPath`,
  - Codex: `threadId`.
- **`room` CLI** (Node, zero dependencies): `up`, `send`, `read`, `who`,
  `status`, `claim`, `release`, `serve`, `hook <event>`.
- **Root discovery:** walk up to `.room/`; else the parent of
  `git rev-parse --git-common-dir`, so worktree agents share the room;
  `ROOM_DIR` overrides.
- **Launcher = identity:**
  - `room up claude --as alice` sets `ROOM_AS=alice` and starts
    `claude --name room-alice`.
  - `room up codex --as bob` sets `ROOM_AS=bob` and starts `codex`.
  - The agent's first hook call registers its wake address:
    - Claude: look up its own pid entry in `~/.claude/sessions/`.
    - Codex: `CODEX_THREAD_ID` (or the hook's `session_id`).
- **`room serve` (dispatcher)** — tails the log and, for each new message
  addressed to an agent, calls that agent's wake adapter:
  - `claude-pipe`: reads `~/.claude/sessions/<pid>.json` and the sibling
    `.key`, then writes the auth line plus a `user` frame. Only a short
    notice is sent (e.g. "3 new room messages from user, bob — run
    `room read`"). Hooks and `room read` carry the real content, so the
    cursor stays the only delivery ledger.
  - `codex-queue`: `codex queue --thread <id> --message "<same notice>"`.
  - **Coalesce:** at most one pending wake per agent, cleared when its
    cursor advances. Never push to an agent whose `state` is `busy`; the
    hooks cover busy agents.
- **Delivery semantics:** delivered = cursor advanced (by a hook injection
  or by `room read`). Pushes are only doorbells, so a duplicated or lost
  push is harmless.
- **Addressing:** broadcast by default; `@name` or `--to` targets. Everything
  is visible to everyone, but only addressed messages ring an agent's
  doorbell.

## 4. User oversight and direction

- **Web UI** (served by `room serve` on localhost): live chat via SSE, an
  input box, and a presence panel per agent (state, current status, unread
  count, last activity, claims).
- **User messages are directives:** injected as `[USER DIRECTIVE]`. They
  ring the doorbell even when the agent is busy (Claude pipe priority `now`)
  and appear at the agent's next tool call.
- **Enforced control:**
  - `/pause @alice` — alice's `PreToolUse` hook denies tool calls with
    "paused by user" until `/resume @alice`.
  - `/stop @alice` — a directive to wrap up now; the `Stop` hook then lets
    alice go idle.
- **Advisory file claims:** `room claim src/x.ts`. The `PreToolUse` hook on
  edit tools warns (configurable: blocks) on another agent's claim.

## 5. Milestones

0. **Remaining spikes (short):**
   - Claude `Stop`-hook block: confirm continuation and the
     `stop_hook_active` loop guard.
   - Priority `now` behaviour on a busy Claude session.
   - Codex `PostToolUse` `additionalContext` delivery, observed live.
   - (Optional) `turn/steer` or `turn/start` to cut Codex latency below
     `codex queue`'s 2.5–8 s.
1. **Core + Claude:** log, CLI, launcher, Claude hooks, and the `claude-pipe`
   adapter. Two Claude agents coordinate with no manual waking.
2. **Codex:** hooks plus the `codex-queue` adapter.
3. **User web UI + dispatcher.**
4. **Oversight controls:** pause/stop/resume and claims.
5. **agy (optional).**

## 6. Acceptance test

The one test that matters, run for every harness:

> Agent finishes its work and sits idle. User posts `@agent do X` from the
> web UI. The agent starts a turn with no human keystroke in its terminal:
> within **5 s** for Claude and **10 s** for Codex (because `codex queue`
> polls).

Must pass **20/20** and survive a 2-hour session. Secondary checks:
- a busy agent sees a user directive within one tool call;
- a paused agent's next tool call is denied;
- killing `room serve` loses no messages (hooks still deliver, and the
  backlog rings once the dispatcher restarts).

## 7. Risks

| Risk | Mitigation |
|---|---|
| The Claude pipe protocol (`.key` file and `user` frame) is internal and may change in any release | Isolate it in the `claude-pipe` adapter. Keep a captured-frame test and a `room doctor` smoke test to run after each Claude Code upgrade. Fall back to Channels + `Stop` hook. |
| Receivers without `crossSessionInbound: "accept"` hold peer messages for approval | `room up` checks the setting and warns. (It's `"accept"` in the user's config today.) |
| `codex queue` runs only while the thread is open in a TUI | Expected: a closed agent picks up its backlog when resumed. The presence panel shows it as offline. |
| Doorbell storms | Coalesce: one pending wake per agent. Claude pipe limit is 50 queued messages. |

## 8. Open decisions

1. **Park mode:** now optional. The native push reliably wakes idle agents,
   so the recommendation is to let agents go idle and rely on push, not hold
   them in a `Stop` hook.
2. **Home:** a new repo here plus a new `/room` skill, leaving claudex-pair
   untouched (assumed).
3. **Reuse `claude-message-mcp`?** Import its registry and pipe code
   (`src/registry.js`, `src/protocol.js`) as the `claude-pipe` adapter, or
   reimplement the roughly 20-line sender? The recommendation is to
   reimplement the small sender and borrow its captured-frame tests.

## Evidence base

- [findings-claude-messaging.md](findings-claude-messaging.md) — pipe
  injection verified on a throwaway session (idle → PONG; busy → queued).
- [findings-codex-messaging.md](findings-codex-messaging.md) — `codex queue`
  verified (idle TUI → turn in 2.5–8 s; busy → next turn).
- `X:\Development\claude-message-mcp` — prior art for the Claude pipe
  protocol (captured at 2.1.282).
- claudex-pair: `PROTOCOL.md`, `docs/ENHANCEMENTS.md` (U3),
  `docs/PEER-MODEL.md`, `.pair/memory.md`.
- Installed CLIs: Claude Code 2.1.283, codex-cli 0.157.1, agy 1.2.12.
