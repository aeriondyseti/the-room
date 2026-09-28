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
| 2.2 | Claude adapter | Claude | ✅ | v0.0.4 · review: reviews/2.2.md · live smoke: probes/claude-adapter-smoke.md |
| 2.3 | CLI | Astra | ✅ | v0.0.14; review: reviews/2.3.md; 175 tests. |
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
| 4.1 | Room end to end on live agents | Claude + Astra | ⬜ | |
| 4.2 | Failure and recovery qualification | Astra | ✅ | v0.0.16; 187 tests; bounded live checklist in probes/failure-recovery-results.md. |

## Milestone 5 — Ergonomics polish, then v0.1.0

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| 5.1 | TUI polish | Claude | ⬜ | |
| 5.2 | Agent ergonomics | Astra | 🟡 | Readable CLI, reply shortcuts, actionable doctor hints. |
| 5.3 | Human ergonomics and release | Claude + Astra | ⬜ | |

## Milestone 6 — Post-release

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| 6.1 | Full activity view | Claude | ⬜ | |
| 6.2 | Background agents (IDEAS.md) | Astra + Claude | ⬜ | |
| 6.3 | Tech-debt triage | both | ⬜ | |

---

**Summary:** 13 / 20 features complete (+2.5b follow-up) · **current version: v0.0.15** · last tag: v0.0.15
