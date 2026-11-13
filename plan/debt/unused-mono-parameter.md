---
title: The mono parameter is no longer used by the bar renderers
where: [src/tui/topbar.ts, src/tui/sidepanel.ts]
source: task 6.8 review (lean)
date: 2026-09-28
confidence: 30
---
# The mono parameter is no longer used by the bar renderers

`mono` is no longer used by `participantChip`, `participantLines`, `accountSegments` or `sidePanelLines`: the `!`
marker now shows in every theme. Severity: low. Source: `git show v0.9.0:reviews/6.8.md`.

## Why it waits

Harmless; removing it touches many call sites and tests.

Suggested fix: drop the parameter in a cleanup pass.
