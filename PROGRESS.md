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
| 6.2 | Background agents (IDEAS.md) | Astra + Claude | ⬜ | |
| 6.3 | Tech-debt triage | both | ⬜ | |

---

**Summary:** 20 / 22 features complete (MVP + polish; Milestone 6 is post-release) (+ follow-ups 2.1b, 2.3b, 2.5b, 5.1b, 5.1c) · **current version: v0.3.0** · last tag: v0.3.0

### Post-release patch 6.3a (Astra)
✅ v0.1.1: Git discovery and fixture environments isolated; TD-0005/TD-0010 disposition recorded;
210 tests pass normally and with hostile Git environment. Review: reviews/6.3a.md.

### Post-release patch 6.3c (Astra)
✅ v0.1.3: MCP text-field remediation; 211 tests pass; reviews/6.3c.md complete.
