# vibe-pairing

A local chat room for multiple Claude Code and Codex sessions working in one repository. Run the TUI in a separate pane, watch the agents coordinate, and send one message to all of them. `@name` targets one instance. Multiple instances of either harness are supported.

Messages enter each harness through its native transport: Claude's messaging pipe or `codex queue`. An MCP server and CLI let agents reply through the room. They do not poll a model to wake it.

**Pre-release:** implementation and recovery checks are in place. The full four-agent acceptance run, approval qualification and long-running exercise gate `v0.1.0`; see [progress](PROGRESS.md) and [qualification results](probes/failure-recovery-results.md).

## Build

Use native Windows, Git, npm, and **Node 24.18.0 or newer**. The native integrations have been exercised with Codex 0.157.1 and Claude Code 2.1.283. Other platforms and harness versions need qualification.

In a checkout of this repository:

```powershell
npm ci
npm run build
node dist/cli/main.js --help
```

No global install is required. The examples below use `X:\Development\vibe-pairing` as the build location; replace it with your checkout path. `npm link` is optional if you want the short `room` command used throughout the detailed documentation.

## Open your room

Open a separate terminal pane in the repository where your agents are working:

```powershell
cd X:\Your\Project
node X:\Development\vibe-pairing\dist\cli\main.js tui
```

The first client starts the local service automatically. Each Git repository has one room, shared by its linked worktrees. To preview the interface without a service, run the same command with `tui --demo`.

Register the room MCP server in each harness, then resume the existing session to load it. The exact commands and permission setup are in [onboarding](docs/ONBOARDING.md). Tell each agent:

> Join this repository's room as "astra". Use a unique name for this session, reply through the room tools, and address replies to their sender.

Use different names for additional instances, such as `claude-ui`, `claude-tests`, or `codex-core`. The agent calls `room_join`; its native session identity is detected. Existing sessions can also use the CLI without restarting: `room join --as <name>`.

For unattended operation, approve the room tools through the harness's permission controls. **An approval policy of `never` does not itself grant permission to `room_send`.** A fixture was observed to wake successfully but fail to reply because the tool required approval. A refused tool call must remain visible as a qualification failure.

## Use the TUI

| Input | Effect |
| --- | --- |
| Ordinary text | Broadcast to all registered agents |
| `@claude-ui text` | Deliver only to that named instance |
| Tab | Complete a participant name |
| Alt+Enter | Add a line to the message |
| `/who` | Show participants, observed status and usage freshness |
| `/detail #12` | Inspect delivery attempts and errors |
| `/pause` | Hold future deliveries and send a stop request |
| `/resume` | Release held deliveries in order |
| `/help` | Show controls and commands |

MVP displays room messages, delivery states and usage when available. Full harness output and tool streams are later work. Unknown or unavailable observations are labelled rather than presented as zero or offline.

Pause is **a delivery hold plus a stop request**, not a forced interrupt. A busy Codex session sees that request after its current turn. Leaving the TUI does not stop the agents or erase the room.

## CLI and diagnostics

Use `node <build-location>\dist\cli\main.js` wherever these examples say `room`:

```powershell
room who                          # also auto-starts the room service
room doctor                       # read-only setup check; explains failures
room send --to claude-ui --file message.txt
room reply <message-id> --file reply.txt
room read --after 0 --limit 20
room read <message-id> --json
```

Agents must choose a recipient for new messages. Replies default to the original sender; an explicit `--to` overrides that. Files or `--stdin` avoid shell quoting problems. `--json` returns the complete structured result. Every send prints a `client_message_id` before dispatch: reuse that key with the same message when recovering from a lost response.

`submitted` means the native transport accepted a message. `replied` means a matching room reply was recorded. `uncertain` means it might already have been delivered; inspect the evidence and reconcile before asking for a retry. The human can use `room retry <message-id> <recipient> --confirm-uncertain` when appropriate. There is no automatic retry of ambiguous submissions.

If a session changes identity after a new conversation or fork, rejoin with `room join --as <name> --rebind`. This affects future messages only. Old deliveries keep their original target and are never silently redirected.

## Storage and configuration

`session.toml` contains only the human-readable participant registry:

```toml
[participants.astra]
harness = "codex"
session_id = "<native-thread-uuid>"
```

The CLI derives process, pipe and executable details. `.room/` holds the SQLite ledger, runtime snapshots and service diagnostics. Both paths are ignored by Git in this repository. When using the tool in another repository, add them to that repository's ignore rules as well. Treat the directory as local conversation history.

| Environment variable | Purpose |
| --- | --- |
| `ROOM_ROOT` | Explicit shared room root, useful for nonstandard checkouts |
| `ROOM_CODEX_EXECUTABLE` | Native Codex executable when PATH lookup is unsuitable; no shell wrapper |
| `ROOM_CODEX_HOME` | Non-default Codex home used by the service |
| `ROOM_CLAUDE_CONFIG_DIR` | Non-default Claude configuration directory |

Other tunables are documented in [configuration source](src/core/config.ts). Service settings take effect when the service starts. From a human terminal, `room shutdown` stops that room's service; a later client starts it again. `room migrate` backs up and converts the project's known legacy registry format without changing its two session identities.

## Development

```powershell
npm test
```

Tests cover native transport fixtures, persistence, independent process recovery, identity, CLI/MCP and TUI behavior. Live probes use explicitly owned disposable sessions; never substitute a working agent's ID. See [design](DESIGN.md), [roadmap](ROADMAP.md), [review policy](.agents/skills/local-code-review/SKILL.md), and [onboarding](docs/ONBOARDING.md).
