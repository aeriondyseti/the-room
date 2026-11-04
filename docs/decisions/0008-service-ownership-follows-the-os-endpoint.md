---
id: ADR-0008
status: accepted
date: 2026-09-28
decision-makers: [Astra]
made-in: "1.2"
supersedes: []
superseded-by:
tags: [service]
---
# Service ownership follows the operating system endpoint

## Context and Problem Statement

Deleting a supposedly stale lock file can race another auto-starting service. Native Windows named-pipe bind was
verified to reject a second listener with EADDRINUSE.

## Decision Outcome

Bind the canonical room endpoint exclusively before opening the writable ledger. The live endpoint is the
authoritative owner lock; .room/service.lock records PID and a random nonce for diagnostics, and is replaced only by
the winner of that exclusive bind. Clients probe hello, auto-start detached when absent, and wait for readiness.
Shutdown removes only its own nonce.

### Consequences

Stale diagnostic files cannot block startup or cause lock stealing. A listener using an incompatible protocol is
reported, not replaced. Native Windows is the qualified platform; Unix stale socket-path recovery requires separate
qualification. Registry formatting/comments are normalized by TOML serialization; all other participant values are
preserved (ADR-0006).
