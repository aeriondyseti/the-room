---
name: local-code-review
description: Codex agents' local code review of the current sprint's changes — the sprint-workflow step-2 gate. Independent per-dimension reviewers plus an adversarial verifier per finding, each in a separate read-only context; only a complete run satisfies the gate. Use before merging any sprint/<id> branch.
---

# Local Code Review (Codex edition)

This is the Codex counterpart of `.claude/skills/local-code-review/SKILL.md`. Claude's version runs on its
Workflow tool; this one gets the same **find, then adversarially verify** structure from **separate
read-only Codex contexts** (`codex exec`), or from Codex sub-agents if your host provides them. The
scoring, the `complete` rule, and the report format are the same, so reviews from both agents are
comparable. Owner: Astra may refine this file (announce changes over pair-poc).

## Principle
Quality over quantity. Only findings verified at **confidence 80 or more** are actionable. The verifier's
job is to *refute*.

## 1. Scout (yourself)
- `BASE=$(git merge-base main HEAD)`; list the changed files with `git diff --stat $BASE...HEAD`. Skip
  lock files. Include config, docs and schemas when they are the feature.
- Collect the guidance: the CLAUDE.md invariants (numbered list), the feature's ROADMAP **Done-when**, and
  the relevant DESIGN.md and proposal.md sections.

## 2. Review: one independent context per dimension
Run **five** reviewers, each in a fresh read-only context. For example:

```powershell
codex exec --sandbox read-only -C <worktree> "<reviewer prompt for dimension D>"
```

(run them in parallel if your host allows). The dimensions, with the same prompts as Claude's version:

1. **guidance**: CLAUDE.md conventions, DESIGN/proposal decisions, the Done-when, and tunables in config.
2. **bugs**: logic, edge cases, resource leaks in *changed* lines. Verify library APIs before claiming
   they're wrong.
3. **invariants**: audit each CLAUDE.md load-bearing invariant against the changed code.
4. **silent**: swallowed errors, ignored return values, defaults masking failures.
5. **interface**: types and contracts, naming, agreement with `src/contracts/`.

Each reviewer returns JSON findings
`{file, line, title, description, reason, suggested_fix}` for **changed lines only**, with no confidence
score. A reviewer that crashes or returns nothing counts as a **failure**, not as "clean".

## 3. Verify: one adversarial context per finding
For each finding, run a fresh read-only verifier told to **refute** it. It returns
`{confidence 0-100, verified, rationale}`, using this rubric verbatim:
- 0 = false positive, or pre-existing on an unchanged line;
- 25 = maybe, unverified;
- 50 = real but minor or a nitpick;
- 75 = verified, important, hits in practice;
- 100 = certain, frequent, evidence-confirmed.

For large or risky diffs (adapters, ledger, identity), use **three** verifiers with different lenses
(correctness, invariant, does-it-trigger); a majority must confirm at 80 or more.

## 4. Classify and decide `complete`
- **actionable:** a majority of the required votes confirm at 80 or more.
- **techdebt:** not actionable, but some vote is 50 or more, or the median is 26 or more.
- **discard:** everything else.
- `complete = (no reviewer or verifier failures) and (no finding missing a required vote)`. If it's not
  complete, re-run the failed parts. **A partial review never passes the gate**, and it is never replaced
  by an inline self-review.

## 5. Report and act
- Write `reviews/<sprint-id>.md`:
  - base and head SHAs, `complete` and any failures;
  - findings grouped **Critical** / **Important**, each with `file:line`, reason, fix, and
    votes/rationale;
  - the tech-debt list.
- Append the tech-debt items to TECH-DEBT.md (next TD id).
- Fix **all** actionable findings. If the fixes were substantial, re-run this skill on the new diff.

## Known false positives (discard)
- Pre-existing issues on unchanged lines.
- Anything typecheck or tests catch.
- Pedantic nitpicks.
- Intentional feature changes.
- Missing tests at this step.
