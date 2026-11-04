---
title: TUI scrollback anchors by line count
where: src/tui/app.tsx
source: task 3.1 review (lean)
date: 2026-09-28
confidence: 40
---
# TUI scrollback anchors by line count

TUI scrollback anchors by line count from the bottom, so a resize or rewrap while scrolled up can shift the
viewport. Severity: low. Source: `git show v0.9.0:reviews/3.1.md`.

## Why it waits

Rare: only while scrolled up and resizing. Following live is unaffected.

Suggested fix: anchor on (message id, line offset) instead of a raw line offset.
