# pair-poc — throwaway messaging MCP for Claude ↔ Astra

A **proof of concept** so the agents on this project (Claude and Astra) can
message each other, and Kevin can watch and direct them, before the real
room from [proposal.md](../proposal.md) exists. It is not the room
implementation.

Dynamic values are hard-coded in [`participants.json`](participants.json):
session ids and the Codex executable path. Edit that file if a session is
restarted with a new id.

## What it does

- **`send_message({to, text, reply_to?})`** — `to` is a participant name,
  a comma-separated list, or `all`.
  - Logs the message to `<repo>/.room-poc/log.jsonl`, then delivers it
    natively so the recipient wakes up:
    - **Codex** (Astra): `codex queue --thread <id> --message <envelope>`,
      passed as an argument array, so quoting is safe. The limit is 24,000
      characters.
    - **Claude**: auth and user frames written to the session's messaging
      pipe, looked up by `session_id` in `~/.claude/sessions` at send time.
  - The envelope header reads `[pair-poc #<id> from=… to=… reply_to=…]`.
    Messages from Kevin are marked `USER DIRECTIVE`.
- **`read_log({limit?, include_deliveries?})`** — recent room messages.
- **`participants()`** — names, harnesses, and Claude liveness.

Identity is baked in per registration with `--as <name>`. There's no
verification — this is a trusted local POC.

## Install (one time)

Run from `X:\Development\the-room`, **after this branch is merged into
`main`**, so the paths below exist in the main checkout:

```powershell
# Claude Code (local scope = this project only, for this user)
claude mcp add pair-poc -s local -- node X:\Development\the-room\poc\pair-mcp.mjs --as claude

# Codex (user config; the --as value binds the sender name)
codex mcp add pair-poc -- node X:\Development\the-room\poc\pair-mcp.mjs --as astra
```

Then **resume** each agent session so it loads the server (Claude:
`claude --resume <session_id>`; Codex: `codex resume <thread_id>`). For
unattended overnight use, pre-approve the tools so calls don't stall on a
prompt:
- **Claude:** add `mcp__pair-poc__*` to the allowed tools (e.g. via
  `/permissions`).
- **Codex:** set the approval mode for the `pair-poc` server's tools in
  `~/.codex/config.toml` (see the Codex MCP docs on
  `default_tools_approval_mode` / per-tool `approval_mode`).

## For Kevin

```powershell
node poc\watch.mjs                 # live conversation view (run in its own pane)
node poc\say.mjs Plan the next step       # message both agents at once
node poc\say.mjs @astra Review Claude's probe  # message one agent
```

## Tested (2026-09-28, Claude Code 2.1.283, Codex 0.157.1)

- MCP stdio handshake and `tools/list`.
- `participants`, and unknown-recipient rejection.
- Claude delivery via pipe, with multiline text, quotes, backticks, `$` and
  Unicode arriving intact.
- `read_log` and `watch.mjs` rendering.
- Codex delivery via `codex queue`, verified with the first real message
  to Astra.

## Limits

- Per-recipient deliveries run sequentially.
- There's no retry, dedup, or ledger. A failed delivery is logged as `✗`
  and must be resent by hand.
- Codex only processes queued messages while its thread is open in a TUI.
- A Claude message goes to the session id in `participants.json`. If that
  session is gone, delivery fails with `no live Claude session`.
