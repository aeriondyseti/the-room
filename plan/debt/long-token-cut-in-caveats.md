---
title: An over-long token in a caveat is cut, not wrapped
where: src/tui/topgrid.ts
source: task 6.10 cross-review (Astra)
date: 2026-09-28
confidence: 30
---
# An over-long token in a caveat is cut, not wrapped

`wrapQuiet` word-wraps caveats and reasons, but a single unbroken token longer than the line (a long path in an
unavailable reason, for example) is still cut by its final `fitLine`. Severity: low.
Source: `git show v0.9.0:reviews/6.10.md`.

## Why it waits

Normal caveats and reasons are short words; nothing else is ever cut.

Suggested fix: hard-break over-long tokens across continuation rows instead of fitting them.
