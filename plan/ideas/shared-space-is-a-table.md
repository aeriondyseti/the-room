---
title: Rename the shared space from "room" to "table"
raised-by: Kevin
date: 2026-11-13
trigger: Kevin picks it up; he raised it for later
---
# Rename the shared space from "room" to "table"

The project is agent-roundtable, and ADR-0021 renamed everything people and agents type (`roundtable`,
`roundtable_*`, `ROUNDTABLE_*`, `.roundtable/`, the `[roundtable …]` header). The shared space itself is still called
a "room". Kevin's idea (2026-11-13): make the domain term "table", so the words match the name.

What it covers:

- prose in the README, the reference docs, the skill and `AGENTS.md` ("join the room", "room messages", "the room is
  paused"), and the glossary entry;
- text agents and the human read: envelope footers, notices (`ROOM NOTICE`), errors and hints, CLI and TUI output;
- identifiers: `RoomService`, `RoomError`, `RoomMessage`, `RoomState`, `resolveRoomRoot`, `roomRoot`;
- protocol and storage names: `room.updated` events, the `room` field in IPC results, `room.db`, the `room_state`
  table, the `vibe-room-` pipe name.

Points to settle when this is promoted:

- Whether storage and protocol names change at all. Renaming `room.db` or `room_state` needs a migration, and
  renaming the pipe or event names breaks a client and a service built on different sides of the change. After
  1.0.0 these are breaking changes to the public API.
- Whether the `vibe-pairing` salts and the `~/.vibe-pairing` cache are tidied in the same pass. Changing a salt
  changes derived ids, so deduplication across the change needs thought.
- "Table" already means a database table in this codebase; the wording has to keep the two apart.
