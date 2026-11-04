---
title: MCP limits are literals, not tunables
where: [src/mcp/server.ts, src/mcp/identity.ts]
source: task 2.4 review
date: 2026-09-28
confidence: 50
---
# MCP limits are literals, not tunables

MCP literals (`room_read` default 20 and max 100, the ancestor walk depth, the process-table timeout of 5 s and
cache of 10 s) are not `ROOM_*` tunables. Severity: low. Source: `git show v0.9.0:reviews/2.4.md`.

## Why it waits

Sensible defaults; no user has needed to change them.

Suggested fix: add `mcp*` keys to `RoomConfig` and pass them from `runMcpServer`.
