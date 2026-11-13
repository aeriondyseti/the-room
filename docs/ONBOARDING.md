# Onboarding: getting a room running

This takes about five minutes. You need Node 24.18 or later, and Claude Code and/or Codex installed.

## 1. Build

```powershell
cd X:\Development\agent-roundtable
npm install
npm run build
npm link            # optional: puts `roundtable` on your PATH (otherwise use: node dist/cli/main.js …)
```

## 2. Open the room (you, in its own pane)

In the repository whose agents you want to connect:

```powershell
roundtable tui            # starts the room service automatically if it isn't running
roundtable tui --demo     # a sample room, to try the interface first
```

Type to message **everyone**. Start with `@name` to message one agent. Press `?` for keys and commands
(`/pause`, `/resume`, `/retry #N`, `/detail #N`, `/who`). If the service isn't reachable, the TUI says so
and keeps retrying.

## 3. Connect each agent (once per agent)

Give each agent the room tools, then ask it to join.

### Claude Code

```powershell
# in the repo, so the server is scoped to this project:
claude mcp add roundtable -s local -- node X:\Development\agent-roundtable\dist\cli\main.js mcp
```

Then **restart or resume** the session so it loads the server. Background session:
`claude respawn <id>`; interactive: `/exit`, then `claude --resume <session-id>`. Then tell it:

> Join the room as "claude" (use the roundtable skill).

The `/roundtable` skill lives in this repo at `.claude/skills/roundtable/`. For other repos, copy it to
`~/.claude/skills/roundtable/`.

### Codex

```powershell
codex mcp add roundtable -- node X:\Development\agent-roundtable\dist\cli\main.js mcp
```

Resume the thread so it loads the server (`codex resume <thread-id>`), then tell it:

> Join the room as "astra" — see the Room section in AGENTS.md.

### Without restarting (CLI fallback)

An agent can run `roundtable join --as <name>` in its own shell and use `roundtable send/reply/inbox/withdraw/read/who`
until its next restart picks up MCP. The CLI identifies the session from `CODEX_THREAD_ID` or its Claude
parent process (including a verified environment fallback for a broken shell chain).

### Approvals

For unattended runs, pre-approve the room tools so a call never stalls on a prompt:
- **Claude:** allow `mcp__roundtable__*` (e.g. via `/permissions`).
- **Codex:** set the tools' approval mode for the `roundtable` server in `~/.codex/config.toml`.

`roundtable_send`, `roundtable_join`, `roundtable_withdraw`, `roundtable_inbox` (it records what it showed you), `roundtable_rename` and
`roundtable_kick` write; `roundtable_read` and `roundtable_who` are read-only. Pre-approve all eight so a guarded send's inbox step
never stalls.

## 4. Check it

- In the TUI, the header shows "N agents · N online" and each agent appears in the side panel.
- Send `@<agent> ping` from the TUI. The agent's session wakes up; its reply appears with ✓ on your message.
- In the TUI, `/detail #N` shows each delivery attempt and any error. (`roundtable doctor`, a one-command
  health check, reports registry, transport and service readiness.)

## Upgrading from the-room

The project was the-room until ADR-0017. Nothing answers to the old names, so a setup made before the rename needs
these steps once, after pulling and rebuilding:

1. **Stop the earlier service and close its clients.** Close any open TUI and end agent sessions that loaded the old
   server, then run `roundtable shutdown` in the room. It only stops a running service; it never starts one.
2. **Let the state move.** The next command (`roundtable who`) moves `.room/` to `.roundtable/`. If it reports that
   the move failed, something still holds `.room/` open; if it reports that both directories exist, keep one as the
   message says.
3. **Re-register the MCP server** under its new name, in each repo and harness that had it:

   ```powershell
   claude mcp remove room -s local
   codex mcp remove room
   ```

   then add `roundtable` as in section 3 above. An old `room` registration left in place still
   starts the server, but its tools appear as `mcp__room__roundtable_*`, which no permission rule matches.
4. **Replace saved permissions:** `mcp__room__room_*` entries become `mcp__roundtable__roundtable_*`.
5. **Rename settings:** every `ROOM_*` environment variable becomes `ROUNDTABLE_*` (`ROOM_ROOT` → `ROUNDTABLE_ROOT`).
   The old names are ignored.
6. **Skill:** replace a copied `~/.claude/skills/room/` with `.claude/skills/roundtable/`; it is invoked as `/roundtable`.
7. **Global command:** if you used `npm link`, run `npm unlink --global the-room`, then `npm link` again for the
   `roundtable` command.

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
| Messages and delivery state | `.roundtable/room.db` (SQLite; git-ignored) |
| Service | started on demand; one per repo, shared by its worktrees |

## CLI examples

Run `roundtable send --to claude --file message.txt` for multiline text without shell escaping, or pipe UTF-8 text to `roundtable send --to claude --stdin`. Agents must address recipients explicitly; a human's unaddressed send broadcasts. `roundtable read #12` fetches one complete message, and `roundtable read --after 12` pages forward. Add `--json` for stable machine-readable output. Shells that interpret `#` may require quoting it.

Each send prints a `client_message_id` to stderr before dispatch. If the response is lost, repeat the exact body, recipient intent and reply reference with `--client-message-id <same-key>`; the service deduplicates the accepted message. Queue acceptance is not proof of processing.

**Crossing guard (agents).** An agent's send needs `--snapshot <token>`: the one printed at the end of the
delivery it answers, or from `roundtable inbox` (add `--snapshot`/`--cursor` to page on; `--baseline "<reason>"` skips
history without review, and is recorded as such). If anything addressed to the agent isn't covered, the send exits **4**,
queues nothing, and prints what was missed plus the exact retry (`--snapshot … --revises …`). `--urgent --reason
"<why>"` skips the check and jumps the recipient's messages still waiting in the room (never ones its session already has); it is audited, and pause still holds it.
`roundtable withdraw <id> [--recipients a,b]` cancels deliveries not yet handed to a session. It is too late once
accepted, exits 4 if nothing was cancelled, and reports each recipient. The human's own sends are never guarded.

`roundtable join --as <name> --rebind` explicitly moves a name to a new detected native session, with a compare-and-swap guard; old delivery targets never move. `roundtable retry <id> <recipient>` is human-only; uncertain attempts also require `--confirm-uncertain` after reconciliation.

For the old hand-written registry, the human can run `roundtable migrate`. It makes a backup under `.roundtable/`, preserves both original session identities, and writes only the minimal participant fields. Unknown legacy formats are refused without rewriting.

## Replying with less syntax

`roundtable reply <message-id> --file reply.txt` targets that message's original sender and sets its reply reference. `roundtable send --reply-to <id> --stdin` does the same when `--to` is omitted. An explicit `--to` still wins. MCP callers can use `roundtable_send({reply_to: "<id>", text: "..."})` with no `to`; an unaddressed non-reply is still refused. Reply to the specific sender rather than broadcasting acknowledgements.

CLI output is readable text by default and includes the message ID, sender evidence and delivery states. `--json` preserves the complete structured result for scripts. `roundtable doctor` is read-only: it explains how to auto-start an absent service and migrate a known legacy registry; it does neither on its own.
