# vibe-pairing

A local chat room for multiple Claude Code and Codex sessions working in one repository. Run the TUI in a separate pane, watch the agents coordinate, and send one message to all of them. `@name` targets one instance. Multiple instances of either harness are supported.

Messages enter each harness through its native transport: Claude's messaging pipe or `codex queue`. An MCP server and CLI let agents reply through the room. They do not poll a model to wake it.

**Release qualification:** throwaway sessions passed 20 idle-wake trials per harness and the four-agent scenarios (two Claude, two Codex), including targeted delivery, replies across harnesses and busy recipients. Claude additionally completed a two-hour exercise with 80/80 replies. Codex busy coverage is a bounded scenario, not a two-hour soak. Initial fixture-prompt failures and successful reruns are retained in [acceptance results](probes/4.1-acceptance.md); see also [recovery qualification](probes/failure-recovery-results.md) and [progress](PROGRESS.md).

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

The first client starts the local service automatically. Each Git repository has one room, shared by its linked worktrees. To preview the interface without a service, run the same command with `tui --demo`. Add `--no-color` (or set `NO_COLOR=1`) for monochrome output.

When the agents are working in this repository itself, `npm run tui` is a shortcut from the checkout (and `npm run tui:demo` for the sample room). npm runs it from the package root, so it opens *this* repository's room by default (`ROOM_ROOT` can override that explicitly). Pass flags after `--`, e.g. `npm run tui -- --no-color`.

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
| `/layout [top\|left]`, Ctrl+B | Switch between the top bar and a left panel; the choice is remembered for this room |
| `/compact [on\|off]`, Ctrl+T | Top bar: compact lines instead of the full AGENTS / BUDGETS grid; remembered |
| `/detail #12` | Inspect delivery attempts and errors |
| `/pause` | Hold future deliveries and send a stop request |
| `/resume` | Release held deliveries in order |
| `/restart` | Confirm a graceful service restart; the TUI reconnects |
| `/retry #12 @name` | Inspect and explicitly retry a failed/uncertain delivery |
| Esc | Clear the draft; does not interrupt an agent |
| `/help` | Show controls and commands |

MVP displays room messages, delivery states and usage when available. Full harness output and tool streams are later work. Unknown or unavailable observations are labelled rather than presented as zero or offline.

Pause is **a delivery hold plus a stop request**, not a forced interrupt. A busy Codex session sees that request after its current turn. Leaving the TUI does not stop the agents or erase the room.

## Plan usage

The top bar (or the left panel: `/layout`) shows each agent as a chip (status, context usage, model and branch), and below that the subscription usage for each account, shown once per account and never summed across agents: the **5h** and **weekly** windows with reset times, plus any model-specific weekly limit Claude reports (e.g. **Fable weekly**). A value the provider doesn't report shows as `—`, never `0`; an old or failed reading is marked `(stale)`; a missing source says why.

The top bar has two labelled sections: **AGENTS**, one aligned row per agent (state, context, model, branch), and **BUDGETS**, a grid with the `5h` / `weekly` columns named once, one row per limit (e.g. Claude, Fable, Codex), and reset times and caveats in their own columns. Readings use ccstatusline's 10-cell `slider` bars (e.g. `▓▓▓▓░░░░░░ 38.0%`). Bars are coloured by level: green under 70%, amber 70–90%, red above 90%. A reading at 70% or more also gets a bold `!`, so nothing depends on colour alone (`--no-color` / `NO_COLOR` keep the bars, numbers and markers). A missing value is `—`, never `0`. When the terminal is too narrow for the grid, bars become plain percentages and then the bar wraps. On a short terminal, or while help or `/who` is open, the top bar uses compact lines.

- **Codex:** read-only from the running Codex daemon (`account/rateLimits/read`). No credentials or auth files are read. Codex currently reports only a weekly window, so its 5h shows `n/a`.
- **Claude:** sources are tried cheapest first, and the first with a reading wins.
  1. **ccstatusline's cache** (recommended; no credentials, no extra calls; used only for the default Claude profile).
     It is one shared file written by whichever ccstatusline ran last, so the login it reflects is not verified (the room
     records that, but doesn't repeat it on screen). If your statusline is
     [ccstatusline](https://github.com/sirmalloc/ccstatusline), it already fetches plan usage (5h, weekly and
     model-specific limits such as Fable) and caches the numbers in `~/.cache/ccstatusline/usage.json`. The room just
     reads that file. When no Claude session is rendering a statusline, the file ages and is shown `(stale)`.
  2. **Usage endpoint (opt-in):** set `ROOM_CLAUDE_USAGE_API=on`.
     - The room service reads your Claude Code login token from `<claude config>/.credentials.json` per request,
       holds it only in memory, sends it only to `api.anthropic.com/api/oauth/usage`, and never stores, logs or
       refreshes it.
     - Calls are throttled like ccstatusline: roughly one every 5 minutes per profile, coordinated between room
       services through a shared cache and a short reservation file (best effort, not a strict guarantee). After a 429
       it backs off for Retry-After (else 5 minutes).
     - It's an undocumented endpoint, so it may change.
  3. **Statusline tap (no credentials):** wrap any statusline command, e.g.
     `"command": "node <vibe-pairing>/dist/cli/main.js statusline-tap -- npx ccstatusline"`. It stores only each
     limit's percentage and reset time, and has no model-specific limits.

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
| `ROOM_HUMAN_NAME` | Human display name in the TUI (default: Kevin) |
| `ROOM_ROOT` | Explicit shared room root, useful for nonstandard checkouts |
| `ROOM_CODEX_EXECUTABLE` | Native Codex executable when PATH lookup is unsuitable; no shell wrapper |
| `ROOM_CODEX_HOME` | Non-default Codex home used by the service |
| `ROOM_CLAUDE_CONFIG_DIR` | Non-default Claude configuration directory |
| `ROOM_TUI_LAYOUT` | Starting layout, `top` (default) or `left`; a choice made with `/layout` (saved in `.room/tui.json`) or `room tui --layout` wins |

Human-only controls are a **trusted-local workflow guardrail**, not authentication against hostile
processes running as your OS user. The CLI detects agent session environment/ancestry, MCP clients
cannot invoke human controls, and the TUI represents you. Custom same-user IPC clients can spoof those
claims; this design does not provide user isolation or protect the service from that OS user's tools.

`ROOM_TUI_*` controls layout, history and reconnect behavior. Other tunables are documented in [configuration source](src/core/config.ts). Service settings take effect when the service starts. After updating code, relaunch the TUI to load its changes, then use `/restart` to reload the service. From a human terminal, `room shutdown` stops that room's service; a later client starts it again. `room migrate` backs up and converts the project's known legacy registry format without changing its two session identities.

## Development

```powershell
npm test
```

Tests cover native transport fixtures, persistence, independent process recovery, identity, CLI/MCP and TUI behavior. Live probes use explicitly owned disposable sessions; never substitute a working agent's ID. See [design](DESIGN.md), [roadmap](ROADMAP.md), [review policy](.agents/skills/local-code-review/SKILL.md), and [onboarding](docs/ONBOARDING.md).
