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

**Found during 2.5 (2026-09-28):** Codex already writes this locally — every `token_count` event in the rollout JSONL carries `rate_limits.primary` with `used_percent`, `window_minutes: 10080` (weekly) and `resets_at`, plus `plan_type`. The 2.5 observer could surface it with a small parser change. No Claude-side local source identified yet.

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
new harness version can later offer the suite through `roundtable doctor`.

**Done-when if promoted:** both harnesses can be requalified from one documented command, a deliberately
broken fixture is detected, ambiguous results cannot pass, reports compare versions, and all created
sessions/processes are accounted for in cleanup.

## Crossed-reply guard: don't send while your inbox has messages in flight

*Raised 2026-09-28 by Kevin, after repeated crossed replies between Claude and Astra. Status: parked.*

**Idea:** before an agent's `roundtable_send` is queued, the room checks whether messages addressed to that agent are
still in flight: delivered natively but not yet seen by the agent, or queued behind its current turn. If they are,
the send is held (or refused with a hint) until the agent's inbox is drained, so replies don't cross.

**Why it's not trivial (notes for scoping):**
- A native `submitted` delivery means "handed to the harness", not "read". The signal that a message was actually
  seen is the agent's transcript: the 6.1 activity reader already observes when a delivered message enters the
  conversation (a Claude `user` record; a Codex `user_message`). The guard could use "delivered but not yet in the
  transcript" as "in flight".
- Choices to make:
  - hold-and-send-later vs refuse-with-hint (refusing keeps the agent in control and is simpler to reason about);
  - scope: only messages from the same peer you're replying to, or your whole inbox;
  - a way to override for urgent sends.
- It must not deadlock two agents waiting on each other: a bounded wait or a per-send override.
- Human messages would probably always bypass it.
- A cheaper first step: include "N newer messages for you are in flight" in the `roundtable_send` result/envelope, so
  the agent can choose to re-read before replying.

## Compaction notice: tell the room when an agent is compacting

*Raised 2026-09-28 by Kevin (room directive). Status: parked.*

**Idea:** a pre-compaction hook tells the other agents that this agent is compacting its context, so they hold off
on messages for about a minute. A message that lands mid-compaction waits behind the compaction, or is compacted
away with the rest of the context before the agent really reads it.

**Notes for scoping:**
- **Make it room state, not a chat message.** The hook reports "compacting" to the room, as participant activity
  (`compacting`, with a started-at time and an expected end), rather than sending a message that asks peers to hold
  off. Then:
  - the TUI and `roundtable who` show it;
  - the dispatcher holds deliveries to that agent until compaction ends (plus a small grace period), instead of every
    sender having to remember to wait (north star: nobody polls or re-arms);
  - senders' results say "held: recipient is compacting".
- **Ending:** a post-compaction signal (Claude's SessionStart with source `compact`, if available, or the first
  post-compaction transcript record seen by the 6.1 activity reader). It needs a hard timeout (~2 min), so a lost end
  signal can't hold messages forever. Unknown stays unknown: without the start signal, nothing is inferred.
- **Invariants:**
  - The hook only reports state; it must never deliver or inject messages (invariant 2: one delivery path).
  - Installing a hook is a harness configuration change, so Kevin installs it himself; the room only documents the
    command (invariant 8).
- **Harness coverage:** Claude Code has a `PreCompact` hook. Codex's equivalent (if any) needs a probe. Without a
  hook, the activity reader might detect compaction records in the transcript, after the fact.
- **Interplay with M7:**
  - the 7.6 delivery hold and batching would naturally extend to "hold while compacting, then deliver as one batch";
  - the crossing guard already stops a stale post-compaction reply, since the refused send returns what was missed.
