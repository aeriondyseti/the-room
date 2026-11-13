---
title: A wide delivery-mark chunk is ellipsised instead of wrapped
where: src/tui/format.ts
source: task 7.4 review (lean)
date: 2026-09-28
confidence: 35
---
# A wide delivery-mark chunk is ellipsised instead of wrapped

A single delivery-mark chunk wider than the conversation (a long name plus " withdrawn HH:MM", or " preview +
reference") is ellipsised by `fitLine` instead of wrapping. Severity: low. Source: `git show v0.9.0:reviews/7.4.md`.

## Why it waits

Only at very narrow widths with long names; the state glyph and word still lead the chunk.

Suggested fix: wrap within a chunk (the name on its own row) instead of `fitLine`.
