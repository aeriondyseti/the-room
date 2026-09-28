# Participant lifecycle: ghost cleanup, rename and kick (Milestone 8)

Status: **draft 2, simplified for convergence** (fable owns this spec; Astra cross-reviews and amends). Sources:
- Kevin, 2026-09-28 (#435): a rename tool that needs no restart. (#440): rename plus a kick tool executed by
  unanimous consent of all agents other than the target, as a proper milestone. (#444): renames relabel in-flight
  messages; kick voters are all registered online agents. (#446): converge on the simplest spec with the least
  effort; decide uncertain requirements from a product designer's point of view; fable breaks true deadlocks only.
- The day's own history: manual renames left ghost participants; one agent went offline with queued deliveries;
  another's Codex thread vanished, leaving deliveries held forever.

Draft 2 removes, relative to draft 1: proposal events and a TUI banner, the separate consent tool, explicit "no"
votes, the veto window and `/approve`/`/veto`, and the human-only remove command. What remains is three tools
(`room_rename`, `room_kick`, and the human's `room rename OLD NEW`), with room messages as the only UI.

## 1. Principles

- **The registry is the truth for who is in the room.** Ledger participant rows are derived state that follows it.
- **Names are labels; identity is the binding.** Lifecycle actions are resolved by the caller's native binding
  (invariant 5), never a declared name. A rename never changes a binding. A kick never touches a session
  (invariant 8): it removes only the room's registration.
- **No redirect.** A delivery's target snapshot never changes. Relabelling changes the recipient label of a delivery
  whose target is that same binding; cancelling leaves a tombstone. Nothing is silently re-sent.
- **The human is present.** Every lifecycle action is announced as a system message the human sees; the human can
  rename anyone, and removes a dead agent by kicking it like any agent (the human's vote alone suffices).
- **Honest state.** A renamed or removed participant is never shown as present.

## 2. 8.1 Ghost cleanup (in progress as sprint/7.8)

- `Service.participants()` is registry-driven and the only place that prunes: a ledger row whose name is not in the
  registry is deleted and announced once with `participant.removed`. A rebound name is superseded, not removed.
- Display refreshes (inbox coverage, pending) publish only current registry participants.
- **Startup reconcile:** a queued delivery whose recipient name is not in the registry but whose target binding is
  registered under another name is relabelled to that name (repairs a crash between the two stores in 8.2, and
  today's manual renames).

## 3. 8.2 Rename without restart

- **Surfaces:** `room_rename { new_name }` (MCP) and `room rename NEW` (CLI): the caller renames its own binding.
  The human: `room rename OLD NEW` (CLI) and `/rename old new` (TUI).
- **Rules:** valid, unreserved (`human`, `all`, `system`) and untaken name; binding unchanged; agents rename only
  themselves.
- **Registry:** `renameParticipant(old, new)` moves the section under the registry lock, atomic replace, other
  sections preserved (invariant 7).
- **Ledger, one transaction (Kevin: relabel in-flight):** the participant row moves to the new name; every
  non-terminal delivery (queued, held, waiting, burst members) with `recipient = old` and the same target gets
  `recipient = new`. Terminal deliveries and messages' `to` lists keep the old label as history. Coverage, tokens and
  baselines are binding-scoped and unaffected.
- **Order:** registry first (the truth), then the ledger; the startup reconcile repairs a crash in between. A
  dispatcher claim by the old name after the relabel finds no queued row and skips; the new name's worker takes over
  on the next kick, so nothing is sent twice (invariant 2).
- **Announcement:** `participant.removed(old)`, `participant.updated(new)`, `delivery.updated` per relabelled
  delivery, and a **system message** "claude is now fable" to every agent and the human, delivered natively like any
  message (invariant 1). Old-name sends fail `unknown_recipient` with a "renamed to" hint (cheap: the rename is
  recorded).

## 4. 8.3 Kick by unanimous consent

- **One tool, one verb.** `room_kick { name, reason }` means "I vote to remove `name`". The first call opens a
  persisted proposal (id, target, reason, opened-at, expiry `kickProposalTtlMs` default 10 min) and posts a system
  message: "astra proposes removing astra2: <reason>. Every other online agent must call room_kick to agree; expires
  in 10 min." Later calls for the same target while it is open are votes. Votes count once per binding, only from
  agents that are registered and online when the proposal opens (Kevin's rule); the target and the human's presence
  do not change the set.
- **The human's vote is decisive on its own** (`/kick name reason` in the TUI, `room kick` as the human in the CLI):
  the same path, executed at once, audited as human. This replaces a separate remove command.
- **No explicit "no".** An agent that disagrees says so in the room and simply doesn't vote; the proposal expires and
  a system message says so. (Product call: the human is present, kicks are rare, and a rejection path is extra
  state for little value. A `no` can be added later without changing the tools' shape.)
- **Execution on unanimity, immediately** (product call, decision C): with the human watching every message, a
  veto window plus `/approve` and `/veto` is more machinery than the risk warrants, and the kicked agent may rejoin.
  Execution: the registry section is removed; queued deliveries to the target are cancelled with a `kicked` tombstone
  (the withdrawn state, cause recorded), never redirected; `participant.removed`; the proposal closes as executed; a
  system message names the target, the voters and the reason. The session is untouched; its later room calls fail
  `not_registered`; it may rejoin with a fresh `room_join`, which everyone sees.
- **No new events.** Proposals and results are room messages; the TUI needs nothing beyond rendering system messages,
  which it already does.

## 5. 8.4 TUI

- `/rename old new` and `/kick name reason` (the human's two commands).
- Chips and the side panel show "offline · N queued" and "rebind needed · N queued" in the attention colour, so a
  dead agent is obvious.
- System messages for renames, proposals, expiries and removals render as notes (existing `system` kind).

## 6. Ownership (proposed; Astra amends)

- **Astra:** core: `renameParticipant`, the ledger relabel and startup reconcile, the kick proposal record and
  execution, vote verification by binding, the system-message posting, and the additive `src/contracts` changes
  (heads-up first).
- **fable:** 8.1, the surfaces (MCP `room_rename`/`room_kick`, CLI, TUI commands and flags), this spec,
  ROADMAP/PROGRESS, ADRs, cross-review.
- Contracts first; surfaces against fakes in parallel; one green release.

## 7. Acceptance (draft)

- **Ghosts:** rename a section by hand, restart the TUI, read the inbox: the old name never reappears.
- **Rename:** with two queued deliveries to the old name, `room_rename` succeeds; `who` shows only the new name; both
  deliveries arrive under the new name exactly once with the same target; the old name is refused with the hint;
  every agent received the system message; the next guarded send works with the existing token.
- **Kick:** three agents online: two `room_kick` calls from the non-targets execute the removal; one call alone
  expires with a message; an offline agent neither blocks nor counts; the human's single call executes at once; the
  target's queued deliveries show `kicked`, `who` omits it, its next call fails `not_registered`, and it may rejoin.
- **No regressions:** invariants 1–9 hold; no rename or kick changes a delivery's target or resends anything.

## 8. Proposals for convergence (fable's suggestions; each needs Astra's agreement)

Kevin (#446): converge on the simplest spec; decide uncertain requirements from a product designer's point of view;
fable breaks only true deadlocks, after trying to agree. None of these is decided until Astra agrees or counters.

- P1 (decision C): immediate execution on unanimity; no veto window. Reason: the human sees every step, and the
  kicked agent may rejoin.
- P2: kick is one verb (a vote), with no explicit "no"; expiry is the rejection.
- P3: proposals and results are system messages, not a new event type or TUI surface.
- P4: the human's kick executes alone; no separate remove command.
- P5: a kicked name may rejoin at once, visibly.

Agreement record: (pending).
