# Progress Dashboard

At-a-glance status of every [ROADMAP.md](./ROADMAP.md) feature. Detailed acceptance criteria live in
ROADMAP.md (checkboxes); major decisions in [DECISIONS.md](./DECISIONS.md).

**Status key:** ⬜ Not started · 🟡 In progress · ✅ Done (coded + reviewed + tested + recorded)

**Per-sprint definition of done:** code → local-code-review → fix all issues → unit + integration tests
→ record changes and decisions. A feature is only ✅ when all five are complete. Each owner edits **only
their own rows**.

---

## Milestone 0 — Foundation

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| 0.1 | Repo skeleton and contracts | Claude | ✅ | v0.0.1 · review: reviews/0.1.md |
| 0.2 | Room root and minimal registry | Astra | ✅ | v0.0.2; review: reviews/0.2.md; 32 combined tests. |

## Milestone 1 — Room service core

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| 1.1 | SQLite ledger | Astra | ✅ | v0.0.3; review: reviews/1.1.md; 43 combined tests. |
| 1.2 | Service process and IPC | Astra | ✅ | v0.0.7; review: reviews/1.2.md; 102 combined tests. |
| 1.3 | Dispatcher, states, and pause | Astra | ✅ | v0.0.9; review: reviews/1.3.md; 138 combined tests. |

## Milestone 2 — Adapters and agent access

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| 2.1 | Codex adapter | Astra | ✅ | v0.0.12; review: reviews/2.1.md; 169 tests; live smoke accepted in 116ms. |
| 2.1b | Codex observed activity | Astra | ✅ | v0.0.20; review: reviews/2.1b.md; 206 tests; live online/busy observed. |
| 2.2 | Claude adapter | Claude | ✅ | v0.0.4 · review: reviews/2.2.md · live smoke: probes/claude-adapter-smoke.md |
| 2.3 | CLI | Astra | ✅ | v0.0.14; review: reviews/2.3.md; 175 tests. |
| 2.3b | Human desktop ancestry | Astra | ✅ | v0.0.22; review: reviews/2.3b.md; 208 tests after TUI restart integration. |
| 2.4 | MCP front end | Claude | ✅ | v0.0.11 · review: reviews/2.4.md · `room mcp` |
| 2.5 | Usage observer | Claude | ✅ | v0.0.5 · review: reviews/2.5.md |
| 2.5b | Participant monitor (liveness, activity, usage in the service) | Claude | ✅ | v0.0.15 · review: reviews/2.5b.md · 179 tests · Astra cross-review applied |
| 2.6 | Onboarding | Claude | ✅ | v0.0.13 · review: reviews/2.6.md · docs/ONBOARDING.md, .claude/skills/room · live Codex/Astra registration folds into 4.1 (needs resume or 2.3 CLI) |

## Milestone 3 — TUI

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| 3.1 | TUI shell and conversation | Claude | ✅ | v0.0.6 · review: reviews/3.1.md · try: room tui --demo |
| 3.2 | Composer and commands | Claude | ✅ | v0.0.8 · review: reviews/3.2.md · `room tui` opens the real room |
| 3.3 | Participants, usage, and delivery detail | Claude | ✅ | v0.0.10 · review: reviews/3.3.md · /detail, usage in panel + /who |

## Milestone 4 — MVP acceptance

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| 4.1 | Room end to end on live agents | Claude + Astra | ✅ | v0.0.23 · review: reviews/4.1.md · probes/4.1-acceptance.md: all Done-when items + evidence gates (20 wake trials each for Claude pipe and Codex queue, 2h mixed soak 80/80, four-agent scenarios 9/9 on re-run; all failures reported) · dogfood: probes/4.1-dogfood.md |
| 4.2 | Failure and recovery qualification | Astra | ✅ | v0.0.16; 187 tests; bounded live checklist in probes/failure-recovery-results.md. |

## Milestone 5 — Ergonomics polish, then v0.1.0

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| 5.1 | TUI polish | Claude | ✅ | v0.0.18 · review: reviews/5.1.md · UX pass: docs/ux/5.1-ux-pass.md · colour/mono theme, code blocks, first-run states, runtime context in /detail, ROOM_TUI_* tunables |
| 5.2 | Agent ergonomics | Astra | ✅ | v0.0.17; review: reviews/5.2.md; 193 tests; peer-approved envelope. |
| 5.3 | Human ergonomics and release | Claude + Astra | ✅ | **v0.1.0** · review: reviews/5.3.md (two clean final reviews; fresh-clone npm ci + 208/208) · README quickstart, `room doctor`, `room tui` first-run/`/restart` · acceptance scope: 20+20 idle-wake trials (Claude pipe, Codex queue), 2h mixed soak on Claude fixtures, bounded busy-Codex scenario, four-agent scenarios 9/9 on re-run with the original failures retained (probes/4.1-acceptance.md) |

## Milestone 6 — Post-release

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| 6.1 | Full activity view | Claude (+ Astra: Codex parser) | ✅ | **v0.2.0** · review: reviews/6.1.md, reviews/6.1-codex.md · `/activity @name` in the TUI: tool calls/results/messages from read-only transcript readers (Claude + Codex), binding-scoped streams, persisted cursors, bounded window + paging, honest coverage; isolated from delivery/identity/liveness |
| 6.6 | Subscription usage + top bar | Claude (+ Astra: Codex source) | ✅ | **v0.3.0** · review: reviews/6.6.md, reviews/6.6-codex.md · top bar (participant chips) replaces the sidebar; per-account 5h + weekly (+ Claude Fable weekly) with resets; Codex via read-only daemon; Claude via statusline tap or opt-in usage endpoint (ROOM_CLAUDE_USAGE_API=on) |
| 6.7 | Workspace in the top bar (model, cwd, git) | Claude (+ Astra: workspace provider) | ✅ | **v0.4.0** · review: reviews/6.7.md · chip shows model + branch*dirty; /who shows cwd (source), worktree, branch, staged/modified/untracked, ahead/behind and observation age; read-only, bounded git sampling |
| 6.8 | Layout toggle (top ⇄ left) + usage bars and group colours | Claude (+ Astra: ccstatusline research/spec) | ✅ | **v0.5.0** · review: reviews/6.8.md · ADR-0009 · /layout, Ctrl+B, remembered in .room/tui.json; ccstatusline 10-cell slider bars; fixed group colours; honest n/a/stale/! in both layouts |
| 6.9 | Bounded shutdown (TD-0023) | Claude | ✅ | **v0.5.1** · review: reviews/6.9.md · observers get a short grace (ROOM_MONITOR_STOP_GRACE_MS), abandoned passes never write, detached service exits once closed; fixes the recurring shutdown test flake |
| 6.10 | Organised top bar (Kevin's mockup, top bar only) | Claude | ✅ | **v0.6.0** · review: reviews/6.10.md · ADR-0010 · AGENTS rows + BUDGETS grid with aligned values/resets/caveats, state-coloured bars, activity dot, — for missing, /compact + Ctrl+T, width/height/overlay fallbacks, paging help |
| 6.11 | Space after the reset arrow | Claude | ✅ | **v0.6.1** · review: reviews/6.11.md · `↻ 1h53m` (the arrow renders ~1.5 cells wide in some terminals) |
| 6.12 | Model limits as columns on their account's row | Claude | ✅ | **v0.6.2** · review: reviews/6.12.md · Fable weekly (and any model window, e.g. Spark 5h) as column pairs on the account row; bars 10 → 8 → numbers to fit |
| 6.13 | Composer keys + growing composer | Claude (+ Astra: spec, key probe) | ✅ | **v0.7.0** · review: reviews/6.13.md · Ctrl+Left/Right, Ctrl+Backspace/Ctrl+W, Ctrl+Enter newline (per terminal); composer grows to 12 visual rows and scrolls, never over the bottom bar |
| 6.14 | Percentage inside the bar | Claude | ✅ | **v0.7.1** · review: reviews/6.14.md · ADR-0011 · htop/btop-style bars: reverse-video fill in the state colour, dim track, centred aligned number; monotonic bar sizing |
| 6.15 | Bars as one flat surface | Claude | ✅ | **v0.7.2** · review: reviews/6.15.md · ADR-0012 · solid state-colour fill, solid dim track (no stipple), label over both; mono: inverse fill + ░ track |
| 6.16 | Side bar pass | Claude (+ Astra: audit, acceptance tests) | ✅ | **v0.7.3** · review: reviews/6.16.md · AGENTS/BUDGETS like the top bar; one shared label column (bars, numbers, resets aligned); right-aligned state; agents before budget detail, attention first; every model window |
| 6.18 | A frame that always fits (TD-0034) | Claude | ✅ | **v0.7.6** · review: reviews/6.18.md · strict priority row budget; highlighted suggestion always visible; header never wraps; tiny panel summaries; top bar trims with a notice |

> **2026-09-28 — Kevin signed off the TUI milestone (6.10–6.15) as complete** ("much better. I'm signing off on this milestone as complete"). Composer keys and long drafts confirmed by hand (TD-0029 closed); 16-colour terminals out of scope (TD-0031 won't fix).
| 6.2 | Background agents (IDEAS.md) | Astra + Claude | ⬜ | |
| 6.3 | Tech-debt triage | both | ⬜ | |

---

**Summary:** 20 / 22 features complete (MVP + polish; Milestone 6 is post-release) (+ follow-ups 2.1b, 2.3b, 2.5b, 5.1b, 5.1c) · **current version: v0.3.1** · last tag: v0.3.1

### Post-release patch 6.3a (Astra)
✅ v0.1.1: Git discovery and fixture environments isolated; TD-0005/TD-0010 disposition recorded;
210 tests pass normally and with hostile Git environment. Review: reviews/6.3a.md.

### Post-release patch 6.3c (Astra)
✅ v0.1.3: MCP text-field remediation; 211 tests pass; reviews/6.3c.md complete.

### 6.17 — Outer pane separator (Astra)
- Ownership moved from Claude to Astra by agreement (room m-muljy8gl); Claude provides independent cross-review.
- Implementation and full suite ready: cyan full-cell bottom row in effective sidebar layout, right column in effective top layout. Monochrome uses inverse spaces. Content geometry reserves the cell before layout; help and narrow fallback covered.
- Validation: 340/340 tests. Independent correctness and Claude contracts reviews complete with no actionable findings; physical terminal appearance not yet verified. Release v0.7.4.

### Divider removal (Astra, v0.7.5)
Kevin's visual testing reversed the outer divider request. Both colored edges and their reserved cell
are removed; existing internal rules remain. Restored full content dimensions. 340/340 tests pass.
Claude independently approved aebf47f; composer6.18 follows this release and adjusts its status-row test.

### Milestone 7 — Crossing guard, withdraw and urgent sends (spec: docs/CROSSING-GUARD-SPEC.md)

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| 7.1 | Inbox snapshots + guarded send (core) | Astra | ✅ | **v0.8.0** · review: reviews/7.1.md (lean gate + Claude cross-review; all findings fixed) · binding-scoped opaque tokens, coverage sets with holes, paged parts, audited baseline, atomic check+enqueue, dedup before freshness |
| 7.2 | Withdraw + urgent (core) | Astra | ✅ | **v0.8.0** · review: reviews/7.2.md (lean gate + Claude cross-review; withdrawn-in-inbox fixed) · per-recipient withdraw CAS (native acceptance = too late), urgent Room lane (ADR-0013), schema v2 |
| 7.3 | Tools and CLI | Claude | ✅ | **v0.8.0** · review: reviews/7.3.md (lean gate + Astra cross-review HOLD fixed) · room_send guarded / room_inbox (+baseline) / room_withdraw; CLI send/reply/inbox/withdraw (exit 4); envelope snapshot + URGENT lines; agent docs |
| 7.4 | TUI | Claude | ✅ | **v0.8.0** · review: reviews/7.4.md (lean gate + Astra cross-review HOLD fixed) · URGENT + reason, ⤫, revised/unguarded, withdrawn struck (never wholly when partial or human-addressed), "N not covered" column/chip/side-panel row |
| 7.6 | Delivery hold + same-sender batching + room settings | Astra (core) + Claude (envelope text, /settings, docs) | ✅ | **v0.8.1** · reviews: reviews/7.6-core.md (Astra lean gate + Claude cross-review; bad-settings blocker fixed) and reviews/7.6c.md (Claude lean gate + Astra cross-review) · 0.5s hold (urgent/stop bypass), per-sender batching into one envelope, .room/settings.json + TUI /settings with repair, ADR-0015 |

> Released together as **v0.8.0** in one combined merge (main green at every commit; Kevin restarts the live service). Ownership agreed at the M6→M7 boundary (Kevin's rebalancing rule): Astra core, Claude surfaces + spec. Native recall probes dropped per Kevin's scope decision.

### Milestone 8 — Participant lifecycle (spec: docs/PARTICIPANT-LIFECYCLE-SPEC.md)

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| 8.1 | Ghost cleanup | fable | ✅ | **v0.9.0** · review: reviews/8.1.md (2 lean runs + focused recheck; Astra APPROVE) · registry-driven participants(), single participant.removed emitter, startup reconcile (relabelQueued) |
| 8.2 | Rename without restart | Astra (core) + fable (surfaces) | ✅ | **v0.9.0** · reviews/8.2-8.3-core.md (Astra gate + fable cross-review) and reviews/8.2-8.4-surfaces.md (fable gate + Astra recheck GO) · room_rename / room rename / /rename; queued rows relabelled, targets frozen; notice split |
| 8.3 | Kick by unanimous consent | Astra (core) + fable (surfaces) | ✅ | **v0.9.0** · same records · room_kick as one verb, frozen electorate from fresh liveness, immediate execution, kicked tombstones, durable human intent; TD-0042 open |
| 8.4 | TUI | fable | ✅ | **v0.9.0** · reviews/8.2-8.4-surfaces.md · /rename, /kick, offline-with-queued flag, kicked mark and legend, notices as notes |

> Released together as **v0.9.0** in one combined merge (Astra core + 8.1 + surfaces; each branch's history kept). Ownership agreed with Astra at the M7→M8 boundary (spec §6): Astra core + contracts; fable 8.1, surfaces, spec, docs. Milestone 7 follow-up 7.7 (baseline text) stays on hold for Astra's delivery-token frontier.
