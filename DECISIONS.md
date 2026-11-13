# Decision Log (ADRs)

Lightweight Architecture Decision Records. One entry per **major** decision made during implementation —
something that constrains future work or deviates from, or refines, [DESIGN.md](./DESIGN.md).
Append-only; supersede rather than rewrite. Small, local choices don't need an entry. Either agent may
append; announce new ADRs over pair-poc.

**Entry template:**

```
## ADR-NNNN — <title>
- **Date:** YYYY-MM-DD   **Sprint:** <roadmap id>   **Author:** Claude|Astra   **Status:** Proposed | Accepted | Superseded by ADR-XXXX
- **Context:** what forced the decision.
- **Decision:** what we chose.
- **Consequences:** trade-offs, what this locks in or rules out, follow-ups.
```

---

## ADR-0001 — Pre-implementation design decisions live in DESIGN.md
- **Date:** 2026-09-28   **Sprint:** (pre-build)   **Author:** Claude   **Status:** Accepted
- **Context:** Foundational design choices were settled before any code was written, in proposal.md.
  We need a single source of truth without duplicating them across documents.
- **Decision:** [DESIGN.md](./DESIGN.md) summarizes the reconciled proposal.md, which it incorporates
  by reference, and pins the load-bearing invariants. This log starts from the first build sprint.
- **Consequences:** For "why is it this way", read DESIGN.md, then proposal.md, then the ADRs. If an
  implementation choice contradicts DESIGN.md or proposal.md, the ADR records the deviation and DESIGN.md
  is updated to cite it.

## ADR-0002 — Two agents run the sprint loop in parallel with component ownership
- **Date:** 2026-09-28   **Sprint:** (bootstrap)   **Author:** Claude   **Status:** Accepted
- **Context:** Kevin asked Claude and Astra (Codex) to build the system overnight following
  `/sprint-loop`, coordinating with each other. Two agents on one trunk risk conflicting edits and
  racing merges or tags.
- **Decision:**
  - Every ROADMAP feature has one owner: Astra takes the service core, registry, Codex adapter and CLI;
    Claude takes the skeleton and contracts, Claude adapter, MCP server, observer, TUI and onboarding.
  - Each owner works in its own worktree on `sprint/<id>` cut from the latest `main`, and edits only
    its own PROGRESS and ROADMAP rows.
  - Merges into `main` and tag numbers are serialized over pair-poc: announce, merge, announce done.
- **Consequences:** Features can proceed in parallel when their dependencies are met. Doc conflicts are
  resolved at merge without overwriting the other agent's rows. Ownership can change by agreement,
  noted in PROGRESS.

## ADR-0003 — Version scheme: v0.0.N per sprint, v0.1.0 = MVP + polish
- **Date:** 2026-09-28   **Sprint:** (bootstrap)   **Author:** Claude   **Status:** Accepted
- **Context:** sprint-loop's default `0.<milestone>.<feature>` scheme would produce `v0.1.x` tags
  before release, which collides with Kevin's explicit "tag v0.1.0 after MVP plus polish".
- **Decision:**
  - Each merged sprint takes the next pre-release version `0.0.N`, sequential across both agents and
    reserved over pair-poc at merge handoff. It's tagged `v0.0.N` on the merge commit.
  - The release after Milestone 5 is tagged `v0.1.0`.
  - The version is single-sourced in `package.json`.
- **Consequences:** Tag numbers don't encode the feature id; PROGRESS.md notes map feature to tag.

## ADR-0004 — Don't stop at milestone boundaries
- **Date:** 2026-09-28   **Sprint:** (bootstrap)   **Author:** Claude   **Status:** Accepted
- **Context:** The bootstrap CLAUDE.md template lists "a milestone completes" as a stop condition, but
  sprint-loop and Kevin's overnight directive say to run to completion.
- **Decision:** Milestone boundaries are not stops. Stop only on the sprint-loop "truly irrecoverable"
  conditions. The v0.1.0 tag is a gate for starting Milestone 6, not a stop.
- **Consequences:** Kevin reviews asynchronously via the room log and git history.

## ADR-0005 — Build with tsc; tests with node:test on the compiled output
- **Date:** 2026-09-28   **Sprint:** (bootstrap)   **Author:** Claude   **Status:** Accepted
- **Context:** Ink needs JSX, and Node's built-in type stripping can't handle `.tsx`. We want few
  dependencies and a standard toolchain.
- **Decision:**
  - TypeScript (strict, ESM, `jsx: react-jsx`), compiled by `tsc` to `dist/`.
  - Tests use `node --test` on `dist/**/*.test.js`.
  - Typecheck is the lint gate.
  - Runtime dependencies: `ink`, `react`, `@modelcontextprotocol/sdk`, and a TOML library if needed
    (decided by 0.2's owner).
  - Dev dependencies: `typescript`, `@types/node`, `@types/react`, `ink-testing-library`.
- **Consequences:** The service stays built-in-only (`node:sqlite`, `node:net`); the TUI and MCP carry
  the dependencies.

## ADR-0006 — Registry preservation applies to participant sections
- **Date:** 2026-09-28   **Sprint:** 0.2   **Author:** Astra   **Status:** Accepted
- **Context:** Review found that the short invariant wording could imply unrelated configuration is
  supported in session.toml, contrary to Kevin's minimum-only registry requirement.
- **Decision:** Normal joins preserve every other participant section and accept only harness and
  session_id within each. Unsupported top-level tables cause explicit refusal without changing the
  file. The known legacy schema is converted only by explicit migration, with an exact backup under
  ignored .room/ before atomic replacement. Embedded send commands are parsed as inert strings.
- **Consequences:** Machine configuration stays outside the registry. Changed native bindings require
  an expected previous binding so simultaneous enrollment cannot silently replace another session.
  A crashed registry writer leaves a lock requiring owner verification before manual removal; it is
  never stolen on a timeout. Service-owner crash recovery is a separate feature (1.2).

## ADR-0007 — Lean review workflows (2–5 subagents), a deliberate deviation from sprint-loop
- **Date:** 2026-09-28   **Sprint:** 2.2   **Author:** Claude   **Status:** Accepted
- **Context:** The local-code-review skill fans out 5 reviewers plus an adversarial verifier per finding (and 3 per finding for risky diffs) — ~20–50 subagents per run. Kevin asked: "use smaller 2-5 subagent workflows and try to keep them lean. This is a deliberate deviation from the sprint-loop."
- **Decision:** Review gate = **2 focused reviewers** (correctness+invariants; contract/Done-when/conventions), each capped at ~6 findings, plus **one batched adversarial verifier** that scores all findings in a single agent (skipped when there are none) — ≤3 agents per run. Classification unchanged: actionable iff verified with confidence ≥ 80; `complete` requires no failed agent and a verdict for every finding. Cross-reviews of the other agent's work use a single subagent (cheaper model where available). Astra's Codex review mirrors this shape (2 `codex exec` reviewers + 1 batched verifier).
- **Consequences:** Lower cost and latency; somewhat lower recall than the 5-dimension fan-out, mitigated by cross-agent review (Kevin: "feel free to code review each other's work") and tests. The in-repo `local-code-review` skill texts describe the original shape; this ADR supersedes their fan-out size.

## ADR-0008 — Service ownership follows the operating system endpoint
- **Date:** 2026-09-28   **Sprint:** 1.2   **Author:** Astra   **Status:** Accepted
- **Context:** Deleting a supposedly stale lock file can race another auto-starting service. Native
  Windows named-pipe bind was verified to reject a second listener with EADDRINUSE.
- **Decision:** Bind the canonical room endpoint exclusively before opening the writable ledger.
  The live endpoint is the authoritative owner lock; .room/service.lock records PID and a random nonce
  for diagnostics, and is replaced only by the winner of that exclusive bind. Clients probe hello,
  auto-start detached when absent, and wait for readiness. Shutdown removes only its own nonce.
- **Consequences:** Stale diagnostic files cannot block startup or cause lock stealing. A listener
  using an incompatible protocol is reported, not replaced. Native Windows is the qualified platform;
  Unix stale socket-path recovery requires separate qualification. Registry formatting/comments are
  normalized by TOML serialization; all other participant values are preserved (ADR-0006).


## ADR-0009 — Two TUI layouts, ccstatusline bars, colour by meaning
- **Date:** 2026-09-28   **Sprint:** 6.8   **Author:** Claude   **Status:** Accepted
- **Context:** Kevin couldn't choose between the 6.6 top bar and the earlier left sidebar, and asked for colour grouping and his ccstatusline "slider" bars. Astra researched his settings and the renderer, read-only.
- **Decision:**
  - Keep both layouts over one shared metric model (`bars.ts`, `accountWindows`, `workspaceSegments`), so the values can't diverge between them.
  - The viewer's choice lives in `.room/tui.json` (a UI preference, not harness config).
  - A narrow terminal falls back automatically without changing the preference.
  - Bars reproduce ccstatusline `slider` exactly. Colours are fixed per meaning, from Kevin's 256-colour palette.
  - Status is always textual (`n/a`, `(stale)`, `(last known)`, `?`, bold `!`), so NO_COLOR loses nothing.
  - One deviation from Astra's spec: agent names keep their per-agent colour, because it's the colour their messages use in the conversation and links chip to speaker. Model and branch are cyan as specified.
- **Consequences:**
  - High usage no longer turns red or yellow; it keeps its group colour plus a bold `!`.
  - The left panel needs `max(tuiPanelBreakpoint, tuiPanelWidth + 51)` columns; the default panel is 34 wide, so a bar plus "Fable weekly" fits.

## ADR-0010 — Organised top bar; state colours for bars (supersedes ADR-0009's palette)
- **Date:** 2026-09-28   **Sprint:** 6.10   **Author:** Claude   **Status:** Accepted
- **Context:** Kevin's mockup ("The Room: a layout that's easier to parse") asked for a clearer hierarchy. He chose option c: the mockup's state colours for bars, keeping per-agent name colours. The scope is the top bar only.
- **Decision:**
  - The top bar is two labelled grids (AGENTS, BUDGETS) with measured columns. Like pieces line up: values, reset times and caveats each get a column, and percentages are right-aligned.
  - The 6.8 group colours are replaced by state colours: green < 70%, amber 70–90%, red > 90%, plus a bold "!" from 70%. Model, branch and reset are quiet.
  - A missing value is "—".
  - The "login unverified" caveat is hidden on screen (Kevin: almost always true); it stays in the data.
  - The grid falls back to the wrapping lines when it doesn't fit in width or height, or while an overlay is open.
  - Compact density is only ever explicit (`/compact`, Ctrl+T) and is remembered.
- **Consequences:**
  - ccstatusline's bar format is kept, but its palette is not.
  - The left panel is unchanged apart from the bar colours.
  - The message stream and bottom-bar parts of the mockup are deferred.

## ADR-0011 — Percentage inside the bar
- **Date:** 2026-09-28   **Sprint:** 6.14   **Author:** Claude   **Status:** Accepted
- **Context:** Kevin asked for the percentages inside the progress bars and chose the htop/btop style (option a).
- **Decision:**
  - A bar is cells: the filled part in reverse video in its state colour, a dim ░ track, and the number centred over it (padded per column so decimals align).
  - Padding shows the bar beneath it.
  - Bar size is chosen as the largest that fits (monotonic in width); caveats inline or wrapped.
- **Consequences:**
  - The number no longer needs its own column, so a metric is about 6 cells narrower, and Fable fits on Claude's row in narrower panes.
  - Reverse video keeps the fill visible without colour.
  - Supersedes the "bar then number" form from ADR-0009 and ADR-0010; the state colours from ADR-0010 are unchanged.

## ADR-0012 — Bars as one flat surface (amends ADR-0011's rendering)
- **Date:** 2026-09-28   **Sprint:** 6.15   **Author:** Claude   **Status:** Accepted
- **Context:** Kevin: the ░ track with a flat-backed label "reads as a patch pasted over a textured strip"; he wants a single flat surface.
- **Decision:**
  - A bar cell is a *surface* (`Segment.surface`).
  - In colour: the fill is a solid background in the state colour (`STALE_FILL` grey when stale) with dark label text (`TEXT_ON_FILL`); the track is a solid dim background (`TRACK_BG`, ansi256 237) with an explicit light foreground (`TEXT_ON_TRACK`). Label glyphs have no background of their own.
  - In monochrome (no backgrounds): a reverse-video fill and a ░ track, so the extent (and a 0% bar) stays visible.
  - Rendering is centralised in `surfaceStyle` and the app's `SegmentText`.
- **Consequences:**
  - ADR-0011's layout is kept (the number inside, aligned, monotonic sizing); only the cell rendering changes.
  - Tests assert bars through the monochrome rendering (`barText`), plus rendered colour and mono frames.

## ADR-0013 — Urgent Room queue lane and native cancellation cutoff (M7)

Kevin delegated crossing-guard ergonomics and explicitly set native acceptance as too late to recall.
Withdrawal races the broker's synchronous dispatch claim; in-flight or uncertain submissions never return
successful cancellation. Tombstones are terminal, history and dedup identities remain, and no harness
queue/history is edited. SQLite schema version 2 adds the withdrawn state; older service builds cannot
open that schema, so downgrade requires restoring a pre-upgrade backup rather than using the migrated DB.

Urgent messages require a reason, bypass only freshness, and take priority over ordinary broker-pending
messages. FIFO holds within each lane. This is an intentional exception to invariant 4's single FIFO:
it does not preempt an in-flight submission, accepted native message, or human Pause. The dispatcher
rechecks the lane head after asynchronous probing and before claiming submission. The lane is persisted
on each new delivery. No promise of immediate model processing or automatic interruption is made.

## ADR-0014 — M7 surfaces: strict guard with no fallback, CLI exit 4, one combined release (2026-09-28)

- **Context:** 7.1 makes the service reject legacy agent sends. The CLI and MCP surfaces (7.3) are what give agents
  snapshots, and our own coordination runs through the main checkout's CLI.
- **Decision:**
  - The surfaces always route agent sends through `guarded_send`. There is no silent fallback to `send` on an older service,
    because an unknown method there is a generic `bad_request`, indistinguishable from a real input error.
  - The CLI exits **4** when the guard refused a send (nothing queued) or a withdraw cancelled nothing. This is distinct
    from input errors (2) and service errors (3).
  - M7 ships as **one** `--no-ff` merge of `release/m7` (main + 7.1 + 7.2 + 7.3 + 7.4, each branch's history intact), so
    main is green at every commit, tagged **v0.8.0**.
  - Until Kevin restarts the live service, the agents coordinate with a pinned v0.7.6 CLI build
    (`.claude/worktrees/cli-v0.7.6`, `ROOM_ROOT` set to the room). Neither agent restarts the service.
- **Alternatives:** an advisory (unguarded) mode during migration was rejected as a bypass. Sequential 7.1-then-7.3
  merges were rejected because they leave main red in between.

## ADR-0015 — Delivery hold, same-sender batching and room settings (7.6) (2026-09-28)

- **Context:** Kevin asked for a short hold before delivery so withdraw is useful, configurable in settings, and for
  held messages (especially his) to go as one message.
- **Decision:**
  - **Hold:** ordinary messages get a persisted `notBefore` (`deliveryHoldMs`, default 500 ms). Urgent messages and
    stop requests bypass both the hold and batching. Pause is independent. A hold of 0 disables the hold and batching.
  - **Batching:** consecutive held messages from the same sender (native scope, `from`, authority) to the same
    recipient binding form a burst. Each joining message extends the deadline, capped at `batchMaxHoldMs` (default
    2000 ms) from the burst's first message. A burst goes as ONE native envelope (`buildBatchEnvelope`) with one
    authority header, each message whole under a tagged part line, and the token covering exactly the included
    messages. Claim and settlement are atomic per batch.
  - **No mixing senders:** batches never mix senders, because the first-line header is the recipient's only trusted
    authority marker.
  - **Settings:** `.room/settings.json` (versioned, locked atomic writes, unknown keys preserved) is read live and
    edited only by the human from the TUI's `/settings`. `ROOM_*` environment variables override the effective values
    and are reported as such.
    - Invalid environment policy fails at service start.
    - A bad file at runtime never blocks delivery: the service uses the last good values (or the defaults), reports the
      problem, and a human save repairs the file, backing up the bad content.
  - **Older binaries:** a binary from before 7.6 ignores `notBefore` and `burst` and delivers each queued message on
    its own, right away and without the hold. That degrades safely; restoring the newer binary resumes holding.
- **Alternatives:** a fixed hold with no batching was simpler, but it ignored Kevin's request that held messages go
  as one. Cross-sender batching gave fewer wake-ups but would blur the authority header, so it was rejected. Keeping
  settings in environment variables only was rejected because they aren't editable settings for the human.

## ADR-0016 — Participant lifecycle: rename without restart, kick by consent (Milestone 8) (2026-09-28)

- **Context:** manual renames left ghost participants; an agent went offline with queued deliveries and another's
  native thread vanished. Kevin asked for a rename tool that needs no restart and a kick tool executed by unanimous
  consent of the other agents, spec'd as the simplest design (docs/PARTICIPANT-LIFECYCLE-SPEC.md, agreed with Astra).
- **Decision:**
  - **The registry is the truth for who is in the room**; ledger participant rows follow it (pruned when a name
    leaves; `participant.removed` has one emitter). A startup reconcile relabels queued deliveries left under a
    departed name to the binding's current name.
  - **Names are labels; identity is the binding.** Lifecycle actions are authorized by native binding: agents rename
    only themselves; the human names anyone. A rename moves the registry section atomically, then relabels QUEUED
    deliveries only (submitted, uncertain and in-flight attempts stay historical); the target snapshot never changes
    (no redirect); `RoomMessage.to` keeps the old label as history; a collision with an existing row under the new
    name is refused. Kevin's choice: relabel in-flight deliveries rather than refuse the rename.
  - **Kick is one verb.** `room_kick` opens or joins a proposal; the electorate is frozen at opening as the other
    registered agents with fresh `online` liveness plus the authenticated proposer (unknown/stale are excluded and
    listed, never presumed offline). Unanimity executes immediately; expiry (default 10 min) is the rejection; there is
    no explicit "no", no veto window and no separate remove command: the human's own kick executes alone. Execution
    removes the registration, cancels queued deliveries with a `kicked` tombstone (never resent) and posts a notice;
    the session is untouched and may rejoin, visibly. A human kick persists a durable intent before the registry write.
  - **Notices are system messages** (`ROOM NOTICE`, no authority) delivered natively so nobody polls. The agent that
    performed a lifecycle action is excluded from its own notice (it learns from the tool result), so the snapshot
    token it holds stays valid for its next guarded send.
- **Alternatives rejected:** proposal events plus a TUI banner; a separate consent tool and explicit "no" votes; a veto
  window with approve/veto commands; a human-only remove command; refusing renames while deliveries are queued;
  cross-sender batching of notices. All added machinery for little value while the human sees every message.
## ADR-0017 — Project renamed to agent-roundtable; every user-facing name follows (2026-11-13)

- **Decision (Kevin):** the project is **agent-roundtable**, and the names people and agents type follow it: the CLI is
  `roundtable`, the MCP server and its tools are `roundtable` and `roundtable_*`, configuration is `ROUNDTABLE_*`, the
  state directory is `.roundtable/` and the envelope header opens with `[roundtable …]`. No old name is kept as an alias.
- **Existing rooms:** the first command run in a room moves `.room/` to `.roundtable/` (`adoptLegacyStateDir`). It never
  moves over an existing `.roundtable/`, and when the move fails (a service started before the rename still holds the
  directory) it stops with an error; `roundtable shutdown` skips the move so that service can be stopped.
  The service adopts too before it creates anything, because a client built before the rename can start it.
  `roundtable shutdown` never starts a service. When both directories exist and `.room/` holds a ledger, every command
  but shutdown stops and says so: which one to keep is the human's choice. `roundtable doctor` stays read-only: it
  reports earlier state and moves nothing.
- **Left as they were:** "room" stays the word for the shared space, so internal names (`RoomService`, `room.db`, the
  `room_state` table, `room.updated` events, the pipe name) are unchanged, as are the earlier `vibe-pairing` salts and
  the `~/.vibe-pairing` cache. Records written before this one (ADRs, PROGRESS, reviews, probes) keep the old names.
- **Consequence:** every MCP registration, permission allow-list entry (`mcp__room__room_*`) and `ROOM_*` setting made
  before the rename must be re-made under the new names; see "Upgrading from the-room" in docs/ONBOARDING.md.
