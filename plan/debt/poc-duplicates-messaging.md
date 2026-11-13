---
title: pair-poc duplicates the room's messaging
where: poc/pair-mcp.mjs
source: shortcut at bootstrap
date: 2026-09-28
---
# pair-poc duplicates the room's messaging

`poc/` (pair-poc) duplicates messaging logic that the real room replaces, and its participant ids are hard-coded
in `poc/participants.json`. Severity: low.

## Why it waits

It was needed for coordination until task 4.1 moved both agents onto the real room.

Suggested fix: delete `poc/` once nothing uses it (`docs/reference/operations.md` says how to remove its MCP
registrations).
