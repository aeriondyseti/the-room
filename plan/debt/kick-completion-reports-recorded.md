---
title: Completing an already-unanimous kick reports a vote that wasn't cast
where: src/contracts/lifecycle.ts
source: task 8.3 cross-review (fable)
date: 2026-09-28
confidence: 40
---
# Completing an already-unanimous kick reports a vote that wasn't cast

An already-unanimous kick proposal (including one whose voting window expired) is completed by any agent's next
`room_kick` call for that target, the target's own included, and the outcome reports `vote: 'recorded'` for that
caller although it cast no counted vote. Severity: low. Source: `git show v0.9.0:reviews/8.2-8.4-surfaces.md`.

## Why it waits

It is consistent with the restart-completion design; the removal itself is correct and the text names the real
voters.

Suggested fix: add an additive `vote: 'completed'` disposition to `KickOutcome` and render it ("the decision was
already unanimous; you did not vote").
