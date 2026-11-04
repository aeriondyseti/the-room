---
id: ADR-0007
status: accepted
date: 2026-09-28
decision-makers: [Kevin]
made-in: "2.2"
supersedes: []
superseded-by:
tags: [process, review]
---
# Lean review workflows (2–5 subagents), a deliberate deviation from sprint-loop

## Context and Problem Statement

The local-code-review skill fans out 5 reviewers plus an adversarial verifier per finding (and 3 per finding for
risky diffs): about 20–50 subagents per run. Kevin asked: "use smaller 2-5 subagent workflows and try to keep them
lean. This is a deliberate deviation from the sprint-loop."

## Decision Outcome

Review gate = **2 focused reviewers** (correctness+invariants; contract/Done-when/conventions), each capped at about
6 findings, plus **one batched adversarial verifier** that scores all findings in a single agent (skipped when there
are none): ≤3 agents per run. Classification unchanged: actionable iff verified with confidence ≥ 80; `complete`
requires no failed agent and a verdict for every finding. Cross-reviews of the other agent's work use a single
subagent (cheaper model where available). Astra's Codex review mirrors this shape (2 `codex exec` reviewers + 1
batched verifier).

### Consequences

Lower cost and latency; somewhat lower recall than the 5-dimension fan-out, mitigated by cross-agent review (Kevin:
"feel free to code review each other's work") and tests. The in-repo `local-code-review` skill texts describe the
original shape; this ADR supersedes their fan-out size.
