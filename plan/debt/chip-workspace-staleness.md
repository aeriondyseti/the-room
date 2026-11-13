---
title: The participant chip shows a stale workspace without a marker
where: src/tui/topbar.ts
source: task 6.7 review (lean)
date: 2026-09-28
confidence: 30
---
# The participant chip shows a stale workspace without a marker

The participant chip shows the last-known model and branch with no staleness marker; only `/who` states the
observation age. Severity: low. Source: `git show v0.9.0:reviews/6.7.md`.

## Why it waits

The workspace changes slowly, and `/who` gives the age.

Suggested fix: dim or mark (`?`) the chip's workspace part once `observedAt` is older than a `ROUNDTABLE_*` threshold.
