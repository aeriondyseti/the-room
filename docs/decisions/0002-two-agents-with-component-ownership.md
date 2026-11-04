---
id: ADR-0002
status: accepted
date: 2026-09-28
decision-makers: [Kevin, Claude]
made-in: trunk
supersedes: []
superseded-by:
tags: [process, agents]
---
# Two agents run the sprint loop in parallel with component ownership

## Context and Problem Statement

Kevin asked Claude and Astra (Codex) to build the system overnight following `/sprint-loop`, coordinating with each
other. Two agents on one trunk risk conflicting edits and racing merges or tags.

## Decision Outcome

- Every roadmap feature has one owner: Astra takes the service core, registry, Codex adapter and CLI; Claude takes
  the skeleton and contracts, Claude adapter, MCP server, observer, TUI and onboarding.
- Each owner works in its own worktree on `sprint/<id>` cut from the latest `main`, and edits only its own progress
  and roadmap rows.
- Merges into `main` and tag numbers are serialized over pair-poc: announce, merge, announce done.

### Consequences

Features can proceed in parallel when their dependencies are met. Doc conflicts are resolved at merge without
overwriting the other agent's rows. Ownership can change by agreement, noted in the progress dashboard.
