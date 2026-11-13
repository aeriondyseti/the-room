---
title: The identity walk depth is a literal 8
where: src/mcp/identity.ts
source: task 2.6 review
date: 2026-09-28
confidence: 35
---
# The identity walk depth is a literal 8

The MCP and CLI identity walk depth is 8 (it was 4) and a literal. A deeper walk slightly raises the chance of
passing an unrecognized harness executable on the way to a Claude ancestor. Severity: low.
Source: `git show v0.9.0:reviews/2.6.md`.

## Why it waits

Ancestors must be start-time verified; codex, agy and gemini stop the walk; the node-based harness risk only applies
to the CLI environment fallback, which excludes node.

Suggested fix: make the depth a `ROUNDTABLE_*` tunable (with `mcp-literals-not-tunable.md`); consider an allowlist of
intermediate executables for the walk too.
