# Tech Debt Ledger

Known issues we **consciously chose not to fix now**, so they aren't lost. Sources: code-review findings
that fell below the action threshold or were deferred as out of scope, acknowledged shortcuts taken to
keep a sprint focused, and "good enough for now" decisions worth revisiting.

**What to log here:** plausibly-real review findings we didn't work (for example confidence around
26–79), any finding of 80 or more we deliberately defer (with a reason), and intentional shortcuts.
**Don't** log obvious false positives (confidence 25 or below) or things the typechecker already handles.

**Status key:** 🔵 Open · 🟢 Resolved · ⚪ Won't-fix (with reason)

| ID | Date | Sprint | Source | Description | Conf./Severity | Why deferred | Suggested fix | Status |
|---|---|---|---|---|---|---|---|---|
| TD-0001 | 2026-09-28 | (bootstrap) | shortcut | `poc/` (pair-poc) duplicates messaging logic that the real room replaces; its participant ids are hard-coded | —/low | Needed for coordination until 4.1 | Delete `poc/` after 4.1 moves both agents to the real room | 🔵 Open |

---

### Notes
- Add a row whenever a review (or development) surfaces something we don't fix in the current sprint.
  IDs are allocated sequentially; either agent may add rows.
- Reference the originating `reviews/<sprint-id>.md` where relevant.
- Triage at milestone boundaries; Milestone 6.3 works the ledger after v0.1.0.
