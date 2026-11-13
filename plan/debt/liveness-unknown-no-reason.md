---
title: Unknown liveness carries no reason
where: src/contracts/domain.ts
source: task 2.5b review
date: 2026-09-28
confidence: 30
---
# Unknown liveness carries no reason

`unknown` liveness carries no reason: `probe.detail` and probe errors are dropped because `ParticipantState` has no
field for them. Severity: low. Source: `git show v0.9.0:reviews/2.5b.md`.

## Why it waits

Usage already carries a reason; a liveness reason needs a contract change.

Suggested fix: add an optional `livenessDetail` to `ParticipantState`, filled from `probe.detail` or the error, and
show it in `/who` and `/detail`.
