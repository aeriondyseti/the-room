---
id: ADR-0013
status: accepted
date: 2026-09-28
decision-makers: [Kevin, Astra]
made-in: "7.2"
supersedes: []
superseded-by:
tags: [delivery, crossing-guard]
---
# Urgent Room queue lane and native cancellation cutoff (M7)

## Context and Problem Statement

Kevin delegated crossing-guard ergonomics and explicitly set native acceptance as too late to recall.

## Decision Outcome

Withdrawal races the broker's synchronous dispatch claim; in-flight or uncertain submissions never return successful
cancellation. Tombstones are terminal, history and dedup identities remain, and no harness queue/history is edited.
SQLite schema version 2 adds the withdrawn state; older service builds cannot open that schema, so downgrade requires
restoring a pre-upgrade backup rather than using the migrated DB.

Urgent messages require a reason, bypass only freshness, and take priority over ordinary broker-pending messages.
FIFO holds within each lane. This is an intentional exception to invariant 4's single FIFO: it does not preempt an
in-flight submission, accepted native message, or human Pause. The dispatcher rechecks the lane head after
asynchronous probing and before claiming submission. The lane is persisted on each new delivery. No promise of
immediate model processing or automatic interruption is made.

## More Information

The old log gave this record no status line, author or sprint; it is converted as accepted (it shipped in v0.8.0
and invariant 4 cites it). The task is inferred from the old roadmap, whose 7.2 Done-when asked for this ADR.
