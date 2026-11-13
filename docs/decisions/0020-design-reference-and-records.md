---
id: ADR-0020
status: proposed
date: 2026-11-03
made-in: trunk
supersedes: [ADR-0001]
superseded-by:
tags: [process, design]
---
# The design is a reference file; the pre-build proposal is history

## Context and Problem Statement

ADR-0001 made DESIGN.md the summary of the reconciled proposal, incorporating the proposal by reference and pinning
the load-bearing invariants. Kevin's docs process (2026-11-03) puts what is true now in `docs/reference/`, the
repo-wide rules (invariants included) in `AGENTS.md`, and decisions in one record per file; finished specs leave the
tree.

## Decision Outcome

- `docs/reference/design.md` (formerly DESIGN.md) holds what is true now: purpose, scope, the public API that
  versions are measured against, architecture and what is built. It is edited in place.
- The load-bearing invariants are rules for working on the repo, and live only in `AGENTS.md`.
- The reconciled proposal, the two original proposals, the reconciliation review and the messaging findings are
  history, read with `git show v0.9.0:proposal.md` (and the same tag for the others). Design reasoning from before
  the build is not re-recorded as decision records; the record series starts from the first build sprint.
- When an implementation choice contradicts the design, a new record states the decision and `design.md` is edited
  to match.

## More Information

Drafted at the docs migration of 2026-11-03. Proposed: ADR-0001 stays in force until Kevin accepts this record.
