---
title: Move the checkout into the container layout
---
# Move the checkout into the container layout

Kevin's act: move `X:\Development\the-room\` to the container layout (the bare repository plus `main\` and one
worktree per task), as `AGENTS.md` (Git) describes. The move changes absolute paths, so, as with the earlier rename
(`scripts/rename-local-checkout.ps1`): stop the room service and close the TUI first, then re-register the room MCP
server in each harness, redo the global `npm link`, and re-establish Codex project trust for the new path.

Check first: the room root is the checkout that owns the repository's common git directory
(`src/core/registry/root.ts`). With a bare `.git\` in the container, that resolves to the container folder itself,
so `session.toml` and `.room/` would land beside `main\` rather than in it. The same applies to every other repo
that runs a room once it moves. Decide where those files should live (setting `ROOM_ROOT`, or a code change in a
task) before moving any repo whose room is in use.

Done when the checkout is `X:\Development\the-room\main\`, the room opens from it with its history, and both
harnesses reach the room's MCP tools.
