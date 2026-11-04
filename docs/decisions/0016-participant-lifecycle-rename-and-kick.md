---
id: ADR-0016
status: accepted
date: 2026-09-28
decision-makers: [Kevin, fable, Astra]
made-in: M8
supersedes: []
superseded-by:
tags: [lifecycle, registry]
---
# Participant lifecycle: rename without restart, kick by consent (Milestone 8)

## Context and Problem Statement

Manual renames left ghost participants; an agent went offline with queued deliveries and another's native thread
vanished. Kevin asked for a rename tool that needs no restart and a kick tool executed by unanimous consent of the
other agents, spec'd as the simplest design (agreed with Astra; the spec is
`git show v0.9.0:docs/PARTICIPANT-LIFECYCLE-SPEC.md`).

## Considered Options

Rejected: proposal events plus a TUI banner; a separate consent tool and explicit "no" votes; a veto window with
approve/veto commands; a human-only remove command; refusing renames while deliveries are queued; cross-sender
batching of notices. All added machinery for little value while the human sees every message.

## Decision Outcome

- **The registry is the truth for who is in the room**; ledger participant rows follow it (pruned when a name
  leaves; `participant.removed` has one emitter). A startup reconcile relabels queued deliveries left under a
  departed name to the binding's current name.
- **Names are labels; identity is the binding.** Lifecycle actions are authorized by native binding: agents rename
  only themselves; the human names anyone. A rename moves the registry section atomically, then relabels QUEUED
  deliveries only (submitted, uncertain and in-flight attempts stay historical); the target snapshot never changes
  (no redirect); `RoomMessage.to` keeps the old label as history; a collision with an existing row under the new
  name is refused. Kevin's choice: relabel in-flight deliveries rather than refuse the rename.
- **Kick is one verb.** `room_kick` opens or joins a proposal; the electorate is frozen at opening as the other
  registered agents with fresh `online` liveness plus the authenticated proposer (unknown/stale are excluded and
  listed, never presumed offline). Unanimity executes immediately; expiry (default 10 min) is the rejection; there is
  no explicit "no", no veto window and no separate remove command: the human's own kick executes alone. Execution
  removes the registration, cancels queued deliveries with a `kicked` tombstone (never resent) and posts a notice;
  the session is untouched and may rejoin, visibly. A human kick persists a durable intent before the registry
  write.
- **Notices are system messages** (`ROOM NOTICE`, no authority) delivered natively so nobody polls. The agent that
  performed a lifecycle action is excluded from its own notice (it learns from the tool result), so the snapshot
  token it holds stays valid for its next guarded send.

## More Information

The old log gave this record no status line or author; it is converted as accepted (it shipped in v0.9.0). The
decision-makers are taken from the old roadmap (fable owned the spec; Astra cross-reviewed).
