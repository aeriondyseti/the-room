# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases up to 0.9.0 were written up from the tags and their merged records when the changelog was created on
2026-11-03. Versions `0.0.1`–`0.0.23` each count one merged sprint; from `0.1.0` to `0.9.0` the minor rose for
each feature-sized release (Milestone 6's features, then Milestones 7 and 8) and the patch for follow-ups. Neither
scheme is semver; versions follow semver from the next release.

## [Unreleased]

### Added

- `scripts/rename-local-checkout.ps1`: a guarded migration of a local checkout from the old `vibe-pairing` folder,
  with a `-Plan` mode. It stops the running room service gracefully, repairs linked worktrees, and updates the room
  MCP registrations and the global npm link.

### Changed

- **BREAKING:** the project is renamed from vibe-pairing to agent-roundtable, and every name people and agents type
  follows it. The CLI is `roundtable` (was `room`); the MCP server is `roundtable` (was `vibe-pairing-room`) and its
  tools are `roundtable_*` (were `room_*`); settings are `ROUNDTABLE_*` (were `ROOM_*`); the state directory is
  `.roundtable/` (was `.room/`); the envelope header opens with `[roundtable …]`. The package name, the sender name
  on Claude pipe frames, the TUI header, the usage endpoint's User-Agent and the paths in the docs follow. No old
  name is kept as an alias and earlier state is not migrated.
- Versions follow semver from this release, the first 1.x; earlier versions counted sprints and milestones.
- The project's docs follow the shared docs process: `AGENTS.md`, `docs/decisions/` (one record per decision),
  `docs/reference/` (design, glossary, operations) and `plan/`. The onboarding guide is now
  `docs/reference/operations.md`.

## [0.9.0] - 2026-09-28

Milestone 8: participant lifecycle (tasks 8.1–8.4).

### Added

- Rename without restart: an agent renames itself with `room_rename` or `room rename`, and the human renames anyone
  with `room rename OLD NEW` or `/rename` in the TUI. Queued deliveries move to the new name with their targets
  unchanged; the old name is refused with a "renamed to" hint, and a notice tells the other agents.
- Kick by unanimous consent: `room_kick { name, reason }` opens or joins a proposal. It executes as soon as every
  agent that was online when it opened has agreed, and expires after 10 minutes otherwise; the human's own kick
  executes at once. A kicked agent's queued deliveries are cancelled, never redirected, and its session is untouched
  and may rejoin.
- Room notices: renames, kick proposals, expiries and removals are posted as system messages (`ROOM NOTICE`)
  without authority.
- TUI: `/rename old new` and `/kick name reason`; chips and the side panel flag "offline · N queued" and "rebind
  needed · N queued"; kicked deliveries are marked, with a legend.

### Fixed

- Ghost participants: who is in the room now follows the registry, departed names are pruned once, and a startup
  reconcile relabels queued deliveries left under a departed name.

## [0.8.1] - 2026-09-28

Task 7.6.

### Added

- A short hold before delivery (half a second by default), so a message can still be withdrawn. Urgent messages and
  stop requests skip it.
- Same-sender batching: consecutive held messages from one sender to one recipient go as one native envelope, each
  message whole.
- Room settings in `.room/settings.json`, read live by the service and edited by the human from the TUI's
  `/settings`; `ROOM_*` environment variables still override them. A bad settings file never blocks delivery and is
  repaired by the next save.

## [0.8.0] - 2026-09-28

Milestone 7: crossing guard, withdraw and urgent sends (tasks 7.1–7.4), released as one combined merge.

### Added

- The crossing guard: an agent's send carries a snapshot token and is refused ("not sent", with what was missed and
  the exact retry) while something addressed to the agent isn't covered by it. Human sends are never guarded.
- `room_inbox` and `room inbox`: what is addressed to you and not yet covered, with a fresh snapshot, and an audited
  `baseline` to skip old history without review.
- Withdraw: `room_withdraw` and `room withdraw` cancel a message for recipients whose session hasn't accepted it yet,
  reported per recipient. Once accepted, it is too late.
- Urgent sends with a required reason, which skip the guard's freshness check and take a priority lane; pause still
  holds them.
- TUI: URGENT and its reason, a mark for sends refused as stale, withdrawn deliveries struck through per recipient,
  and "N not covered" on agent chips and the side panel.

### Changed

- The service rejects unguarded agent sends, and the CLI exits 4 when a send is refused or a withdraw
  cancels nothing. The ledger moves to schema version 2; an older service cannot open it, so a downgrade needs a
  pre-upgrade backup.

## [0.7.6] - 2026-09-28

Task 6.18.

### Fixed

- The frame always fits the terminal: rows are budgeted by priority, the highlighted suggestion stays visible, the
  header never wraps, tiny panels show summaries, and the top bar trims with a notice. At 12 rows the "/" list used to
  push the header and the To: row off screen.

## [0.7.5] - 2026-09-28

### Removed

- The outer pane divider added in 0.7.4, at Kevin's request after visual testing; content gets its full size back.

## [0.7.4] - 2026-09-28

Task 6.17.

### Added

- An outer pane divider: one cyan bottom row in the left-panel layout, or a right column in the top-bar layout.

## [0.7.3] - 2026-09-28

Task 6.16.

### Changed

- The side panel gets the top bar's AGENTS and BUDGETS sections, with one shared label column so bars, numbers and
  resets align; agents come before budget detail, attention states first, and every model's usage window is shown.

## [0.7.2] - 2026-09-28

Task 6.15.

### Changed

- Bars are one flat surface: a solid state-coloured fill and a solid dim track with the number over both, no stipple.
  Without colour: an inverse fill and a ░ track.

## [0.7.1] - 2026-09-28

Task 6.14.

### Changed

- The percentage sits inside the bar, htop/btop style: a reverse-video fill in the state colour, a dim track and a
  centred, aligned number. Bars take the largest size that fits.

## [0.7.0] - 2026-09-28

Task 6.13.

### Added

- Composer word keys: Ctrl+Left/Right to move by word, Ctrl+Backspace and Ctrl+W to delete a word, Ctrl+Enter for a
  new line (per terminal).
- The composer grows with the draft, up to 12 visual rows, then scrolls; it never covers the bottom bar.

### Fixed

- While typing, the conversation no longer briefly shrinks below its minimum height.

## [0.6.2] - 2026-09-28

Task 6.12.

### Changed

- Model-specific limits (Fable weekly, or any model window such as a 5h one) show as columns on their account's row;
  bars shrink, then become numbers, to fit.

## [0.6.1] - 2026-09-28

Task 6.11.

### Fixed

- A space after the reset arrow (`↻ 1h53m`), which renders about 1.5 cells wide in some terminals.

## [0.6.0] - 2026-09-28

Task 6.10.

### Added

- `/compact` and Ctrl+T for compact lines, remembered; paging in help.

### Changed

- The top bar is two labelled grids, AGENTS and BUDGETS, with aligned values, resets and caveats. Bars take state
  colours (green, amber from 70%, red above 90%), a missing value is "—", and an activity dot shows who is working.
  It falls back to wrapping lines when it doesn't fit.

## [0.5.1] - 2026-09-28

Task 6.9.

### Fixed

- Shutdown is bounded: slow observations get a short grace (`ROOM_MONITOR_STOP_GRACE_MS`) and are then abandoned
  without writing, and the detached service exits once closed.

## [0.5.0] - 2026-09-28

Task 6.8.

### Added

- A layout toggle between the top bar and a left panel (`/layout`, Ctrl+B), remembered in `.room/tui.json`.
- ccstatusline-style usage bars with fixed group colours, and honest `n/a`, stale and `!` markers in both layouts.

## [0.4.0] - 2026-09-28

Task 6.7.

### Added

- Workspace in the top bar: each chip shows the agent's model and branch (with a dirty mark), and `/who` shows its
  working directory, worktree, branch, staged, modified and untracked counts, ahead and behind, and the observation's
  age. Read-only, with bounded git sampling.

## [0.3.1] - 2026-09-28

Task 6.6b.

### Changed

- Claude plan usage comes first from ccstatusline's own cache, with no extra calls and no credentials. The opt-in
  usage endpoint is throttled like ccstatusline (about one call per 5 minutes per profile, shared between room
  services, backing off after a 429), and the statusline tap is the last fallback.

## [0.3.0] - 2026-09-28

Task 6.6.

### Added

- Subscription usage per account in the TUI: 5h and weekly windows (plus Claude's Fable weekly) with reset times.
  Codex usage is read from its running daemon; Claude's from a statusline tap or the opt-in usage endpoint
  (`ROOM_CLAUDE_USAGE_API=on`).

### Changed

- A top bar of participant chips replaces the sidebar.

## [0.2.2] - 2026-09-28

Task 6.5.

### Added

- `npm run tui` and `npm run tui:demo` open this repository's room from the checkout.

## [0.2.1] - 2026-09-28

Task 6.4.

### Added

- Typing `/` lists the TUI's commands above the composer, filtered as you type: Tab completes, ↑/↓ move, Enter runs.

## [0.2.0] - 2026-09-28

Task 6.1.

### Added

- The activity view: `/activity @name` shows an agent's tool calls, results and messages, read-only from its Claude
  or Codex transcript, with persisted cursors, a bounded window with paging, and honest coverage labels. Nothing it
  observes feeds back into delivery.

## [0.1.3] - 2026-09-28

Task 6.3c.

### Fixed

- A `room_send` with missing, non-string or empty text names the required field, and an invalid request is never
  dispatched.

## [0.1.2] - 2026-09-28

Task 6.3b.

### Added

- A live probe of the frames a Claude messaging pipe sends back (`scripts/probes/pipe-frames.mjs`). It found none
  for user frames, so delivery evidence stays the pipe write; no behaviour changed.

## [0.1.1] - 2026-09-28

Task 6.3a.

### Fixed

- Inherited Git environment variables can no longer redirect room discovery into another repository; linked
  worktrees still share one room, and a bare repository needs an explicit `ROOM_ROOT`.

## [0.1.0] - 2026-09-28

Task 5.3, and the release of the MVP (Milestones 0–4) plus polish (Milestone 5).

### Added

- A README quickstart checked from a clean clone, and a first-run experience for `room tui`.
- Release qualification on throwaway sessions: 20 idle-wake trials each for the Claude pipe and Codex queue, a
  two-hour mixed exercise on Claude fixtures, a bounded busy-Codex scenario, and the four-agent scenarios passing on
  re-run, with the first failures kept in the record.

### Changed

- `room doctor` is the one-command, read-only setup check that explains failures.

## [0.0.23] - 2026-09-28

Task 4.1.

### Added

- The room end to end on live agents: Claude and Astra moved from pair-poc onto the real room, and the four-agent
  acceptance fixture (two Claude, two Codex) passed its broadcast, targeting, cross-harness reply, busy-recipient and
  CLI checks.

## [0.0.22] - 2026-09-28

Task 2.3b.

### Fixed

- A human terminal launched from the Windows desktop (Explorer) is recognised as the human, so `room shutdown` and
  other human commands work from it.

## [0.0.21] - 2026-09-28

Task 5.1c.

### Added

- `/restart` in the TUI: a graceful service restart after a second Enter to confirm; the TUI reconnects and starts
  the new service.

## [0.0.20] - 2026-09-28

Task 2.1b.

### Added

- Observed Codex activity: active, idle and approval states read from the shared Codex daemon, without starting a
  daemon or loading a thread; unavailable stays unknown.

## [0.0.19] - 2026-09-28

Task 5.1b.

### Fixed

- An idle Claude session shows as idle instead of "status unknown".

## [0.0.18] - 2026-09-28

Task 5.1.

### Added

- TUI polish: colour and monochrome themes, a help overlay, key hints, wrapped messages and code blocks, empty and
  first-run states, runtime context in `/detail`, and `ROOM_TUI_*` tunables for layout, history and reconnect.

## [0.0.17] - 2026-09-28

Task 5.2.

### Added

- Agent ergonomics: tool and CLI errors say what to do next, replies default to the original sender, `room doctor`
  gives remediation hints, and the envelope is easier to read.

## [0.0.16] - 2026-09-28

Task 4.2.

### Added

- Failure and recovery qualification: service restart with pending work, concurrent startup, ambiguous-submit
  recovery, the pause stop request, oversized messages, a linked-worktree room, and rebinding that never redirects
  earlier deliveries.

## [0.0.15] - 2026-09-28

Task 2.5b.

### Added

- The participant monitor: the service keeps each participant's liveness, activity and context usage current.

## [0.0.14] - 2026-09-28

Task 2.3.

### Added

- The `room` CLI: `send` (from arguments, stdin or a file), `read`, `who`, `join`, `doctor`, `pause`, `resume` and
  `shutdown`, with the caller's identity detected from its Codex thread or Claude process, and useful exit codes.

## [0.0.13] - 2026-09-28

Task 2.6.

### Added

- Onboarding: the Claude `/room` skill, the Codex room instructions, an install recipe (`claude mcp add`,
  `codex mcp add`) and the move from pair-poc. A verified environment fallback identifies a Claude caller when its
  shell chain is broken.

## [0.0.12] - 2026-09-28

Task 2.1.

### Added

- The Codex adapter: delivery through `codex queue` as an argument array, a 24K envelope budget with a reference
  fallback for oversized messages, and the queue id recorded as evidence.

## [0.0.11] - 2026-09-28

Task 2.4.

### Added

- The MCP front end (`room mcp`): `room_send`, `room_read`, `room_who` and `room_join`, with the caller's identity
  resolved on every call.

## [0.0.10] - 2026-09-28

Task 3.3.

### Added

- TUI participants with state, pending count and usage freshness; `/detail` for a message's delivery attempts and
  errors; usage in the panel and `/who`; a narrow layout.

## [0.0.9] - 2026-09-28

Task 1.3.

### Added

- Ordered per-recipient dispatch with delivery states (queued, submitted, replied, failed, uncertain) and a held
  flag, and a cooperative pause that holds deliveries and sends one stop request; crash recovery marks in-flight
  attempts uncertain and never resubmits them on its own.

## [0.0.8] - 2026-09-28

Task 3.2.

### Added

- The TUI composer and commands: a To: indicator (broadcast by default), `@name` completion, multi-line messages,
  `/pause`, `/resume`, `/who`, `/retry` and `/help`; `room tui` opens the real room.

## [0.0.7] - 2026-09-28

Task 1.2.

### Added

- The room service and its named-pipe IPC: a single owner, detached auto-start from any client, clean shutdown and
  an event stream.

## [0.0.6] - 2026-09-28

Task 3.1.

### Added

- The TUI shell: the conversation with senders, recipients, replies and delivery ticks, scrollback that never jumps,
  follow-live and reconnect; `room tui --demo`.

## [0.0.5] - 2026-09-28

Task 2.5.

### Added

- A read-only usage observer for Claude JSONL `usage` and Codex `token_count`, with restartable cursors and
  `unavailable` (never zero) when a source is missing.

## [0.0.4] - 2026-09-28

Task 2.2.

### Added

- The Claude adapter: delivery through the session's messaging pipe, found by session id and validated, with
  "rebind needed", offline, failed and uncertain outcomes; tokens are never logged.

## [0.0.3] - 2026-09-28

Task 1.1.

### Added

- The SQLite room ledger: a message and its deliveries commit together, client retries deduplicate, and attempt
  history is kept.

## [0.0.2] - 2026-09-28

Task 0.2.

### Added

- The shared room root (linked worktrees share one room, `ROOM_ROOT` overrides it) and the minimal `session.toml`
  registry, with locked atomic writes, duplicate rejection and migration of the old hand-written file.

## [0.0.1] - 2026-09-28

Task 0.1.

### Added

- The repository skeleton, the shared contract types and `room --version`.

[Unreleased]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.7.6...v0.8.0
[0.7.6]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.7.5...v0.7.6
[0.7.5]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.7.4...v0.7.5
[0.7.4]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.7.3...v0.7.4
[0.7.3]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.23...v0.1.0
[0.0.23]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.22...v0.0.23
[0.0.22]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.21...v0.0.22
[0.0.21]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.20...v0.0.21
[0.0.20]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.19...v0.0.20
[0.0.19]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.18...v0.0.19
[0.0.18]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.17...v0.0.18
[0.0.17]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.16...v0.0.17
[0.0.16]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.15...v0.0.16
[0.0.15]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.14...v0.0.15
[0.0.14]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.13...v0.0.14
[0.0.13]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.12...v0.0.13
[0.0.12]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.11...v0.0.12
[0.0.11]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.10...v0.0.11
[0.0.10]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.9...v0.0.10
[0.0.9]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/aeriondyseti/agent-roundtable/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/aeriondyseti/agent-roundtable/releases/tag/v0.0.1
