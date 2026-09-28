# Ideas

Parked ideas. **Not part of [proposal.md](proposal.md) and not committed
to.** An idea moves into the proposal only when Kevin decides to fold it in.

## Background agents: the TUI as the single point of control

*Raised 2026-09-28 by Kevin. Status: parked, not scoped.*

**Idea:** agents run backgrounded, with no terminal UI of their own. The
room TUI becomes the one place to watch, direct, and control every
connected agent.

**What we already know:**
- **Claude (proven):** background sessions (`claude --bg --name X`)
  register a messaging pipe like any other session. A pipe message wakes a
  `--bg` session (see [findings-claude-messaging.md](findings-claude-messaging.md)),
  and the Claude participant in this project is itself a background
  session driven entirely by messages. `claude stop` and `claude rm` exist
  for lifecycle.
- **Codex (not proven):** `codex queue` items only ran once a TUI had the
  thread loaded; with no TUI they sat in the queue (see
  [findings-codex-messaging.md](findings-codex-messaging.md)). Background
  Codex would need threads hosted by the shared app-server daemon (the one
  behind `codex agents` and `remote-control`), and it's unknown whether
  that host consumes queued input by itself. A guaranteed but
  less elegant fallback: the room runs `codex exec resume <thread>
  "<message>"`, serialized, one per message, for background-only agents.

**What it would pull forward** (each agent's own terminal covers these
today):

| Need | Why | Candidate mechanism |
|---|---|---|
| Seeing the work | With no terminals, the messages-only MVP leaves Kevin blind to tool calls | The post-MVP transcript observer (Claude/Codex JSONL) becomes required |
| Permission prompts | No pane to answer them, so the agent stalls | Pre-approved policies (allowlists, auto modes) or passing approvals through the TUI. The Codex app-server sends approval requests to its client; Claude `--bg` behaviour is unknown |
| Hard stop | Pause is only a request, and there's no Esc key | `claude stop`; Codex `turn/interrupt` via the app-server. Both untested |
| Lifecycle | Current scope is "attach only, never launch" | The room would start and stop agents, which reverses that decision |

**Checks to run if pursued:**
1. Codex: does a daemon-hosted thread consume `codex queue` items on its
   own, and how do you move a thread onto the daemon (or background it)?
2. Claude: what happens to a permission prompt in a `--bg` session?
3. Hard stop: `claude stop` and Codex `turn/interrupt` behaviour, including
   the effect on the session's resumability.
4. Observation: transcript tailing for background sessions of both
   harnesses.

**Design guidance meanwhile (no commitment):** keep the MVP delivery
adapters independent of how the agent is hosted — don't assume a TUI is
attached — so this remains possible later.
