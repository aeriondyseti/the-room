---
title: A Claude auth rejection is reported uncertain, not failed
where: src/adapters/claude/pipe.ts
source: task 2.2 review
date: 2026-09-28
confidence: 55
---
# A Claude auth rejection is reported uncertain, not failed

A Claude receiver that rejects our auth token closes the connection after both frames are written, so the delivery
is reported `uncertain` rather than `failed`, which task 2.2's Done-when asked for on auth failures. Severity: low.
Source: `git show v0.9.0:reviews/2.2.md`.

## Why it waits

The protocol sends no auth acknowledgement, so an auth rejection can't be told apart from a close after delivery;
`uncertain` is the honest result. The token is re-read from the key file on every submit, so stale tokens are rare.
Task 6.3b qualified the pipe live and saw no receipt or status frames
(`git show v0.9.0:probes/claude-pipe-frames.md`).

Suggested fix: if Claude adds an auth acknowledgement or a status frame, wait for it before writing the user frame.
