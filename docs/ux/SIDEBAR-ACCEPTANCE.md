# Sidebar pass: independent acceptance notes

2026-09-28, base v0.7.2 (`073a3f8`). Astra owns this audit and the independent
`src/tui/sidebar-acceptance.test.ts`; Claude owns rendering and integration. No live settings changed.

## Reproductions and proposed priorities

The built-in demo at 30 columns of sidebar content and 18 rows shows `AGENTS`, `+4 more`, and almost all budget
details/resets: **no individual agent is visible**. At 24 rows it shows the first two, hiding the last participant
which needs approval. Prefer compact name/state rows for all agents before retaining verbose quota reset rows.
When all agents cannot fit, give attention states a visible summary or priority; keep the hidden-agent count honest.

Model and branch currently share one line and truncate early. Give quiet model/branch lines room when available;
degrade workspace detail before state/name. The existing `/who` path remains the complete detail view.

Subscription quotas belong once per account, in a separate section. Align labels and bar/value starts inside that
section. Enumerate every extra bucket window, not only weekly-or-first (the old shared `accountWindows` helper can
drop a model's 5h window even though the top grid was fixed). Use stable bucket identity; display names can collide.
Keep actual duration labels, reset-arrow spacing, source-fallback and stale/last-known qualifiers.

## Matrix for Claude's integrated implementation

- Content widths 24/30/38/48; panel heights 8/12/18/24/32/48; 0/1/2/4/8 agents.
- Agent idle/busy/offline/needs-approval, pending messages, long model/branch names and linked worktree.
- Shared subscription across same-harness agents: one quota block, never duplicated or summed.
- Main 5h/weekly, Fable weekly, model bucket with BOTH 5h/weekly, distinct bucket IDs with identical labels.
- Fresh/stale/disconnected/unavailable; null is missing, observed 0 is a real bar; 7/70/90/100 percent.
- Windows Terminal/Ghostty color path: flat surfaces, readable in-bar label, no stipple in color. Monochrome stays
  supported; 16-color fallback is explicitly out of scope per Kevin, not a release blocker.
- Exact row/column bounds, context versus budget clearly separated, all omissions labelled, no value loses its
  freshness/source qualifier when a panel shrinks. Prefer attention visibility over decorative reset detail.
- Resize while typing a long draft and while showing suggestions/error feedback; footer remains separate.
- Existing `/layout` preference and narrow automatic fallback remain functional and do not rewrite preferences.

Independent executable tests cover dimension sweeps, stale/disconnected quota surface state, and one-account
deduplication. Rendering-specific alignment and attention prioritization belong to Claude's integration tests.
Do not freeze old undesirable output into snapshots merely to pass the suite.

## User acceptance already received

Kevin's room message `m-mulj75hi-c5f427e4-faf9-489e-979c-67e5eda15e84` confirms he manually tested long drafts and
word movement/deletion successfully. Record the physical composer check as passed; preserve any still-uncovered
automated resize/layout cases separately. The same message explicitly deprioritizes 16-color terminals because his
targets are Windows Terminal and Ghostty. These decisions replace the prior pending physical-check/16-color concerns.
