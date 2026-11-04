---
title: Unknown error codes are downgraded to internal
where: src/contracts/errors.ts
source: task 0.1 review
date: 2026-09-28
confidence: 35
---
# Unknown error codes are downgraded to internal

`fromErrorInfo` downgrades unknown error codes to `internal`; the original code survives only in the message text.
Severity: low. Source: `git show v0.9.0:reviews/0.1.md`.

## Why it waits

Codes are a closed set shared by both sides at one protocol version.

Suggested fix: if the protocol versions ever diverge, carry the original code in a field.
