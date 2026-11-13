---
title: The top bar shows "inbox covered" and "no inbox info" the same way
where: src/tui/topbar.ts
source: task 7.4 review (lean)
date: 2026-09-28
confidence: 35
---
# The top bar shows "inbox covered" and "no inbox info" the same way

In the top bar, "inbox covered" and "no inbox info from the service" both render blank; the side panel
distinguishes them. Severity: low. Source: `git show v0.9.0:reviews/7.4.md`.

## Why it waits

Deliberate for now: blank for unknown matches how other unknown chip parts are omitted, and a marker on every
pre-Milestone-7 or unknown agent would be noise.

Suggested fix: if it proves confusing, add a quiet "inbox ?" for online agents with no info.
