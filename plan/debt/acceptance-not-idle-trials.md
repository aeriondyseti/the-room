---
title: A wake trial counts even if the fixture never became idle
where: scripts/acceptance/run.mjs
source: task 4.1 review (lean)
date: 2026-09-28
confidence: 40
---
# A wake trial counts even if the fixture never became idle

In the acceptance harness, a wake trial still counts as OK if the fixture never became idle first. It is logged in
`results.errors`, but the trial row isn't flagged. Severity: low. Source: `git show v0.9.0:reviews/4.1.md`.

## Why it waits

Every recorded run shows idle fixtures (no errors), so no trial was affected.

Suggested fix: mark such rows `not_idle` and exclude them from the idle-wake statistics.
