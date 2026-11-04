---
title: Codex usage reports cacheWrite as 0
where: src/observer/parsers.ts
source: task 2.5 review
date: 2026-09-28
confidence: 45
---
# Codex usage reports cacheWrite as 0

Codex usage reports `cumulative.cacheWrite: 0` because Codex has no cache-write counter, and the contract type
(`src/contracts/domain.ts`) requires a number. Severity: low. Source: `git show v0.9.0:reviews/2.5.md`.

## Why it waits

Arguably accurate (Codex has no cache-write concept), and changing it widens a shared contract.

Suggested fix: make the per-counter fields of `UsageSnapshot.cumulative` nullable (coordinated with the TUI), or
document 0 as defined for Codex.
