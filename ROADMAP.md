# Build Roadmap

Sequenced, **session-sized** features. Each item is independently buildable and has a **Done-when**
acceptance line. Build order respects dependencies. **Owner** is the agent who builds, reviews, and merges
the feature (see CLAUDE.md "Two-agent coordination"); ownership may be reassigned by agreement over
pair-poc (record it in PROGRESS.md notes).

Legend: `[ ]` todo · `[x]` done · `§` cites [DESIGN.md](./DESIGN.md) / [proposal.md](./proposal.md).

Release gates: **MVP** = Milestones 0–4 · **v0.1.0** = MVP + Milestone 5 (polish), tagged on `main` ·
Milestone 6+ only after the v0.1.0 tag.

---

## Milestone 0 — Foundation

- [ ] **0.1 Repo skeleton and contracts** *(Claude)* *(§3, §4.7)*
  - **Scope:**
    - `package.json` (`room` bin), `tsconfig` (strict, ESM, JSX for Ink), the `src/` layout from DESIGN
      §3, and build/test/typecheck scripts;
    - shared **contract types**: domain types (Message, Delivery, DeliveryState, Participant,
      ParticipantState, UsageSnapshot), IPC request/response/event types with error codes, and the
      `Adapter` interface;
    - a stub `room --version`.
  - **Done-when:** `npm install && npm test` passes with at least one unit test per contract module;
    `node dist/cli/main.js --version` prints the package version; the contract types are exported from
    `src/contracts/`; typecheck is clean.

- [ ] **0.2 Room root and minimal registry** *(Astra)* *(§4.5, proposal "Registry")*
  - **Scope:**
    - canonical room root via `git rev-parse --git-common-dir`, plus a `ROOM_ROOT` override;
    - read/write `session.toml` `[participants.<name>]` {harness, session_id} with a lock and atomic
      replace;
    - reject duplicate names or bindings;
    - migrate the legacy verbose `session.toml` without losing the claude and astra entries.
  - **Done-when:** unit tests cover resolution from the main checkout and from a linked-worktree fixture;
    writes preserve other sections; duplicate rejection; migration of the current legacy file yields
    exactly two participant sections with only harness and session_id.

## Milestone 1 — Room service core

- [ ] **1.1 SQLite ledger** *(Astra)* *(§4.3)*
  - **Scope:**
    - `node:sqlite` schema: `messages`, `deliveries` with attempt history, `participants` runtime
      snapshots, `usage_cursors`;
    - atomic message-plus-deliveries insert;
    - `client_message_id` dedup scoped to (room, sender): an identical retry returns the original, and a
      different payload is rejected;
    - per-recipient ordering queries.
  - **Done-when:** unit tests for the atomic insert (a failure inserts nothing), dedup (identical,
    conflicting), attempt history kept across retries, ordering; the database lives at
    `<room>/.room/room.db`.

- [ ] **1.2 Service process and IPC** *(Astra)* *(§3, proposal "Architecture")*
  - **Scope:**
    - named-pipe server and client implementing the 0.1 IPC contract;
    - single-owner lock;
    - detached auto-start from any client, with a readiness wait;
    - `shutdown`;
    - an event subscription stream for the TUI.
  - **Done-when:** integration tests show that two concurrent client starts yield exactly one service;
    a client auto-spawns the service and succeeds; subscribers receive message and delivery events in
    order; shutdown is clean; a stale lock from a dead owner is recovered.

- [ ] **1.3 Dispatcher, states, and pause** *(Astra)* *(§4.3, §4.6)*
  - **Scope:**
    - per-recipient serialized dispatch through the `Adapter` interface;
    - states `queued/submitted/replied/failed/uncertain` plus `held`, with `replied` set via `reply_to`;
    - pause holds future deliveries and creates one stop-request message that is exempt from the hold;
      a repeated pause doesn't send another;
    - resume releases held deliveries in order;
    - crash recovery marks in-flight attempts `uncertain`, and manual retry is possible.
  - **Done-when:** tests with a fake adapter cover every state transition, pause/resume ordering, the
    stop-request exemption, restart recovery producing `uncertain` with no automatic resubmission, and
    an offline recipient not blocking others.

## Milestone 2 — Adapters and agent access

- [ ] **2.1 Codex adapter** *(Astra)* — `codex queue --thread <id> --message <envelope>` via an argv
  array; executable from PATH or a room override; the shared envelope builder; a 24K budget with the
  oversize reference fallback; the queue id recorded as evidence.
  **Done-when:** tests against a fake `codex` executable cover argv safety for quotes, newlines and
  Unicode, id capture, failure mapping, and the oversize fallback. A documented live smoke test against
  a real thread passes.

- [ ] **2.2 Claude adapter** *(Claude)* — look up the live registry entry by `session_id`, validating
  that the pid is alive and `procStart` matches; derive the key from the pipe path; write the auth frame
  then the user frame (`priority: next`); stale binding means "rebind needed"; tokens are never logged.
  **Done-when:** tests against a fake named-pipe server cover the exact frames, missing, dead or
  mismatched sessions, a pipe error mapped to `failed`, and no secret in any log, error, or return value.
  A documented live smoke test against a real session passes.

- [ ] **2.3 CLI** *(Astra)*
  - **Scope:**
    - `room send` (text from args, stdin, or a file), `read`, `who`, `join`, `doctor`, `pause`,
      `resume`, `shutdown`;
    - CLI caller identity (`CODEX_THREAD_ID`, Claude process-tree walk, `--as` checked against it);
    - useful exit codes and messages.
  - **Done-when:** integration tests run the CLI against a service with fake adapters for each command;
    identity detection, mismatch refusal, and the declared fallback are labelled; `room join` writes
    only harness and session_id.

- [ ] **2.4 MCP front end** *(Claude)*
  - **Scope:** official MCP SDK stdio server exposing `room_send`, `room_read` (paginated, with message
    fetch), `room_who`, and `room_join`; per-call identity; `client_message_id`; clear tool descriptions.
  - **Identity rules:**
    - Codex: `_meta.threadId`, cross-checked.
    - Claude: fresh parent-registry lookup plus an environment cross-check.
    - Reject unknown or conflicting identities.
  - **Done-when:** tests drive the server over stdio with synthetic Codex `_meta` and a synthetic Claude
    parent registry; identity accept, reject, and mismatch; a send round trip through the service with
    fake adapters; exact echo of multi-line, quoted, and Unicode text.

- [ ] **2.5 Usage observer** *(Claude)* — read-only readers for Claude JSONL `usage` and Codex
  `token_count`; byte-offset cursors that tolerate partial lines and rotation; freshness; `unavailable`
  labels; cumulative tokens kept separate from context occupancy.
  **Done-when:** fixture-based tests cover both formats, partial trailing lines, restart from cursors,
  and a missing file yielding `unavailable` (never zero).

- [ ] **2.6 Onboarding** *(Claude)* — a Claude `/room` skill, a Codex `AGENTS.md` room section, an
  install recipe (`claude mcp add` / `codex mcp add`), and migration from pair-poc.
  **Done-when:** the documents exist, and following the recipe on the live Claude and Astra sessions
  results in both registered and able to call `room_who`.

## Milestone 3 — TUI (UI/UX priority)

- [ ] **3.1 TUI shell and conversation** *(Claude)*
  - **Scope:**
    - an Ink app connected to the service event stream;
    - conversation view with sender, recipients, replies, and per-recipient delivery ticks;
    - scrollback that never jumps, a new-events counter, and follow-live;
    - graceful reconnect.
  - **Done-when:** ink-testing-library tests render the conversation from a fake event stream; scroll,
    follow-live, and new-count behaviour; reconnect banner.

- [ ] **3.2 Composer and commands** *(Claude)*
  - **Scope:**
    - a prominent `To:` indicator (broadcast by default);
    - `@name` targeting with completion;
    - multi-line mode; Esc cancels;
    - commands `/pause`, `/resume`, `/who`, `/retry <id>`, `/help`.
  - **Done-when:** tests cover addressing parsing, completion, multi-line, each command dispatching the
    right IPC request, and errors shown inline.

- [ ] **3.3 Participants, usage, and delivery detail** *(Claude)*
  - **Scope:**
    - participant strip or panel (state, pending, usage with freshness, "rebind needed" or "offline");
    - delivery detail view per message (attempts, evidence, errors);
    - responsive narrow layout;
    - scales past four agents.
  - **Done-when:** tests cover six participants, narrow width switching views, and a delivery detail
    showing `uncertain` with retry.

## Milestone 4 — MVP acceptance (dogfood)

- [ ] **4.1 Room end to end on live agents** *(Claude, with Astra)* — Claude and Astra switch from
  pair-poc to the real room via MCP, and Kevin's TUI broadcast reaches both.
  **Done-when:** a documented live run shows a broadcast from the TUI reaching Claude and Astra, replies
  via `room_send` appearing in the TUI with delivery states, and CLI fallback verified.

- [ ] **4.2 Failure and recovery qualification** *(Astra)* — service restart with pending work,
  concurrent startup, ambiguous-submit recovery, the pause/stop-request live check, oversized-message
  reference, and a linked-worktree room.
  **Done-when:** an automated suite plus a documented live checklist pass; results are recorded under
  `probes/`.

## Milestone 5 — Ergonomics polish (then tag v0.1.0)

- [ ] **5.1 TUI polish** *(Claude)* — visual hierarchy, theming (colour and no-colour), help overlay,
  key-binding hints, message formatting (wrapping, code blocks), empty and first-run states, and
  onboarding hints.
  **Done-when:** a documented UX pass with before/after notes; snapshot tests updated; no regressions.

- [ ] **5.2 Agent ergonomics** *(Astra)* — tool and CLI error messages that say what to do next, reply
  shortcuts (`reply_to` defaults), `room doctor` remediation hints, and envelope readability.
  **Done-when:** each agent-facing error has a remediation hint covered by tests; envelope format
  reviewed by both agents.

- [ ] **5.3 Human ergonomics and release** *(Claude, with Astra)* — a one-command setup check
  (`room doctor`), README quickstart, `room tui` startup experience; coordinated merge and tag
  **v0.1.0**.
  **Done-when:** README quickstart works from a clean clone; the v0.1.0 tag is on `main`.

## Milestone 6 — Post-release (only after v0.1.0)

- [ ] **6.1 Full activity view** — the transcript observer: tool calls and results in the TUI (proposal
  "Minimal observation now; full output after MVP").
- [ ] **6.2 IDEAS.md: background agents** — pursue per the IDEAS.md check results, as agreed then.
- [ ] **6.3 Tech-debt triage** — work TECH-DEBT.md items by severity.
