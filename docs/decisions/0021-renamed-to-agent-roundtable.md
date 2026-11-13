---
id: ADR-0021
status: accepted
date: 2026-11-13
made-in: trunk
supersedes: []
superseded-by:
tags: [naming, cli, mcp]
---
# The project is agent-roundtable, and every name people and agents type follows it

## Context and Problem Statement

The project was renamed from vibe-pairing to the-room in November 2026. Kevin wanted a name that says what it is: a
cooperative-programming system for people who use coding agents from more than one provider. The repository had only
just been made public and no room was in use, so nothing outside this repo depended on the old names.

## Decision Outcome

- The project is **agent-roundtable**: the repository, the package and the name in the docs.
- The names people and agents type follow it. The CLI is `roundtable`, the MCP server is `roundtable` and its tools
  are `roundtable_*`, configuration is `ROUNDTABLE_*`, the state directory is `.roundtable/` and the envelope header
  opens with `[roundtable …]`. No old name is kept as an alias.
- No migration: nothing moves an earlier `.room/` directory and nothing reads the old names. Backward compatibility
  would be code with no user.
- "Room" stays the word for the shared space, so internal names (`RoomService`, `room.db`, the `room_state` table,
  `room.updated` events, the pipe name) are unchanged, as are the earlier `vibe-pairing` salts and the
  `~/.vibe-pairing` cache.

### Consequences

An MCP registration, a permission entry (`mcp__room__room_*`) or a `ROOM_*` setting made before the rename does
nothing; it is set up again as `docs/reference/operations.md` describes. Records written before this one keep the
names of their time.

## More Information

Kevin, 2026-11-13. He chose the name and the `roundtable` prefix, asked for every user-facing name to follow, and
ruled out backward compatibility. Renaming the shared space itself from "room" to "table" is parked as an idea.
