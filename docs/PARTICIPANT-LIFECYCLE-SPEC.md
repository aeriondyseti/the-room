# Participant lifecycle: ghost cleanup, rename and kick (Milestone 8)

Status: **draft for alignment** (fable owns this spec; Astra cross-reviews). No milestone code beyond 8.1 until the
ownership below is agreed. Sources:
- Kevin, 2026-09-28 (#435): "add a rename tool so that an agent can be renamed mid-conversation without having to be
  restarted."
- Kevin (#440): "spec this out as a proper milestone. The new rename tool, as well as a kick tool that can be
  executed by unanimous consent of all agents other than the one being targeted."
- Kevin (#442): align on the milestone before anyone runs off alone. (#444): "Rename: relabel in-flight messages.
  Kick: all registered online agents."
- The day's own history: two manual renames left ghost participants in the TUI; one agent went offline with queued
  deliveries; another's Codex thread vanished, leaving six deliveries held forever.

## 1. Principles

- **The registry is the truth for who is in the room.** `session.toml` says who exists; the ledger's participant
  rows are derived state and may be pruned or relabelled to match it, never the other way round.
- **Names are labels; identity is the binding.** Every lifecycle action is resolved by the caller's native binding
  (invariant 5), never by a declared name. A rename never changes a binding. A kick never touches a session
  (invariant 8): it only removes the room's registration.
- **No redirect.** A delivery's target snapshot never changes. Relabelling changes only the recipient *label* of a
  delivery whose target is that same binding; cancelling leaves a tombstone. Nothing is silently re-sent.
- **Human authority.** The human can rename or remove anyone directly and immediately. An agent-initiated kick runs
  only on unanimous consent of the other online agents, and the human can veto it.
- **Honest state.** A renamed or removed participant is never shown as present; an offline agent with queued
  deliveries is shown as exactly that.

## 2. 8.1 Ghost cleanup (in progress as sprint/7.8)

- `Service.participants()` is registry-driven and the only place that prunes: a ledger row whose name is not in the
  registry is deleted and announced once with `participant.removed`. A rebound name is superseded, not removed.
- Every display refresh (inbox coverage after inbox/send, pending after withdraw) publishes only current registry
  participants, so a departed name can't come back after a TUI restart.
- **Startup reconcile** (shared with 8.2): a queued delivery whose recipient name is not in the registry but whose
  target binding *is* registered under another name is relabelled to that name. That repairs a crash between the two
  stores below and today's manual renames.

## 3. 8.2 Rename without restart

- **Surfaces:** `room_rename { new_name }` (MCP) and `room rename NEW` (CLI) rename the caller's own binding. The
  human renames anyone: `room rename OLD NEW` and the TUI's `/rename old new`.
- **Rules:** the new name is valid and not reserved (`human`, `all`, `system`); it is not taken; the binding is
  unchanged. An agent can rename only itself.
- **Registry:** `renameParticipant(old, new)` moves the section under the registry lock with an atomic replace,
  preserving every other section (invariant 7).
- **Ledger, in one transaction (Kevin's decision: relabel in-flight):**
  - the participant row moves to the new name;
  - every delivery with `recipient = old` whose target equals the binding and whose state is not terminal (queued,
    including held and waiting; burst members too) gets `recipient = new`. Terminal deliveries keep the old label as
    history, and messages' `to` lists are untouched;
  - inbox coverage, tokens and baselines are binding-scoped, so they are unaffected;
  - the old→new pair is recorded, so `unknown_recipient` for the old name can say "claude was renamed to fable".
- **Order and crash safety:** registry first (the truth), then the ledger; the startup reconcile in 8.1 repairs a
  crash in between.
- **Dispatcher:** a claim keyed by the old name after the relabel finds no queued row and skips; the worker for the
  new name picks the deliveries up on the next kick. No delivery is sent twice (invariant 2).
- **Events and announcement:** `participant.removed(old)`, `participant.updated(new)`, `delivery.updated` for each
  relabelled delivery, and a **system message** (`kind: 'system'`, from `system`) "claude is now fable", addressed
  to every agent and the human and delivered natively like any message, so every agent learns the new name without
  polling (invariant 1). The TUI shows it as a note.

## 4. 8.3 Kick by unanimous consent

- **Proposal:** `room_kick { name, reason }` (agent; binding-resolved; never self, never the human) opens a
  persisted proposal: id, target, proposer, reason, opened-at, expiry (`kickProposalTtlMs`, default 10 min), and the
  **voters**: all registered agents that were online when it opened, except the target (Kevin's decision). The
  proposer's vote is implied. The target is notified and may reply in the room, but has no vote.
- **Votes:** `room_consent { proposal, decision: 'yes' | 'no', reason? }`, one per binding, counted only when the
  caller is a listed voter. A `no` closes the proposal as rejected; expiry rejects it too.
- **Human veto:** the human sees every open proposal in the TUI and can `/veto <id>` at any time, or `/approve <id>`
  to execute at once. **Decision C for Kevin:** on unanimity, execute immediately, or after a veto window
  (`kickVetoMs`, e.g. 60 s)? The spec recommends the window, because with two agents online one agent's proposal is
  already unanimous.
- **Execution** (the same path serves the human's direct `room remove NAME` / `/remove name`, audited as human):
  - the registry section is removed;
  - queued deliveries to the target are cancelled with a `kicked` tombstone (the existing withdrawn state, with the
    cause recorded), never redirected;
  - `participant.removed`, the proposal closes as executed, and a system message says who was removed, by whom, and
    why;
  - the session itself is untouched. Its later room calls fail with `not_registered`; it may rejoin with a fresh
    `room_join`, which the human sees.
- **Events:** `proposal.opened`, `proposal.updated` (a vote), `proposal.closed` (executed, rejected, vetoed, expired).

## 5. 8.4 TUI

- `/rename old new`, `/remove name`, `/kick name reason`, `/consent id yes|no` (for completeness), `/veto id`,
  `/approve id`.
- An open proposal is a banner with the votes so far and the countdown.
- Chips and the side panel show "offline · N queued" and "rebind needed · N queued" in the attention colour.
- Renamed and removed notes in the conversation (the system messages).

## 6. Ownership (proposed; agreed at the milestone boundary)

- **Astra:** core: `renameParticipant`, the ledger relabel and startup reconcile, the kick proposal state machine and
  its persistence, consent verification, execution, and the `src/contracts` additions (additive; heads-up first).
- **fable:** 8.1, the surfaces (MCP, CLI, TUI), this spec, ROADMAP/PROGRESS, ADRs, and cross-review.
- Contracts land first; surfaces are built against fakes in parallel; one green release per feature or combined.

## 7. Acceptance (draft)

- **Ghosts:** rename a section by hand, restart the TUI, read the inbox: the old name never reappears (8.1's tests).
- **Rename:** with two queued deliveries to the old name, `room_rename` succeeds; `who` shows only the new name; both
  deliveries arrive under the new name once, with the same target; the old name is refused with a hint; every agent
  received the system message; the renamed agent's next guarded send works with its existing token.
- **Kick:** with three agents online, a proposal needs the two non-target votes; a `no` or expiry rejects; the
  human's veto stops an executed-pending proposal; on execution the target's queued deliveries show `kicked`, `who`
  omits it, and its next call fails `not_registered`. An offline agent neither blocks nor votes.
- **Human path:** `room remove` on a dead agent (like astra2 today) clears it immediately and cancels its held
  deliveries with tombstones.
- **No regressions:** invariants 1–9 hold; a rename or kick never changes a delivery's target or resends anything.

## 8. Open decisions

- **C:** immediate execution on unanimity, or a human veto window first (recommended).
- Whether a kicked name may be rejoined at once, or only after the human clears it (spec: at once, visible).
