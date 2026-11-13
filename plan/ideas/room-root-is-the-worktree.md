---
title: A room lives in the worktree it discusses
raised-by: Kevin
date: 2026-11-04
trigger: The next room started in a repo that uses the container layout
---
# A room lives in the worktree it discusses

Kevin's repos now use the container layout: `X:\Development\<repo>\` holds a bare `.git\`, the trunk's worktree
`main\` and one worktree per task. Today `resolveRoomRoot` (`src/core/registry/root.ts`) returns the parent of the
common git directory, so from any worktree in a container the room lands at the container's top level, one room
shared by `main\` and every task worktree.

Kevin's rule (2026-11-04): a room's `.roundtable/` and `session.toml` go into the worktree the room is discussing. So the
root becomes the worktree itself (`git rev-parse --show-toplevel`), one room per worktree, and a room about task
`012.02` lives in `012.02_<slug>\` and leaves with it.

Points to settle when this is promoted:

- The pipe name is a hash of the root path, so every existing room's identity changes once; rooms are short-lived, so
  that is likely acceptable, but say so in the release notes.
- What a session in `main\` does when the room it wants is in a task worktree (today it would find the shared one).
- `ROUNDTABLE_ROOT` stays as the explicit override.
- Gitignore `.roundtable/` and `session.toml` in each repo's worktrees, as today.
