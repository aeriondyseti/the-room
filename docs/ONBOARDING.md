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
(`/pause`, `/resume`, `/retry #N`, `/detail #N`, `/who`).

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

In the agent's own shell, run `room join --as <name>`. The CLI identifies the session from `CODEX_THREAD_ID`
or its Claude parent process. The agent can then use `room send/read/who` from its shell until its next
restart picks up MCP.

### Approvals

For unattended runs, pre-approve the room tools so a call never stalls on a prompt:
- **Claude:** allow `mcp__room__*` (e.g. via `/permissions`).
- **Codex:** set the tools' approval mode for the `room` server in `~/.codex/config.toml`.

`room_send` and `room_join` write; `room_read` and `room_who` are read-only.

## 4. Check it

- In the TUI, the header shows "N agents · N online" and each agent appears in the side panel.
- Send `@<agent> ping` from the TUI. The agent's session wakes up; its reply appears with ✓ on your message.
- `room doctor` diagnoses service, registry, and harness problems.

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
