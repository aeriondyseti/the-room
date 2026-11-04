# Glossary

The only home of the repo's words. A rename keeps its old word in "Not" until the next milestone release.

## The project

| Word | Meaning | Not |
| --- | --- | --- |
| the-room | This project: a local chat room for coding agents, directed by Kevin from a TUI | vibe-pairing (the old name, renamed after v0.9.0) |
| room | One repository's shared conversation and its service; linked worktrees share it | |
| room root | The checkout that owns the repository's common git directory (or `ROOM_ROOT`); holds `session.toml` and `.room/` | |
| pair-poc | The interim messaging tool in `poc/` that the agents used before the real room | |

## Participants

| Word | Meaning | Not |
| --- | --- | --- |
| harness | The agent program a participant runs in: Claude Code or Codex | |
| participant | A registered name in the room: an agent, or the human | |
| registry | `session.toml`: each participant's `harness` and `session_id`, nothing else | |
| binding | A participant's native identity (harness plus session or thread id); identity is the binding, a name is a label | |
| rebind | Moving a name to a new native session, for future deliveries only | |
| liveness | Whether a participant's session is observed `online`, offline or `unknown` | |
| rename | Moving a participant's registry section to a new name without a restart | |
| kick | One verb that opens or joins a proposal to remove an agent; unanimity of the online electorate executes it | |
| notice | A system message (`ROOM NOTICE`) about a lifecycle event; it carries no authority | |

## Messages and delivery

| Word | Meaning | Not |
| --- | --- | --- |
| delivery | One (message, recipient) pair, with its state and attempt history | |
| native delivery | Handing a message to the harness's own transport: the Claude messaging pipe, or `codex queue` | |
| envelope | The text a recipient's harness receives: a first-line room header, the message, a reply hint | |
| human directive | A message from Kevin, marked as such in the envelope header | |
| peer message | A message from another agent; it carries no authority | |
| submitted | The native transport accepted the message; not proof it was read | |
| uncertain | The message might already have been delivered; never retried automatically | |
| snapshot | An opaque token naming which addressed messages an agent has been shown; a guarded send needs one | |
| crossing guard | The check that refuses an agent's send while something addressed to it is not covered by its snapshot | |
| baseline | A deliberate, audited skip of old history without review | |
| withdraw | Cancelling a delivery before the harness accepts it; leaves a tombstone | |
| urgent | A send with a reason that skips the guard's freshness check and takes the urgent lane | |
| hold | The short wait before an ordinary delivery can be claimed, so withdraw is useful | |
| burst | Consecutive held messages from one sender to one recipient, delivered as one envelope | |
| pause | Holding future deliveries and sending one stop request; cooperative, never an interrupt | |

## The TUI

| Word | Meaning | Not |
| --- | --- | --- |
| top bar | The layout with AGENTS and BUDGETS grids above the conversation | |
| left panel | The other layout: participants and budgets in a side panel | |
| chip | One agent's compact status in the top bar | |
| activity view | The read-only view of one agent's tool calls, results and messages (`/activity`) | |
