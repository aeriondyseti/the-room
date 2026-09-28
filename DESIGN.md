# DESIGN — Canonical Specification & Decision Log

The single source of truth for **why this project is the way it is**. The detailed, reconciled
specification is **[proposal.md](./proposal.md)**, which is incorporated here by reference; this file
summarizes it and pins the load-bearing parts. Decisions made *during* the build are appended as ADRs in
[DECISIONS.md](./DECISIONS.md).

Evidence: [findings-claude-messaging.md](./findings-claude-messaging.md),
[findings-codex-messaging.md](./findings-codex-messaging.md), `probes/*-results.md`, and
[IDEAS.md](./IDEAS.md) (parked ideas, not scope).

---

## 1. Problem & goals

Kevin runs several coding agents (Claude Code and Codex sessions) in the same repository and wants them to
coordinate like a chat room that he can watch and direct from one terminal pane. The earlier system,
claudex-pair, failed because agents had to keep a listener armed and simply went idle.

**North star:** an addressed message reliably causes the recipient's harness to take a turn, through the
harness's own native messaging, and the model is **never** responsible for waking itself. Kevin sends one
message to every agent at once, watches the conversation and delivery state in a polished TUI, and can
pause the room.

## 2. Scope (in / out)

**In (MVP, v0.1.0 = MVP plus an ergonomics polish pass):**
- **Harnesses:** Claude Code and Codex, including several instances of each (four-agent acceptance
  fixture). Agents attach from sessions that are already running.
- **Registration:** agents self-register with `room join` (CLI) or `room_join` (MCP) into the repo-root
  `session.toml`. Each `[participants.<name>]` holds **only** `harness` and `session_id`.
- **One room service per repo:** SQLite ledger, local named-pipe IPC, single owner, auto-started
  detached by any client.
- **Native delivery:**
  - Claude: write to the session's messaging pipe.
  - Codex: `codex queue` with an argument array.
  - Full message envelope; oversized messages get a bounded preview plus a `room read <id>` reference.
- **Agent access:** MCP tools `room_send`, `room_read`, `room_who`, `room_join` (preferred), and a CLI
  fallback (`room send/read/who/join/doctor/pause/resume`). Per-call caller identity.
- **Ink TUI in its own pane:**
  - room messages only (no harness output in the MVP);
  - broadcast by default, `@name` to target;
  - participant panel with state and token/context usage;
  - per-recipient delivery detail;
  - `/pause` (hold deliveries plus a stop request to all agents) and `/resume`.
  - UI/UX polish is a priority.
- **Minimal read-only usage observer:** Claude JSONL `usage`, Codex `token_count`.
- **Onboarding:** a `/room` skill for Claude and `AGENTS.md` instructions for Codex, plus an install
  recipe.

**Out (later):**
- the full harness/tool-output view (the first milestone after MVP);
- steering, hard stop, approval relay;
- launching agents, and background agents (see IDEAS.md);
- web UI, agy, plugin distribution, file claims.

## 3. Architecture overview

```
 Kevin ── room tui (Ink) ─┐
 agents ─ MCP server ─────┼── named-pipe IPC ──► room service (single owner, detached)
 agents ─ room CLI ───────┘                          │  SQLite ledger (.room/room.db)
                                                     │  registry ◄── session.toml (repo root)
                                                     ├── dispatcher (per-recipient serialized)
                                                     │     ├── Claude adapter → cc-msg named pipe
                                                     │     └── Codex adapter  → `codex queue` (argv)
                                                     └── usage observer (read-only transcript readers)
```

| Component | Responsibility |
|---|---|
| `core/` (service) | Owns all behavior: message persistence, recipient resolution, dedup, delivery states, pause/stop, recovery, event stream |
| `core/registry` | Room-root resolution (git common dir) and the `session.toml` read/atomic write |
| `adapters/claude`, `adapters/codex` | Native submission only. Version-sensitive details are isolated here |
| `ipc/` | Protocol types plus the named-pipe client/server. The TUI, CLI and MCP server are thin clients |
| `mcp/` | Official MCP SDK server; resolves caller identity per call, forwards to the service |
| `cli/` | The `room` command |
| `tui/` | Ink app; presentation only |
| `observer/` | Usage readers with cursors and freshness labels |

## 4. Key design decisions

The full reasoning is in proposal.md, section by section.

1. **Native wake, one path.** The Claude pipe and `codex queue` are the only normal delivery paths. No
   hook reinjection, no doorbell, no polling by the model.
2. **The service owns behavior.** Clients (TUI, CLI, MCP) never write the database or call adapters
   directly.
3. **The ledger is the truth.** A message and all its per-recipient deliveries commit in one
   transaction before the service reports it accepted.
   - Delivery states: `queued → submitted → replied`, plus `failed`, `uncertain`, and an independent
     `held` flag.
   - `submitted` records its evidence kind (Codex queue id versus Claude pipe write).
4. **Caller identity is derived, never trusted from input.**
   - Codex MCP: `params._meta.threadId` on each call.
   - Claude MCP: the parent pid's `~/.claude/sessions` entry, with `CLAUDE_CODE_SESSION_ID` as a
     cross-check.
   - CLI: `CODEX_THREAD_ID`, or a walk up the process tree to a Claude session. A declared `--as` name is
     a fallback only when detection is unavailable.
5. **Minimal registry.** `session.toml` holds only harness and session id. Everything else (pids, pipes,
   keys, executables, cwd) is derived at send time.
6. **Pause is cooperative.** It holds future deliveries and sends one stop-request message, which is exempt
   from the hold. It never claims an agent has stopped.
7. **Stack.** TypeScript (strict, ESM) on Node 24, built with `tsc`; `node:sqlite`, Ink/React, the
   official MCP SDK; `node:test`.

## 5. Load-bearing invariants

Mirrored verbatim in CLAUDE.md and AGENTS.md; audited by local-code-review every sprint.

1. **No model-side waking.** Delivery happens only through a native harness transport (the Claude
   messaging pipe, or `codex queue` via an argv array). Nothing may require an agent to poll or re-arm a
   listener to receive a message.
2. **One delivery path, no duplicates.**
   - Each (message, recipient) delivery has exactly one owner and transport. Never also inject it through
     hooks.
   - Client retries are deduplicated by `client_message_id` (scoped to room and sender).
   - An `uncertain` attempt is never retried automatically.
3. **Honest state.**
   - Delivery and participant states come only from observed evidence. Never report `submitted`,
     `replied`, "stopped", or usage that wasn't actually observed.
   - An unknown or unavailable state is shown as such, never as zero, success, or blank.
4. **Persist before acknowledging.** A message and its deliveries commit atomically before the send is
   reported accepted. Per-recipient FIFO is preserved within normal and urgent lanes; urgent may overtake broker-pending normal deliveries only (ADR-0013). One offline or failing recipient never blocks
   the others.
5. **Identity integrity.**
   - Never infer a sender from the MCP server's own pid alone, cwd, clientInfo, a JSON-RPC id, or model-supplied text (a verified parent-pid registry lookup is valid), apart from the
     explicit declared-identity fallback, which is labelled.
   - Never post an unbound agent's message as the human.
   - Never redirect an already-queued delivery to a different native session. Deliveries snapshot their
     target.
6. **Secrets never leave memory.** Claude peer tokens (`.key` files, `CLAUDE_CODE_MESSAGING_TOKEN`) are
   never persisted, logged, returned by tools, or shown in the TUI.
7. **Minimal registry.**
   - `session.toml` participant sections contain only `harness` and `session_id`.
   - Writes use a lock and atomic replace, and preserve every other participant section.
   - Duplicate names or duplicate native bindings are rejected, not clobbered.
8. **Hands off the harnesses.** Never write Codex's or Claude's internal databases or state files, never
   change a harness's config or permissions, and never silently restart, resume, or fork a session.
9. **Peer messages carry no authority.** Envelopes attribute the sender, and only messages from Kevin are
   marked as user directives. Never truncate or split a message silently; oversized messages use the
   labelled reference fallback.

## Appendix — decision log

Pre-build decisions are recorded in proposal.md's "Reconciliation record" and in claude-reconciliation.md.
