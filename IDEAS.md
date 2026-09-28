# Ideas

Parked ideas. **Not part of [proposal.md](proposal.md) and not committed
to.** An idea moves into the proposal only when Kevin decides to fold it in.

## Background agents: the TUI as the single point of control

*Raised 2026-09-28 by Kevin. Status: parked, not scoped.*

**Idea:** agents run backgrounded, with no terminal UI of their own. The
room TUI becomes the one place to watch, direct, and control every
connected agent.

### Check results (2026-09-28, still parked)

Details: Claude —
[probes/claude-background-results.md](probes/claude-background-results.md);
Codex — `probes/codex-background-results.md` (Astra; runner
`probes/codex-background-check.mjs`). All checks used throwaway sessions and
threads.

| Capability, with no TUI | Claude Code 2.1.283 (`--bg`) | Codex 0.157.1 (app-server daemon) |
|---|---|---|
| Host the agent | ✅ `claude --bg -n <name>` | ✅ daemon `thread/start`, or adopt via `thread/resume` |
| Wake on a message | ✅ pipe message | ✅ `codex queue` consumed while idle (about 0.2 s to turn start); busy → next turn |
| Watch the work | ✅ live transcript JSONL; registry `status`/`waitingFor`; `claude agents --json` | ✅ rollout JSONL grows with tool calls, results, tokens and interruptions |
| Approve a permission prompt | ❌ only via `claude attach` or agent view. A priority `now` message *denies* it | ✅ the approval request reaches subscribed app-server clients and survives disconnects (replayed on reconnect). Cancel verified; **grant not tested** |
| Soft interrupt (keep the session) | ❌ no external path | ✅ `turn/interrupt` cancelled a running turn in about 0.2 s; the thread resumes |
| Hard stop | ✅ `claude stop <id>` in under 1 s; resumes on the same id | (`turn/interrupt` suffices) |
| Headless per-message fallback | — | `codex exec resume` keeps the id when the thread is unowned, but **fails** when the daemon or a TUI holds it |

**Takeaways:**
- **Codex is the more controllable background harness:** approvals and
  soft interrupt both go through its app-server.
- **Claude's gap is approvals.** Pre-scope permissions
  (`--allowedTools` / `--permission-mode`) or hand off to `claude attach`
  when `waitingFor` shows a prompt.
- **Untested:** long-idle expiry, daemon restart, the documented 30-minute
  unload grace, and repeated-trial reliability.

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

## Weekly subscription usage per harness

*Raised 2026-09-28 by Kevin. Status: parked, not scoped.*

**Idea:** show how much of each harness's weekly subscription allowance (Claude plan limits, Codex/ChatGPT
plan limits) has been used — room-wide and per agent — in the TUI (e.g. a header meter with reset time),
alongside the per-agent token/context usage the MVP already shows.

**Open questions / checks before scoping:**
- Where the numbers come from: whether each harness exposes plan-usage data locally (CLI status/usage
  commands, local state files, or a documented API) versus only in its own UI. Read-only sources only —
  invariant 8 (never write harness state) applies.
- Whether it's per account (shared by all agents of that harness) or attributable per session; the TUI must
  label which (invariant 3: honest state — unavailable is shown as unavailable, never as zero).
- Freshness and polling cost; the reset-window semantics (rolling vs fixed weekly).

## Harness-update compatibility probes

*Raised 2026-09-28 by Kevin. Status: parked bonus feature; implement after v0.1.0.*

**Idea:** a repeatable probe suite to run whenever Claude Code or Codex updates, checking that the
harness behavior the room depends on still holds. Reuse the existing identity, messaging and background
probe evidence instead of assuming internal protocols remain stable across versions.

**Candidate checks:**
- Native delivery wakes an idle session, busy messages run in order as later turns, and an offline
  recipient does not stall other recipients. Record enqueue, turn-start and reply times separately.
- Exact routing with multiple instances of each harness; no cross-session delivery. MCP caller identity
  remains correct across concurrent sessions, resume and identity rotation; stale bindings are detected.
- Claude registry/process-start/pipe/key resolution and framing; Codex queue argv quoting, Unicode,
  envelope budget and returned native id. Never log authentication material.
- Honest submission evidence, ambiguous-error handling, no automatic duplicate resend, service restart
  recovery, and cooperative pause semantics. Explicitly distinguish room invariants from harness facts.
- Approval waits and refusals remain visible without treating submission as processing or bypassing
  harness permissions. Optional observer checks verify usage formats, cursors and unavailable states.
- Background hosting/interrupt checks remain optional until that feature is adopted; baseline MCP and
  native-delivery checks should not require the parked background architecture.

**Execution and output:** use isolated throwaway sessions and fixtures, never a user's active thread.
Record harness/build versions, OS/Node version, launch mode, transport, trial counts and cleanup results.
Emit a concise human report plus machine-readable results: pass, fail, unsupported, or not tested; keep
raw evidence with secrets redacted and compare against the last qualified baseline. A preflight smoke
suite should finish quickly; an explicit extended mode can repeat trials and exercise crash/recovery.
A changed assumption should identify the adapter/invariant affected and the next diagnostic step,
without silently changing config, permissions or delivery paths. Run on demand initially; detecting a
new harness version can later offer the suite through `room doctor`.

**Done-when if promoted:** both harnesses can be requalified from one documented command, a deliberately
broken fixture is detected, ambiguous results cannot pass, reports compare versions, and all created
sessions/processes are accounted for in cleanup.
