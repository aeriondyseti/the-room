---
title: The Claude liveness probe trusts a cached start time
where: src/adapters/claude/registry.ts
source: task 2.5b review
date: 2026-09-28
confidence: 35
---
# The Claude liveness probe trusts a cached start time

The Claude probe uses `cachedStartTime` (30 s TTL): if a Claude process exits and Windows reuses its pid within the
TTL, liveness shows `online` for a dead session. Severity: low. Source: `git show v0.9.0:reviews/2.5b.md`.

## Why it waits

Pid reuse within 30 s is rare; delivery still re-verifies through the pipe and key; it is display only.

Suggested fix: on the probe path, bypass the cache, or downgrade a cache hit to `unknown` after `isPidAlive` was
false for that pid.
