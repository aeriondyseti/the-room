---
title: The activity pane acts on key release events
where: src/tui/activity.tsx
source: task 7.6 review (lean, adjacent)
date: 2026-09-28
confidence: 40
---
# The activity pane acts on key release events

The activity pane's own key handler acts on key release events (CSI-u type 3) as if they were presses; the app and
the settings pane ignore them. Severity: low. Source: `git show v0.9.0:reviews/7.6c.md`.

## Why it waits

Pre-existing (since task 6.1), and only in terminals that report releases (Windows Terminal with the kitty
protocol, for example).

Suggested fix: add `if (key.eventType === 'release') return;` first in `ActivityPane`'s `useInput`, with a test.
