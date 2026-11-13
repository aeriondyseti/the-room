---
title: ActivityService.stop() waits for an in-flight pass without a bound
where: src/core/service/activity.ts
source: task 6.9 review (lean)
date: 2026-09-28
confidence: 35
---
# ActivityService.stop() waits for an in-flight pass without a bound

`ActivityService.stop()` still awaits an in-flight activity pass without a bound (local transcript reads, up to
`activityReadBytes` per participant). Severity: low. Source: `git show v0.9.0:reviews/6.9.md`.

## Why it waits

Local reads are fast; the slow observers (probes, git, daemon and endpoint) are bounded since task 6.9.

Suggested fix: apply the same `settleWithin` and abandoned pattern (`src/core/service/settle.ts`) to
`ActivityService`.
