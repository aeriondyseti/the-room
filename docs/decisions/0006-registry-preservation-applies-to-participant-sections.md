---
id: ADR-0006
status: accepted
date: 2026-09-28
made-in: "0.2"
supersedes: []
superseded-by:
tags: [registry]
---
# Registry preservation applies to participant sections

## Context and Problem Statement

Review found that the short invariant wording could imply unrelated configuration is supported in session.toml,
contrary to Kevin's minimum-only registry requirement.

## Decision Outcome

Normal joins preserve every other participant section and accept only harness and session_id within each.
Unsupported top-level tables cause explicit refusal without changing the file. The known legacy schema is converted
only by explicit migration, with an exact backup under ignored .room/ before atomic replacement. Embedded send
commands are parsed as inert strings.

### Consequences

Machine configuration stays outside the registry. Changed native bindings require an expected previous binding so
simultaneous enrollment cannot silently replace another session. A crashed registry writer leaves a lock requiring
owner verification before manual removal; it is never stolen on a timeout. Service-owner crash recovery is a
separate feature (1.2).

## More Information

Decision-makers, as first recorded: Astra.
