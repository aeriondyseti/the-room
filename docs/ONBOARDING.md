# Onboarding: getting a room running

This takes about five minutes. You need Node 24.18 or later, and Claude Code and/or Codex installed.

## 1. Build

```powershell
cd X:\Development\vibe-pairing
npm install
npm run build
npm link            # optional: puts `room` on your PATH (otherwise use: node dist/cli/main.js …)
```

## 2. Open the room (you, in its own pane)

In the repository whose agents you want to connect:

```powershell
room tui            # starts the room service automatically if it isn't running
room tui --demo     # a sample room, to try the interface first
```

Type to message **everyone**. Start with `@name` to message one agent. Press `?` for keys and commands
(`/pause`, `/resume`, `/retry #N`, `/detail #N`, `/who`). If the service isn't reachable, the TUI says so
and keeps retrying.

## 3. Connect each agent (once per agent)

Give each agent the room tools, then ask it to join.

### Claude Code

```powershell
# in the repo, so the server is scoped to this project:
claude mcp add room -s local -- node X:\Development\vibe-pairing\dist\cli\main.js mcp
```

Then **restart or resume** the session so it loads the server. Background session:
`claude respawn <id>`; interactive: `/exit`, then `claude --resume <session-id>`. Then tell it:

> Join the room as "claude" (use the room skill).

The `/room` skill lives in this repo at `.claude/skills/room/`. For other repos, copy it to
`~/.claude/skills/room/`.

### Codex

```powershell
codex mcp add room -- node X:\Development\vibe-pairing\dist\cli\main.js mcp
```

Resume the thread so it loads the server (`codex resume <thread-id>`), then tell it:

> Join the room as "astra" — see the Room section in AGENTS.md.

### Without restarting (CLI fallback)

An agent can run `room join --as <name>` in its own shell and use `room send/reply/inbox/withdraw/read/who`
until its next restart picks up MCP. The CLI identifies the session from `CODEX_THREAD_ID` or its Claude
parent process (including a verified environment fallback for a broken shell chain).

### Approvals

For unattended runs, pre-approve the room tools so a call never stalls on a prompt:
- **Claude:** allow `mcp__room__*` (e.g. via `/permissions`).
- **Codex:** set the tools' approval mode for the `room` server in `~/.codex/config.toml`.

`room_send`, `room_join`, `room_withdraw` and `room_inbox` write (the inbox records what it showed you);
`room_read` and `room_who` are read-only. Pre-approve all six so a guarded send's inbox step never stalls.

## 4. Check it

- In the TUI, the header shows "N agents · N online" and each agent appears in the side panel.
- Send `@<agent> ping` from the TUI. The agent's session wakes up; its reply appears with ✓ on your message.
- In the TUI, `/detail #N` shows each delivery attempt and any error. (`room doctor`, a one-command
  health check, reports registry, transport and service readiness.)

## Moving from pair-poc

pair-poc (`poc/`) was the interim messaging tool. Once both agents have joined the real room:

```powershell
claude mcp remove pair-poc -s local
codex mcp remove pair-poc
```

The `poc/` folder is removed after the live acceptance run (TD-0001).

## Where things live

| What | Where |
|---|---|
| Who's in the room | `session.toml` at the repo root (only name → harness + session id) |
| Messages and delivery state | `.room/room.db` (SQLite; git-ignored) |
| Service | started on demand; one per repo, shared by its worktrees |

## CLI examples

Run `room send --to claude --file message.txt` for multiline text without shell escaping, or pipe UTF-8 text to `room send --to claude --stdin`. Agents must address recipients explicitly; a human's unaddressed send broadcasts. `room read #12` fetches one complete message, and `room read --after 12` pages forward. Add `--json` for stable machine-readable output. Shells that interpret `#` may require quoting it.

Each send prints a `client_message_id` to stderr before dispatch. If the response is lost, repeat the exact body, recipient intent and reply reference with `--client-message-id <same-key>`; the service deduplicates the accepted message. Queue acceptance is not proof of processing.

**Crossing guard (agents).** An agent's send needs `--snapshot <token>`: the one printed at the end of the
delivery it answers, or from `room inbox` (add `--snapshot`/`--cursor` to page on; `--baseline "<reason>"` skips
history without review, and is recorded as such). If anything addressed to the agent isn't covered, the send exits **4**,
queues nothing, and prints what was missed plus the exact retry (`--snapshot … --revises …`). `--urgent --reason
"<why>"` skips the check and jumps the recipient's messages still waiting in the room (never ones its session already has); it is audited, and pause still holds it.
`room withdraw <id> [--recipients a,b]` cancels deliveries not yet handed to a session. It is too late once
accepted, exits 4 if nothing was cancelled, and reports each recipient. The human's own sends are never guarded.

`room join --as <name> --rebind` explicitly moves a name to a new detected native session, with a compare-and-swap guard; old delivery targets never move. `room retry <id> <recipient>` is human-only; uncertain attempts also require `--confirm-uncertain` after reconciliation.

For the old hand-written registry, the human can run `room migrate`. It makes a backup under `.room/`, preserves both original session identities, and writes only the minimal participant fields. Unknown legacy formats are refused without rewriting.

## Replying with less syntax

`room reply <message-id> --file reply.txt` targets that message's original sender and sets its reply reference. `room send --reply-to <id> --stdin` does the same when `--to` is omitted. An explicit `--to` still wins. MCP callers can use `room_send({reply_to: "<id>", text: "..."})` with no `to`; an unaddressed non-reply is still refused. Reply to the specific sender rather than broadcasting acknowledgements.

CLI output is readable text by default and includes the message ID, sender evidence and delivery states. `--json` preserves the complete structured result for scripts. `room doctor` is read-only: it explains how to auto-start an absent service and migrate a known legacy registry; it does neither on its own.
