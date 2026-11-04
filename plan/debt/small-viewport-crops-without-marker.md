---
title: Small viewports crop overlays without a "more" marker
where: src/tui/app.tsx
source: task 6.18 review (lean)
date: 2026-09-28
confidence: 40
---
# Small viewports crop overlays without a "more" marker

In a very small viewport (2 or 3 rows: a 12-row terminal plus banner or feedback), `/who`, the activity pane, the
empty state and the load-failed notice crop their content with no "more" marker; the help and detail pagers do
announce it. Severity: low. Source: `git show v0.9.0:reviews/6.18.md`.

## Why it waits

Pre-existing (they cropped under the old 3-row floor too), and only on minimum-size terminals.

Suggested fix: give `WhoOverlay`, `ActivityPane` and `EmptyState` the pager treatment (slice to height minus one,
plus "↓ N more · PgDn").
