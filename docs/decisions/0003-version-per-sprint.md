---
id: ADR-0003
status: accepted
date: 2026-09-28
decision-makers: [Claude]
made-in: trunk
supersedes: []
superseded-by:
tags: [versions]
---
# Version scheme: v0.0.N per sprint, v0.1.0 = MVP + polish

## Context and Problem Statement

sprint-loop's default `0.<milestone>.<feature>` scheme would produce `v0.1.x` tags before release, which collides
with Kevin's explicit "tag v0.1.0 after MVP plus polish".

## Decision Outcome

- Each merged sprint takes the next pre-release version `0.0.N`, sequential across both agents and reserved over
  pair-poc at merge handoff. It's tagged `v0.0.N` on the merge commit.
- The release after Milestone 5 is tagged `v0.1.0`.
- The version is single-sourced in `package.json`.

### Consequences

Tag numbers don't encode the feature id; the progress dashboard's notes (`git show v0.9.0:PROGRESS.md`) map feature
to tag.
