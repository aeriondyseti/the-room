---
id: ADR-0001
status: accepted
date: 2026-09-28
decision-makers: [Claude]
made-in: trunk
supersedes: []
superseded-by:
tags: [process, design]
---
# Pre-implementation design decisions live in DESIGN.md

## Context and Problem Statement

Foundational design choices were settled before any code was written, in the reconciled proposal
(`git show v0.9.0:proposal.md`). We need a single source of truth without duplicating them across documents.

## Decision Outcome

DESIGN.md (now `docs/reference/design.md`) summarizes the reconciled proposal, which it incorporates by reference,
and pins the load-bearing invariants. This log starts from the first build sprint.

### Consequences

For "why is it this way", read DESIGN.md, then the proposal, then the ADRs. If an implementation choice contradicts
DESIGN.md or the proposal, the ADR records the deviation and DESIGN.md is updated to cite it.
