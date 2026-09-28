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

## ADR-0007 — Lean review workflows (2–5 subagents), a deliberate deviation from sprint-loop
- **Date:** 2026-09-28   **Sprint:** 2.2   **Author:** Claude   **Status:** Accepted
- **Context:** The local-code-review skill fans out 5 reviewers plus an adversarial verifier per finding (and 3 per finding for risky diffs) — ~20–50 subagents per run. Kevin asked: "use smaller 2-5 subagent workflows and try to keep them lean. This is a deliberate deviation from the sprint-loop."
- **Decision:** Review gate = **2 focused reviewers** (correctness+invariants; contract/Done-when/conventions), each capped at ~6 findings, plus **one batched adversarial verifier** that scores all findings in a single agent (skipped when there are none) — ≤3 agents per run. Classification unchanged: actionable iff verified with confidence ≥ 80; `complete` requires no failed agent and a verdict for every finding. Cross-reviews of the other agent's work use a single subagent (cheaper model where available). Astra's Codex review mirrors this shape (2 `codex exec` reviewers + 1 batched verifier).
- **Consequences:** Lower cost and latency; somewhat lower recall than the 5-dimension fan-out, mitigated by cross-agent review (Kevin: "feel free to code review each other's work") and tests. The in-repo `local-code-review` skill texts describe the original shape; this ADR supersedes their fan-out size.
