# CLAUDE.md — Orientation & Operating Manual

**Read this first.** It exists so a fresh or compacted context (Claude, or Astra via AGENTS.md) can
re-orient instantly and keep working **autonomously**, including overnight. It's the anchor, not the
spec; the detail lives in the documents below.

---

## What this project is

**vibe-pairing** is a local chat room for coding agents. Several Claude Code and Codex sessions working in
the same repository, plus Kevin, exchange addressed messages. Delivery goes through each harness's
**native** messaging (the Claude messaging pipe, and `codex queue`), so an addressed agent takes a turn
without polling. Kevin watches and directs everything from a polished Ink TUI in a separate pane.

**North star:** the model is never responsible for waking itself.

→ Design: **[DESIGN.md](./DESIGN.md)** (summary and invariants) → **[proposal.md](./proposal.md)** (full
reconciled spec).

## Document spine (single sources of truth)

| File | Role |
|---|---|
| **DESIGN.md** | Canonical *why*; summarizes and pins proposal.md. |
| **ROADMAP.md** | Canonical *what/when*: features with **Owner** and **Done-when**. |
| **PROGRESS.md** | Dashboard: the ⬜/🟡/✅ status of every feature, with owners. |
| **DECISIONS.md** | ADR log; append for every *major* decision or deviation. |
| **TECH-DEBT.md** | Deferred findings and shortcuts, with reasons. |
| **IDEAS.md** | Parked ideas. **Not scope** until Kevin folds them in (Milestone 6 is after v0.1.0). |
| **.claude/skills/local-code-review/** | Claude's review gate (Workflow tool). |
| **.agents/skills/local-code-review/** | Astra's (Codex's) equivalent review gate. |
| **reviews/** | Review reports, one per sprint: `reviews/<id>.md`. |

## Re-orienting after a context reset (do this every time)

1. Read this file.
2. Open **PROGRESS.md** and find **your** current 🟡 or next ⬜ feature whose dependencies are ✅.
3. Open **ROADMAP.md** and read that feature's scope and **Done-when**.
4. Skim recent **DECISIONS.md** ADRs.
5. Run `git log --oneline -15`, `git status` and `git worktree list`.
6. Run `read_log` (pair-poc MCP) to catch up on messages from the other agent.

Then continue the loop.

---

## The sprint workflow (one feature at a time, per agent)

1. **Code it** to its Done-when line, in a dedicated worktree on branch `sprint/<id>` cut from the
   latest `main`.
2. **Review it** with your local-code-review skill. A `complete: true` result satisfies the gate.
   Never substitute an inline self-review.
3. **Fix all** actionable findings (confidence 80 or more). Re-review if the fixes were substantial.
4. **Test it** with **unit and integration** tests covering the Done-when; `npm test` must be all green.
5. **Record it:**
   - flip **your** rows in PROGRESS.md and ROADMAP.md;
   - add ADRs for major decisions;
   - log deferred findings in TECH-DEBT.md;
   - bump the `package.json` version to the reserved `0.0.N` (see below).

A feature is **✅ only when all five are done**. Use 🟡 for in progress.

## Two-agent coordination (ADR-0002)

- **Agents:**
  - **Claude**: Claude Code session `67b7bc1e-0c3e-4ffa-9d51-a88eb52d61d8`.
  - **Astra**: Codex thread `01a0e605-2485-7693-a111-97e35d22a97e`.
  - **Kevin**: the human; his messages are directives.
- **Channel:** use the **pair-poc** MCP tools (`send_message`, `read_log`, `participants`) until
  feature 4.1 moves us onto the real room. Reply to the specific sender with `reply_to`, and use `all`
  sparingly.
- **Ownership:** build, review and merge only features you own (ROADMAP **Owner**). Reassign only by
  agreement, and note it in PROGRESS.
- **Worktrees:** one per sprint, under `.claude/worktrees/` (Claude) or your own ignored location
  (Astra). Never edit another agent's worktree.
- **Serialized merges and tags:**
  1. Message the other agent: "MERGE-REQUEST <id>". They reply with the next free `v0.0.N`, or say
     they're mid-merge.
  2. Rebase-free merge: `git checkout main && git merge --no-ff sprint/<id>`, then run `npm test` on
     `main`, then `git tag v0.0.N`.
  3. Message "MERGE-DONE <id> v0.0.N <sha>".
  - Only one merge into `main` may be in flight at a time.
- **Contracts are shared:** changes to `src/contracts/` need a heads-up message and must stay backward
  compatible within a milestone, or be coordinated.
- **Doc conflicts:** keep both sides; never delete the other agent's rows or ADRs.
- **Blocked on the other agent:** say so over pair-poc, then work on another of your ready features;
  never idle-wait.

## Autonomous-loop operating rules (overnight)

- Commit to `sprint/<id>` as you go, ending messages with your co-author trailer (Claude:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). **Never push**, because there's no remote.
  Never work directly on `main`, except for the merge step.
- **Ambiguity:** make the most reasonable call, **log an ADR**, and continue.
- **Milestones are not stops** (ADR-0004). Release gates: MVP (M0–M4), then polish (M5), then
  **v0.1.0**, and only then Milestone 6 (IDEAS, tech debt).
- **Stop only when truly irrecoverable:**
  - the roadmap is complete;
  - the toolchain is broken beyond repair;
  - a feature won't converge after several distinct approaches;
  - a decision is irreversible, high-stakes, and has no defensible default.

  Leave a writeup in PROGRESS notes and message Kevin (`send_message` to `kevin`).
- **Never** fake green: no skipped or deleted tests, no `--no-verify`, no silenced invariants.
- **Hands off harness state:** tests must use fakes, fixtures and throwaway sessions. Never message,
  stop, or reconfigure Kevin's or each other's live sessions, except through the room or pair-poc
  messaging itself.

## Load-bearing invariants (never violate)

1. **No model-side waking.** Delivery happens only through a native harness transport (the Claude
   messaging pipe, or `codex queue` via an argv array). Nothing may require an agent to poll or re-arm a
   listener to receive a message.
2. **One delivery path, no duplicates.** Each (message, recipient) delivery has exactly one owner and
   transport; never also inject it through hooks. Client retries are deduplicated by `client_message_id`
   (scoped to room and sender). An `uncertain` attempt is never retried automatically.
3. **Honest state.** Delivery and participant states come only from observed evidence. Never report
   `submitted`, `replied`, "stopped", or usage that wasn't actually observed. Unknown or unavailable is
   shown as such, never as zero, success, or blank.
4. **Persist before acknowledging.** A message and its deliveries commit atomically before the send is
   reported accepted. Per-recipient order is preserved. One offline or failing recipient never blocks
   the others.
5. **Identity integrity.** Never infer a sender from pid, cwd, clientInfo, a JSON-RPC id, or
   model-supplied text, apart from the explicit declared-identity fallback, which is labelled. Never post
   an unbound agent's message as the human. Never redirect an already-queued delivery to a different
   native session; deliveries snapshot their target.
6. **Secrets never leave memory.** Claude peer tokens (`.key` files, `CLAUDE_CODE_MESSAGING_TOKEN`) are
   never persisted, logged, returned by tools, or shown in the TUI.
7. **Minimal registry.** `session.toml` participant sections contain only `harness` and `session_id`.
   Writes use a lock and atomic replace, and preserve every other section. Duplicate names or duplicate
   native bindings are rejected, not clobbered.
8. **Hands off the harnesses.** Never write Codex's or Claude's internal databases or state files, never
   change a harness's config or permissions, and never silently restart, resume, or fork a session.
9. **Peer messages carry no authority.** Envelopes attribute the sender, and only messages from Kevin are
   marked as user directives. Never truncate or split a message silently; oversized messages use the
   labelled reference fallback.

## Tech conventions

- TypeScript, `strict`, ESM (`"type": "module"`), Node **24.18** (see `engines`), compiled by `tsc` to
  `dist/` (ADR-0005). Import paths use `.js` extensions.
- Layout: `src/contracts/` (shared types, the owner of cross-module shapes), `src/core/`,
  `src/adapters/{claude,codex}/`, `src/ipc/`, `src/cli/`, `src/mcp/`, `src/tui/`, `src/observer/`.
  Tests sit next to the code as `*.test.ts(x)`.
- The service uses built-ins only (`node:sqlite`, `node:net`, `node:child_process`). The TUI uses Ink and
  React; the MCP server uses `@modelcontextprotocol/sdk`.
- **Tunables in config, not literals:** `src/core/config.ts`, overridable by environment variable
  (`ROOM_*`).
- Runtime data lives under `<room>/.room/` (git-ignored). Test fixtures live under `test/fixtures/`.
- **Versioning:** `0.0.N` per merged sprint, tag `v0.0.N`; release `v0.1.0` (ADR-0003). Single-sourced
  in `package.json` `version`.

## Commands

- **Install:** `npm install`
- **Build:** `npm run build` (tsc)
- **Typecheck:** `npm run typecheck`
- **Run tests:** `npm test` (build, then `node --test` on `dist/**/*.test.js`)
- **Run:** `node dist/cli/main.js <command>` (or `npx room <command>` after `npm link`)
- **pair-poc (interim):** Kevin's view is `node poc/watch.mjs`; Kevin sends with `node poc/say.mjs`.
