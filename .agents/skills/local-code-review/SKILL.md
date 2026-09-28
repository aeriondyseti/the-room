---
name: local-code-review
description: Lean independent sprint review using two focused reviewers and one batched adversarial verifier when needed (ADR-0007); only complete reviews satisfy the gate.
---

# Local Code Review (Codex edition)

This is the Codex counterpart of `.claude/skills/local-code-review/SKILL.md`. Claude's version runs on its
Workflow tool; this one gets the same **find, then adversarially verify** structure from **separate
read-only Codex contexts** (`codex exec`), or from Codex sub-agents if your host provides them. The
scoring, lean fan-out, complete rule, and report format follow ADR-0007 and Kevin's direct override. Owner: Astra may refine this file (announce changes over pair-poc).

## Principle
Quality over quantity. Only findings verified at **confidence 80 or more** are actionable. The verifier's
job is to *refute*.

## 1. Scout (yourself)
- `BASE=$(git merge-base main HEAD)`; list the changed files with `git diff --stat $BASE...HEAD`. Skip
  lock files. Include config, docs and schemas when they are the feature.
- Collect the guidance: the CLAUDE.md invariants (numbered list), the feature's ROADMAP **Done-when**, and
  the relevant DESIGN.md and proposal.md sections.

## 2. Lean independent review (ADR-0007; Kevin's explicit override)
Run **two** fresh read-only contexts, each capped at approximately six findings:
1. Correctness, failure handling, and load-bearing invariants.
2. Contracts, Done-when, guidance and conventions.

Use Codex subagents or independent `codex exec` contexts. Keep prompts/diffs focused; do not fan out by
finding or dimension. Each returns findings `{file,line,title,description,reason,suggested_fix}` or an
explicit empty array. A failed/empty response is not a clean review.

## 3. Batched adversarial verification
If there are findings, run **one** fresh read-only verifier to try to refute all of them in one batch.
Return `{finding,confidence,verified,rationale}` for each. Skip this agent when both reviewers are clean.
Use the rubric: 0 false positive; 25 unverified; 50 real but minor; 75 verified important; 100 certain.
No per-finding verifier fanout, including for risky diffs. Normal review cost is two or three agents.

## 4. Classify and decide `complete`
- Actionable: verified with confidence at least 80; fix every such finding.
- Tech debt: plausibly real deferred findings above 25; record reason and follow-up.
- Discard: obvious false positives at 25 or below.
- Complete requires both reviewers to succeed and a verdict for every finding (if any). Retry only
  failed parts. Never substitute self-review for a missing independent review.
- Cross-reviews of the other agent's work use at most one subagent. Re-review substantial fixes using
  the same lean shape; otherwise use a focused check of the changed behavior.

## 5. Report and act
- Write `reviews/<sprint-id>.md`:
  - base and head SHAs, `complete` and any failures;
  - findings grouped **Critical** / **Important**, each with `file:line`, reason, fix, and
    verification/rationale;
  - the tech-debt list.
- Append the tech-debt items to TECH-DEBT.md (next TD id).
- Fix **all** actionable findings. If the fixes were substantial, re-run this skill on the new diff.

## Known false positives (discard)
- Pre-existing issues on unchanged lines.
- Anything typecheck or tests catch.
- Pedantic nitpicks.
- Intentional feature changes.
- Missing tests at this step.
