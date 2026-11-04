---
title: The observer's read size is a literal, not a tunable
where: src/observer/jsonl-tail.ts
source: task 2.5 review
date: 2026-09-28
confidence: 50
---
# The observer's read size is a literal, not a tunable

`MAX_READ_BYTES` (8 MiB per observer read) is a literal, not a `ROOM_*` tunable. Severity: low.
Source: `git show v0.9.0:reviews/2.5.md`.

## Why it waits

It is an internal safety bound with a test parameter; no user-facing behaviour depends on it.

Suggested fix: add `usageReadChunkBytes` to `RoomConfig` and pass it through `UsageObserverOptions`.
