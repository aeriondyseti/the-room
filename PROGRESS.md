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
| 0.2 | Room root and minimal registry | Astra | ⬜ | |

## Milestone 1 — Room service core

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| 1.1 | SQLite ledger | Astra | ⬜ | |
| 1.2 | Service process and IPC | Astra | ⬜ | |
| 1.3 | Dispatcher, states, and pause | Astra | ⬜ | |

## Milestone 2 — Adapters and agent access

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| 2.1 | Codex adapter | Astra | ⬜ | |
| 2.2 | Claude adapter | Claude | ✅ | review: reviews/2.2.md · live smoke: probes/claude-adapter-smoke.md |
| 2.3 | CLI | Astra | ⬜ | |
| 2.4 | MCP front end | Claude | ⬜ | |
| 2.5 | Usage observer | Claude | ⬜ | |
| 2.6 | Onboarding | Claude | ⬜ | |

## Milestone 3 — TUI

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| 3.1 | TUI shell and conversation | Claude | ⬜ | |
| 3.2 | Composer and commands | Claude | ⬜ | |
| 3.3 | Participants, usage, and delivery detail | Claude | ⬜ | |

## Milestone 4 — MVP acceptance

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| 4.1 | Room end to end on live agents | Claude + Astra | ⬜ | |
| 4.2 | Failure and recovery qualification | Astra | ⬜ | |

## Milestone 5 — Ergonomics polish, then v0.1.0

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| 5.1 | TUI polish | Claude | ⬜ | |
| 5.2 | Agent ergonomics | Astra | ⬜ | |
| 5.3 | Human ergonomics and release | Claude + Astra | ⬜ | |

## Milestone 6 — Post-release

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| 6.1 | Full activity view | Claude | ⬜ | |
| 6.2 | Background agents (IDEAS.md) | Astra + Claude | ⬜ | |
| 6.3 | Tech-debt triage | both | ⬜ | |

---

**Summary:** 1 / 20 features complete · **current version: v0.0.1** · last tag: v0.0.1
