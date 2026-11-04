---
id: ADR-0014
status: accepted
date: 2026-09-28
decision-makers: [Claude, Astra]
made-in: M7
supersedes: []
superseded-by:
tags: [crossing-guard, cli, release]
---
# M7 surfaces: strict guard with no fallback, CLI exit 4, one combined release

## Context and Problem Statement

7.1 makes the service reject legacy agent sends. The CLI and MCP surfaces (7.3) are what give agents snapshots, and
our own coordination runs through the main checkout's CLI.

## Considered Options

An advisory (unguarded) mode during migration was rejected as a bypass. Sequential 7.1-then-7.3 merges were rejected
because they leave main red in between.

## Decision Outcome

- The surfaces always route agent sends through `guarded_send`. There is no silent fallback to `send` on an older
  service, because an unknown method there is a generic `bad_request`, indistinguishable from a real input error.
- The CLI exits **4** when the guard refused a send (nothing queued) or a withdraw cancelled nothing. This is
  distinct from input errors (2) and service errors (3).
- M7 ships as **one** `--no-ff` merge of `release/m7` (main + 7.1 + 7.2 + 7.3 + 7.4, each branch's history intact),
  so main is green at every commit, tagged **v0.8.0**.
- Until Kevin restarts the live service, the agents coordinate with a pinned v0.7.6 CLI build (a worktree named
  cli-v0.7.6 under the old `.claude/worktrees/` folder, `ROOM_ROOT` set to the room). Neither agent restarts the
  service.

## More Information

The old log gave this record no status line or author; it is converted as accepted (it shipped in v0.8.0).
