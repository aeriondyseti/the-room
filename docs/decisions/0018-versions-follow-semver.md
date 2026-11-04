---
id: ADR-0018
status: proposed
date: 2026-11-03
decision-makers: [Kevin]
made-in: trunk
supersedes: [ADR-0003]
superseded-by:
tags: [versions]
---
# Versions follow semver from the next release

## Context and Problem Statement

ADR-0003 numbered each merged sprint `0.0.N` and reserved the number over pair-poc at merge. The tags followed it
through `v0.0.23`; from `v0.1.0` they counted milestones in the minor and follow-ups in the patch, up to `v0.9.0`,
which ADR-0003 does not describe. Seven commits on `main` since `v0.9.0` are untagged. Kevin's process (2026-11-03)
gives every repo one version format, plain semver, bumped by the kind of change; a repo whose tags are already
valid `vX.Y.Z` cuts over rather than retagging.

## Decision Outcome

- Versions are plain [semver](https://semver.org/), tagged `vMAJOR.MINOR.PATCH`, measured against the public API
  named in `docs/reference/design.md`.
- Cut over: every existing tag stays as it is. The next release bumps MINOR (`v0.10.0`), and its CHANGELOG entry says
  versions follow semver from there.
- Before 1.0.0, every merged task is a release. Its bump is read from its CHANGELOG section: Removed or a Changed line
  marked **BREAKING** → MINOR; Added or Deprecated → PATCH; only Fixed, Security or other Changed → PATCH.
- Versions are assigned at merge, in merge order, by the release command (`bun tools/release.ts`); nothing is
  reserved in advance, and no task id appears in a version.
- The version stays single-sourced in `package.json`.
- Moving to 1.0.0 is Kevin's call, recorded as a decision, and needs the release gate (only the release command tags).

### Consequences

Nothing that cites an old version breaks. The merge-request exchange that reserved the next `v0.0.N` is no longer
needed; the rule "one merge into `main` at a time, `npm test` on `main` after the merge, then tag" stays, in
`AGENTS.md`.

## More Information

Drafted at the docs migration of 2026-11-03 from Kevin's global versioning rule. Proposed: ADR-0003 stays in force
until Kevin accepts this record, which then supersedes it.
