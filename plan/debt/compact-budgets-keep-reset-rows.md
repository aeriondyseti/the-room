---
title: Compact budgets keep own-row resets before quotas
where: src/tui/sidepanel.ts
source: task 6.16 cross-review (Astra)
date: 2026-09-28
confidence: 30
---
# Compact budgets keep own-row resets before quotas

Compact budgets only shorten notes. When resets are on their own rows (narrow panels), compact mode could drop those
rows (the reset stays in `/who` and the top bar), so a short panel shows more quotas before "+ more usage".
Severity: low. Source: `git show v0.9.0:reviews/6.16.md`.

## Why it waits

Reset rows only appear on panels too narrow for inline resets, and the marker already announces anything cut.

Suggested fix: in compact mode, omit own-row resets before cutting quotas.
