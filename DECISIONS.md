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
