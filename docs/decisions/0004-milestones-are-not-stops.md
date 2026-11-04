---
id: ADR-0004
status: accepted
date: 2026-09-28
decision-makers: [Claude]
made-in: trunk
supersedes: []
superseded-by:
tags: [process]
---
# Don't stop at milestone boundaries

## Context and Problem Statement

The bootstrap CLAUDE.md template lists "a milestone completes" as a stop condition, but sprint-loop and Kevin's
overnight directive say to run to completion.

## Decision Outcome

Milestone boundaries are not stops. Stop only on the sprint-loop "truly irrecoverable" conditions. The v0.1.0 tag is
a gate for starting Milestone 6, not a stop.

### Consequences

Kevin reviews asynchronously via the room log and git history.
