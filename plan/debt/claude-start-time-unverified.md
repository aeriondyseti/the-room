---
title: Claude delivery proceeds when the process start time can't be verified
where: src/adapters/claude/registry.ts
source: task 2.2 cross-review (Astra)
date: 2026-09-28
confidence: 50
---
# Claude delivery proceeds when the process start time can't be verified

The Claude adapter still submits when the session record's process start time cannot be verified (the PowerShell
query failed, or no `procStart` was recorded); the probe reports liveness `unknown` in that case. Severity: low.
Source: `git show v0.9.0:reviews/2.2.md`.

## Why it waits

Blocking would stall every Claude delivery wherever the start-time query is unavailable. The evidence that makes it
safe: the target pipe name and key file are bound to that exact session (the key file name hashes the pipe path,
and the pipe dies with the process), so a reused pid cannot serve it. The worst case is a connect failure
(`failed`), never delivery to the wrong session.

Suggested fix: add a cheaper, reliable start-time source (a native process query, for example) so unverified
becomes rare; surface `unverified` in delivery evidence if Kevin wants it visible.
