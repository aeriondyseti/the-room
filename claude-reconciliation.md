# Claude's reconciliation review

Input to the joint `proposal.md`, which **Astra owns and writes**. This file is
Claude's review of `codex-proposal.md` and `proposal-claude.md`, updated with
Kevin's scoping answers. Proposal stage only; nothing is implemented.

## Kevin's scoping answers (2026-09-27)

| Question | Answer |
|---|---|
| Enrollment | **Attach existing sessions only.** Kevin starts agents himself; the room never launches them. |
| Plain TUI input (no @mention) | **Broadcast to all enrolled agents.** `@name` targets one agent. |
| Visibility | **Everything visible to every agent; only addressed messages wake an agent.** |
| TUI v1 scope | Agent status panel · per-message delivery detail · pause/resume · per-agent token/context usage. **Revised: MVP shows room messages only**; full harness output (tool calls and results) moves to the milestone after MVP. |
| TUI library | **Ink** is acceptable (TUI only; broker stays dependency-free). |
| Room scope | **One room per repo**: `.room/` at the repo root, git-ignored, shared by worktrees. |

## Positions on the divergences

**D1 Delivery payload → adopt Astra's model.**
- The full message travels through the native queue or pipe, recorded in a
  per-recipient ledger.
- Claude withdraws the doorbell plus cursor design. Its advantage was that
  a lost or duplicated push was harmless. Its cost was that the model had to
  run `room read`, which reintroduces model dependence — the root problem.
- To keep some of the doorbell's robustness, the message body carries its
  room id (`[room#123 from=user to=all]`). That makes duplicates detectable
  by eye and in the transcript observer.

**D2 Hooks → no message delivery through hooks.**
- The native queue or pipe is the only normal delivery path, which removes
  the risk of delivering a message twice.
- Keep exactly one hook role: pause enforcement.
  - Claude `PreToolUse` and Codex `PreToolUse` (if available; otherwise
    Codex pause is "hold deliveries only") deny tool calls while paused.
  - They deliver no content, so they can't produce duplicates.
- Mid-turn delivery for Claude: pipe priority `next` already arrives between
  tool calls. For Codex, messages wait for the current turn to end
  (`turn/steer` later, as a qualified capability).

**D3 Persistence → a broker process with SQLite (`node:sqlite`, no
dependencies).**
- One writer: the broker owns the ledger. The TUI and agent CLI are clients
  over a local named pipe or HTTP.
- Minimal tables:
  - `messages(id, ts, from, to_json, body, kind)`
  - `deliveries(message_id, recipient, state, attempt, native_id, error, updated_at)`
  - `participants(name, harness, address_json, paused, last_seen)`
  - `observer_cursors(participant, source_path, offset)`

**D4 Agent-facing tools → CLI first.**
- `room send --to astra "…"`, `room who`, `room log`.
- Both harnesses have a shell, and there's no MCP configuration per agent.
- Identity binding: the CLI resolves the sender from the calling session
  (`CODEX_THREAD_ID`; for Claude, the pid of the parent Claude session
  matched in `~/.claude/sessions`, or `CLAUDE_CODE_SESSION_ID` if exposed).
  It does not trust a `--from` flag.
- MCP tools come later.

**D5 Latency → no hard number in v1.** Measure enqueue, turn start and reply
separately; decide after the 20-trial runs.

**D6 Delivery states → Astra's lifecycle.** In v1 some states may be marked
"no evidence available" instead of being invented. The TUI shows
`uncertain` honestly and offers an explicit retry.

**D7 Enrollment → attach existing only** (Kevin's answer).
- `room join --as astra` run inside the agent's session records the native
  address:
  - Codex thread id from `CODEX_THREAD_ID`;
  - Claude session id and pipe from `~/.claude/sessions/<pid>.json`.
- Kevin can also enroll from the TUI using the values in `session.toml`.

## Transcript observer (post-MVP; token counts only in MVP)

Kevin revised the scope: the MVP TUI shows room messages only. The full
observer below is the **next milestone after MVP**. The MVP keeps only a
minimal read-only reader for per-agent token/context usage (Claude assistant
`usage` fields; Codex `token_count` events), built on the same cursor
mechanism. The observer's delivery-evidence role (finding the tagged
`room#id` in the transcript) is also useful for the ledger's
accepted/processing states, so it could come forward if qualification needs
it.

The observer is read-only and independent of the delivery endpoint. It only
reads transcript files and never writes to a harness or the room. This
satisfies Astra's rule that observer output never feeds back into new
messages.

| Harness | Source (verified on this machine) | Useful records |
|---|---|---|
| Claude Code | `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` | assistant `content[].type=="tool_use"` (name, input) · user `tool_result` blocks · assistant text · `parentUuid` chain |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl` | `event_msg` `item_completed` (e.g. `CommandExecution`) · `response_item` `*_tool_call` / `*_tool_call_output` · `turn_id` · `token_count` |

- **Cursor:** byte offset per file, persisted, so a broker restart resumes
  without replaying.
- **Tolerance:** handle partial trailing lines (read to the last `\n`).
  Detect rotation and new files: Codex rollouts are named by thread id, and
  Claude files by session id.
- **Correlation:**
  - Codex: link a delivery to the next `turn_id` whose user input contains
    the `room#id` tag.
  - Claude: link to the next user entry containing the tag.
  - This gives "processing" and "completed" evidence for D6 without trusting
    the enqueue endpoint.
- **Honest status:** if a transcript file can't be found or parsed, show the
  agent's output pane as `observer unavailable (<reason>)`, never blank.
- **Format risk:** both transcript formats are internal. Put a small parser
  adapter per harness, with fixture tests from captured lines, behind the
  same interface as delivery.
- **Secrets:** tool outputs may contain secrets. The observer is local-only
  and displays but does not re-log tool output into the room database. It
  stores only cursors and correlation ids.

## TUI (`room tui`, run in its own pane)

```
┌ vibe-pairing ─ room: X:\Development\vibe-pairing ──────────────────────────┐
│ AGENTS                       │ CONVERSATION                                  │
│ ● claude  busy   turn 2m     │ 22:58 you → all   merge the proposals         │
│   ctx 41% · 1.2M tok         │ 22:58 ✓claude ✓astra  delivered              │
│ ● astra   idle   ⏸ paused    │ 22:59 astra → claude  D1: agree …            │
│   pending: 2                 │ 23:01 claude → astra  review in …            │
│                              │                                               │
├──────────────────────────────┴───────────────────────────────────────────────┤
│ > @astra draft section 4 first_                           [tab: view] [^P]  │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Views:** MVP has *Room* (messages only). Post-MVP adds *Room +
  activity* (tool calls inline, collapsed) and *Agent: <name>* (that
  agent's full observed transcript, with expandable tool input and output).
- **Status panel:** state, paused flag, pending deliveries, and token/context
  usage per agent.
- **Input:** plain text broadcasts to all agents; `@name` targets one;
  `@a @b` targets several.
- **Commands:**
  - `/pause [name|all]`, `/resume [name|all]`
  - `/retry <msg#>` (for uncertain or failed deliveries)
  - `/who`, `/view <name>`
- **Delivery detail:** each human or agent message shows a tick per
  recipient (queued ◌, accepted ✓, processing ▶, failed ✗,
  uncertain ?). Enter on a message opens its ledger rows: native id,
  attempts, errors.
- **Tech:** Node + a small TUI library (e.g. Ink or blessed), or a raw
  ANSI renderer to stay dependency-free. Recommendation: Ink. It's one
  dependency for a much better result; the broker stays dependency-free.
  Windows Terminal is the target.
- The TUI is just a client. Closing it doesn't affect delivery.

## Other notes on `codex-proposal.md`

- **Agree:**
  - no `resume --last`, bind to exact thread UUIDs;
  - no competing owner of a conversation;
  - `uncertain` is never auto-replayed;
  - argument-array execution for `codex queue`.
- **Claude bridge scope:** we don't need to publish a full bridge peer with
  its own reply pipe for v1. Agents reply by running `room send`, which the
  broker routes. A native `SendMessage` reply path is a later nicety.
  Dropping it removes the riskiest part of the Claude protocol, binding and
  advertising our own `cc-msg` pipe.
- **Claude delivery evidence:** after a pipe write, look for the tagged user
  entry in the Claude transcript. That is the "harness accepted"
  signal the pipe itself doesn't give (control-frame receipts aren't
  interpreted yet).
- **Loop control:** keep Astra's rule that replies need explicit recipients.
  Add a per-pair hop counter or rate warning in the TUI, e.g. "claude↔astra:
  12 messages in 2 min, no human input". Kevin can pause, but the room never
  auto-throttles silently.

## Questions still open for Kevin

None at the moment. Answered: Ink yes, one room per repo, token usage yes,
MVP TUI shows messages only.

## Review of Astra's `proposal.md` draft (R4)

**Approved:**
- single service with SQLite and one writer;
- the full envelope through the native queue or pipe (no doorbell, no hook
  reinjection);
- attach-first enrollment;
- human broadcast default and explicit agent addressing;
- honest `uncertain` handling with reconcile-before-retry;
- `priority: next`;
- no synthetic Claude peer in v1;
- pause-delivery semantics that don't overclaim.

**Changes requested:**

1. **Remove full output from the MVP** (Kevin's latest scope): lines 13,
   29, 44, the observed-output row at 58, the §122–130 "required" section
   (move it to post-MVP), milestone 1's observation-first spike, the
   completion criterion at 155, and the reconciliation record at 161.
2. **Add per-agent token/context usage** to the participant strip (Kevin
   said yes). It needs a minimal read-only transcript reader that takes
   token counts only.
3. **Resolve line 19:** queue by default, steering later (Kevin confirmed).
4. **Pause:** Kevin chose "Pause/resume" from an option described as
   *enforced via PreToolUse deny*. The draft makes pause a delivery hold
   only. Proposal:
   - v1 pause = hold deliveries **plus** a PreToolUse deny hook where it
     has been qualified (Claude first; Codex if its PreToolUse can deny);
   - the TUI labels which one applies per agent;
   - the hook only reads `.room/` pause state and delivers no messages, so
     it adds no duplicate path.
   - Otherwise, confirm with Kevin that a delivery-only pause is
     acceptable.
5. **Codex envelope size:** `codex queue --message` goes through the
   Windows command line (CreateProcess limit is about 32K characters). Cap
   the Codex envelope at about 24K. Longer bodies are stored in the room
   and sent as a head plus `room read <msg-id>` for the rest. That's a
   fallback, not the normal path. Claude's pipe allows about 1M.
6. **Sender identity for `room send`** from an attached session (the draft
   says "enrollment credentials" but gives no mechanism). An existing
   session's environment can't be changed, so resolve the caller:
   - Codex: `CODEX_THREAD_ID`.
   - Claude: walk up the process parents to a pid in
     `~/.claude/sessions/<pid>.json`.
   - Add this as a probe.
7. **Service lifecycle:** specify who starts it. Proposal: any client
   (`room tui` or `room send`) auto-spawns the detached service if it
   isn't running, guarded by the single-owner lock. `room send` with no
   service and no ability to spawn one fails loudly.
8. **Room identity:** Kevin chose one room per repo, shared by worktrees.
   Resolve the room from the parent of `git rev-parse --git-common-dir`
   now, which is cheap, not "future worktree support".
9. **Name Ink** as the TUI library (Kevin approved it). The service stays
   minimal.
10. **Persistence simplification:**
    - drop raw observed payloads and large-output artifacts from the MVP
      (no observer);
    - MVP tables: `messages`, `deliveries` (with attempts inline:
      `attempt`, `native_id`, `state`, `error`), `participants`,
      `usage_cursors`.
11. **Evidence without an observer:** MVP delivery states are `queued` →
    `submitted` (native accepted: exit 0 plus queue id, or pipe write ok)
    → `replied` (a room message from the recipient with `reply_to`), plus
    `failed` and `uncertain`. "Receipt in transcript" and "processing"
    arrive with the observer. The cheap exception: the usage reader could
    also look for the message-id tag, if that proves easy.
12. **Optional loop guard:** show a TUI warning when two agents exchange
    more than N messages with no human input. No automatic throttling.

**Kevin's decision on #4 (pause):** pause = **hold new room deliveries and
send a stop request to all agents**.
- The stop request is an ordinary room message from the human, exempt from
  the hold it creates, delivered like any other message. It is a request,
  not enforcement.
- No PreToolUse hook in v1.
- The TUI shows the room as paused and the stop request's per-agent
  delivery state.
- Resume releases held deliveries in order.

**Kevin's decision on caller identity (overrides R6 #3):** enrollment is
**self-registration into a `session.toml`-style file**, like the one we
built by hand.
- `room join --as <name>`, invoked by the agent (a small `/room` skill tells
  it to), appends that agent's section to `session.toml`: name, harness,
  cwd, and the native address.
- The CLI auto-detects the native address (`CODEX_THREAD_ID`; for Claude,
  the session registry entry found via its parent processes). The fallback
  is the skill telling the model to append its details by hand, exactly as
  was done manually.
- No secrets in the file; Claude pipe tokens are read at send time.
- `session.toml` is the human-readable participant registry, and the
  service reads it. SQLite remains the store for messages and deliveries.
- `room send --as <name>` checks the name against auto-detected details
  where possible and refuses on a clear mismatch. Otherwise it accepts the
  declared name (a local, trusted room).

## Final review of `proposal.md` (R8, for Astra)

**Verdict: APPROVED, conditional on one blocker: Kevin's `session.toml`
decision (R7).** All R4 and R6 items are resolved:
- cooperative pause with a stop request (lines 130–132);
- a 24K Codex budget with an oversized-message fallback (116);
- a caller-identity probe (63);
- detached auto-start (71);
- a worktree room (79);
- the full-output leftover moved post-MVP (144).

I accept Astra's corrections:
- a pipe write means *submitted*, not *accepted*;
- receipt correlation is optional;
- attempt history is kept in the compact schema.

**Blocker: Kevin's direction on enrollment and caller identity (see "Kevin's
decision on caller identity" above).**
- Line 23 says `session.toml` "is not a permanent runtime registry". Kevin
  wants the opposite: **`session.toml` is the human-readable participant
  registry.**
  - Agents self-register with `room join --as <name>`, prompted by a small
    `/room` skill, which appends their own section with auto-detected
    native addresses.
  - The fallback is the skill telling the model to append its details by
    hand, as we did.
  - The service reads it. No secrets are stored in it.
- Requested edits:
  - Line 23: rewrite to the above.
  - Line 86: describe `room join` as appending to `session.toml`.
  - Line 63: keep the runtime identity check, but as verification against
    the `session.toml` entry (refuse on a clear mismatch; otherwise accept
    the declared `--as` name).
  - Add the `/room` skill (Claude) and its Codex equivalent (AGENTS.md
    snippet or skill) to the MVP deliverables.
  - Say where the file lives: repo root as today, or `.room/session.toml`.
    I suggest keeping it at the repo root, git-ignored, since that's what
    Kevin and the agents already use.

With that edit, Claude approves `proposal.md` as the joint proposal.
