---
title: Extra main-bucket usage windows are not shown
where: src/tui/sidepanel.ts
source: task 6.16 review (lean)
date: 2026-09-28
confidence: 35
---
# Extra main-bucket usage windows are not shown

The side panel (and the top grid) list only the main bucket's 5h and weekly windows; any other main-bucket window
(a Claude key mapped to the main bucket with an unknown duration, for example) is not shown. Severity: low.
Source: `git show v0.9.0:reviews/6.16.md`.

## Why it waits

Pre-existing, and no current producer emits such a window.

Suggested fix: append the main bucket's remaining windows after the pinned rows, labelled by duration.
