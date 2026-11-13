# agent-roundtable: design

What is true now, edited in place. Invariants are rules: they live in `AGENTS.md`, not here. Decisions made during
the build are records in `docs/decisions/`. The pre-build reasoning, section by section, is in the reconciled
proposal (`git show v0.9.0:proposal.md`) and its reconciliation review
(`git show v0.9.0:claude-reconciliation.md`).

## Purpose

Kevin runs several coding agents (Claude Code and Codex sessions) in the same repository and wants them to
coordinate like a chat room that he can watch and direct from one terminal pane. The earlier system, claudex-pair,
failed because agents had to keep a listener armed and simply went idle.

**North star:** an addressed message reliably causes the recipient's harness to take a turn, through the harness's
own native messaging, and the model is **never** responsible for waking itself. Kevin sends one message to every
agent at once, watches the conversation and delivery state in a polished TUI, and can pause the room.

## Scope

In:
- **Harnesses:** Claude Code and Codex, including several instances of each. Agents attach from sessions that are
  already running.
- **Registration:** agents self-register with `roundtable join` (CLI) or `roundtable_join` (MCP) into the repo-root
  `session.toml`. Each `[participants.<name>]` holds **only** `harness` and `session_id`.
- **One room service per repo:** SQLite ledger, local named-pipe IPC, single owner, auto-started detached by any
  client. Linked worktrees share their repository's room.
- **Native delivery:** Claude through the session's messaging pipe; Codex through `codex queue` with an argument
  array. A full message envelope; oversized messages get a bounded preview plus a `roundtable read <id>` reference.
- **Agent access:** MCP tools (preferred) and a CLI fallback, with per-call caller identity.
- **Ink TUI in its own pane:** room messages, broadcast by default and `@name` to target; participant state, usage
  and workspace; per-recipient delivery detail; `/pause` and `/resume`; the activity view of each agent's tool calls.
- **Read-only observers:** Claude JSONL `usage` and Codex `token_count`, subscription usage per account, workspace
  (model, cwd, git), transcripts for the activity view.
- **Onboarding:** a `/roundtable` skill for Claude (`.claude/skills/roundtable/SKILL.md`) and the Room section of `AGENTS.md`
  for Codex, plus the install recipe in `operations.md`.

Out:
- launching agents, and background agents (an open task, not yet built);
- steering, hard stop and approval relay;
- recalling a message the harness has already accepted;
- web UI, agy, plugin distribution, file claims.

The qualified platform is native Windows. Other platforms and harness versions need qualification.

## Public API

Versions (semver, see `AGENTS.md`) are measured against these surfaces; breaking any of them is a breaking change:

- **The MCP tools** agents call: `roundtable_join`, `roundtable_send`, `roundtable_read`, `roundtable_who`, `roundtable_inbox`, `roundtable_withdraw`,
  `roundtable_rename` and `roundtable_kick`, with their parameters and results (`src/mcp/server.ts`).
- **The `roundtable` CLI:** its commands, flags, `--json` output and exit codes (2 input error, 3 service error, 4 guard
  refused or nothing withdrawn, ADR-0014) (`src/cli/commands.ts`).
- **The native envelope** an agent receives: the first-line room header and its fields (`src/core/dispatch/envelope.ts`).
- **Stored data:** the `session.toml` registry format, and the room's `.roundtable/` data (the SQLite ledger schema,
  `settings.json`, `tui.json`), which a newer service must open or migrate.

The IPC protocol between the service and its own clients (`src/contracts/ipc.ts`) ships in the same package and is
not a public surface on its own.

## Architecture

```
 Kevin ── roundtable tui (Ink) ─┐
 agents ─ MCP server ─────┼── named-pipe IPC ──► room service (single owner, detached)
 agents ─ room CLI ───────┘                          │  SQLite ledger (.roundtable/room.db)
                                                     │  registry ◄── session.toml (repo root)
                                                     ├── dispatcher (per-recipient serialized)
                                                     │     ├── Claude adapter → cc-msg named pipe
                                                     │     └── Codex adapter  → `codex queue` (argv)
                                                     └── observers (read-only transcript and usage readers)
```

| Component | Responsibility |
| --- | --- |
| `src/contracts/` | Shared types: the owner of cross-module shapes |
| `src/core/` (service) | Owns all behaviour: message persistence, recipient resolution, dedup, delivery states, pause and stop, recovery, the event stream |
| `src/core/registry/` | Room-root resolution (the git common dir) and the `session.toml` read and atomic write |
| `src/adapters/claude/`, `src/adapters/codex/` | Native submission only. Version-sensitive details are isolated here |
| `src/ipc/` | The named-pipe client and server. The TUI, CLI and MCP server are thin clients |
| `src/mcp/` | Official MCP SDK server; resolves caller identity per call, forwards to the service |
| `src/cli/` | The `roundtable` command |
| `src/tui/` | Ink app; presentation only |
| `src/observer/` | Readers with cursors and freshness labels |

Key design choices:

1. **Native wake, one path.** The Claude pipe and `codex queue` are the only normal delivery paths. No hook
   reinjection, no doorbell, no polling by the model.
2. **The service owns behaviour.** Clients (TUI, CLI, MCP) never write the database or call adapters directly.
3. **The ledger is the truth.** A message and all its per-recipient deliveries commit in one transaction before the
   service reports it accepted.
   - Delivery states: `queued → submitted → replied`, plus `failed`, `uncertain`, `withdrawn` (a terminal
     tombstone), and an independent `held` flag.
   - `submitted` records its evidence kind (Codex queue id versus Claude pipe write).
4. **Caller identity is derived, never trusted from input.**
   - Codex MCP: `params._meta.threadId` on each call.
   - Claude MCP: the parent pid's `~/.claude/sessions` entry, with `CLAUDE_CODE_SESSION_ID` as a cross-check.
   - CLI: `CODEX_THREAD_ID`, or a walk up the process tree to a Claude session. A declared `--as` name is a fallback
     only when detection is unavailable.
5. **Minimal registry.** `session.toml` holds only harness and session id. Everything else (pids, pipes, keys,
   executables, cwd) is derived at send time.
6. **Pause is cooperative.** It holds future deliveries and sends one stop-request message, which is exempt from the
   hold. It never claims an agent has stopped.
7. **Stack.** TypeScript (strict, ESM) on Node 24, built with `tsc` (ADR-0005); `node:sqlite`, Ink and React, the
   official MCP SDK; `node:test`. Tunables live in `src/core/config.ts`, overridable by `ROUNDTABLE_*` environment
   variables.

Runtime data lives under `<room>/.roundtable/` and the registry in `<room>/session.toml`, both git-ignored. The room root
is the checkout that owns the repository's common git directory, or `ROUNDTABLE_ROOT`.

## What is built

As of v0.9.0 (details per release in `CHANGELOG.md`):
- The MVP (v0.1.0): registry, ledger, service and IPC, dispatcher with pause, both native adapters, CLI, MCP front
  end, usage observer, TUI with participants and delivery detail, onboarding, live acceptance.
- The activity view of each agent's tool calls and results (v0.2.0).
- Subscription usage per account, workspace (model, branch, git status), two layouts and the bar design
  (v0.3.0–v0.7.6).
- The crossing guard (snapshot-guarded sends), withdraw and urgent sends (v0.8.0); the delivery hold, same-sender
  batching and room settings (v0.8.1).
- Participant lifecycle: registry-driven participants, rename without restart, kick by unanimous consent (v0.9.0).

Qualification evidence from the build is kept in git, for example `git show v0.9.0:probes/4.1-acceptance.md`
(live acceptance), `git show v0.9.0:probes/failure-recovery-results.md` (recovery),
`git show v0.9.0:probes/claude-identity-results.md` (Claude MCP identity) and
`git show v0.9.0:probes/claude-pipe-frames.md` (the Claude pipe sends no receipt frames).
