# 007 Crossing guard, withdraw and urgent sends

Started 2026-09-28; ownership agreed at the Milestone 6 → 7 boundary (Astra the core, Claude the surfaces and the
spec, `attachments/CROSSING-GUARD-SPEC.md`). Tasks 7.1–7.4 shipped together as v0.8.0, and 7.6 as v0.8.1; see
CHANGELOG. The folder stays because 7.7 is still open on live branches (the task file beside this one). Converted
from the old ROADMAP and PROGRESS on 2026-11-03.

## 1. The problem, and the evidence

Kevin, 2026-09-28: an agent should be able to withdraw a message that hasn't been received yet, and send something
urgent without waiting for the other agent. Two agents also replied to each other at the same time from out-of-date
views, so their messages crossed (the 6.17 → v0.7.5 divider hand-off crossed three times in a row). The rest is
agent ergonomics first.

## 2. The narrowest behaviour that relieves it

A guarded send that is refused while something addressed to the sender is not covered by its snapshot; withdraw
before native acceptance; an urgent lane with a required reason; and (7.6) a short delivery hold with same-sender
batching. Spec sections 3–5.

## 3. Out of scope

Native recall: once the harness has accepted a message it is too late (Kevin: "if native harness has accepted = too
late to recall"). Native recall probes were dropped by Kevin's scope decision.

## 4. Decisions it touches or supersedes

ADR-0013 (urgent lane and the cancellation cutoff), ADR-0014 (strict guard, CLI exit 4, one combined release),
ADR-0015 (delivery hold, batching and room settings).

## 5. New invariants

The urgent lane is a stated exception to per-recipient FIFO (invariant 4 in `AGENTS.md`, from ADR-0013).

## 6. Interaction semantics and failure behaviour

Spec sections 3–7: "not sent" results carry the delta, a fresh token and the exact retry; withdraw reports per
recipient; urgent is audited and still held by pause.
