---
title: Persisted usage-observer cursors are never pruned
where: src/core/service/monitor.ts
source: task 2.5b review
date: 2026-09-28
confidence: 40
---
# Persisted usage-observer cursors are never pruned

Persisted usage-observer cursors are never pruned: sessions no longer bound after rebinds stay in the blob across
restarts. Severity: low. Source: `git show v0.9.0:reviews/2.5b.md`.

## Why it waits

Bounded by the sessions ever bound (small), and writes now only happen on change.

Suggested fix: prune cursors whose (harness, sessionId) is no longer a participant before exporting.
