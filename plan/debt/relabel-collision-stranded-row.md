---
title: A relabel collision leaves a row queued under a departed name
where: src/core/ledger/ledger.ts
source: task 8.1 review (lean) and Astra
date: 2026-09-28
confidence: 30
---
# A relabel collision leaves a row queued under a departed name

`relabelQueued` skips a row when the same message already has a delivery under the new name (the primary key is
message id plus recipient), so that row stays queued under a name absent from the registry; the startup reconcile
repeats the skip. Severity: low. Source: `git show v0.9.0:reviews/8.1.md`.

## Why it waits

It needs a broadcast to two names that were distinct bindings, then one binding renamed to the other's departed
name. The reconcile now reports stranded rows on stderr, and the explicit rename (task 8.2) refuses the case with
`invalid_state`.

Suggested fix: decide a merge rule for the collision (cancel the older duplicate with a tombstone, or keep both
under distinct labels).
