---
name: local-code-review
description: Local multi-agent code review of the current sprint's changes. This skill MUST be run by calling the Workflow tool to create a dynamic workflow (a deterministic find -> adversarially-verify pipeline) — it is not a hand-launched-subagent review. Mirrors the official /code-review gate for the branch-based sprint workflow when the user-triggered /code-review is unavailable. Use as step 2 of the sprint workflow during autonomous loops.
---

# Local Code Review (a dynamic Workflow-tool review, substitute for `/code-review`)

**This skill is executed by calling the `Workflow` tool to author and run a *dynamic workflow*** (the
inline script in step 2 below) — NOT by hand-launching review subagents with the `Agent` tool, and NOT by
reviewing the diff yourself inline. The Workflow tool is the required mechanism. It replicates the official
`/code-review` gate, adapted for a branch-based flow (no GitHub PR required). Use it as **step 2 of the
sprint workflow**. When the user is available, prefer the real `/code-review`; this keeps momentum
overnight without faking the gate.

**Why the Workflow tool (a dynamic workflow), specifically:** the review is a fan-out-then-verify shape —
N independent reviewers, each finding adversarially checked before it counts. The `Workflow` tool runs that
structure deterministically as a dynamic workflow (a `pipeline` with no barrier: each dimension's findings
verify the moment that dimension finishes), keeps the noisy per-reviewer tool output out of this context,
and returns only the scored findings. A static set of `Agent` calls cannot express the per-finding fan-out
or the no-barrier pipelining — so the dynamic workflow is the right and required tool here.

**Invoking this skill is explicit opt-in to the `Workflow` tool** (a skill whose instructions tell you to
call Workflow). You do not need any "ultracode" keyword — author the script below and run it via the
`Workflow` tool. Do not fall back to inline review or `Agent` subagents.

## Principle
**Quality over quantity. Only *actionable* findings are confidence ≥ 80.** A noisy review is worse than
none. The adversarial verify stage exists to kill plausible-but-wrong findings — default to refuting.

## Process

### 1. Scout inline (scope + guidance) — do this yourself, before the Workflow
Cheap, and it sets the work-list the Workflow fans out over:
- **Diff scope:** `BASE=$(git merge-base <trunk> HEAD)` — `<trunk>` is the trunk branch named in the
  repo's CLAUDE.md/AGENTS.md (default `main`; never assume). Capture changed files with
  `git diff --stat $BASE...HEAD` (the feature's changes only, not the whole tree). Skip lock files and
  pure prose, but **include** docs/config/workflow files when they are the feature itself or affect
  execution (build/CI config, agent instructions, schemas). Note the `$BASE` SHA, `HEAD` SHA, and the file list.
- **Guidance:** list paths of relevant `CLAUDE.md` (repo root + any in touched dirs), the relevant
  DESIGN.md sections, and the feature's ROADMAP **Done-when** line. Pass *paths + the specific acceptance
  criteria* to the Workflow as `args` — not full file dumps.

### 2. Author & run the review as a dynamic Workflow (required)
**Call the `Workflow` tool** with the script below passed inline via its `script` parameter (this creates a
dynamic workflow), passing `args = { base, files, guidance, doneWhen, sprint, invariants }`. This is the
mechanism for the whole review — do not review the diff yourself or substitute plain `Agent` calls.
Reviewers re-derive the diff themselves (`git diff $base...HEAD -- <file>`) and Read full files for context,
so only lightweight scope travels in `args`. The script is a **pipeline**: each dimension is reviewed, and
each finding it produces is **independently, adversarially confidence-scored** as soon as that review lands.

**Scale to the diff.** Small/low-risk change → the 5 dimensions + a single verifier each (below). Large,
risky, or "be thorough"/ultracode runs → bump `VOTES` to 3 **perspective-diverse** verifiers per finding
(correctness / invariant-violation / does-it-actually-trigger) and keep a finding only if the majority
confirm ≥ 80. `log()` anything you cap.

> **Project invariants are passed in via `args.invariants`** — the load-bearing rules this codebase must
> never break, copied from the repo's `CLAUDE.md` "invariants" section (the bootstrap step seeds this).
> Keep that list and this skill in sync; if the repo has no hard invariants, pass an empty string and
> dimension `invariants` becomes a general-correctness pass.

```javascript
export const meta = {
  name: 'local-code-review',
  description: 'Fan-out code review across dimensions; adversarially verify+score each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

// args can arrive as a JSON-encoded string; never run on undefined input
const a = typeof args === 'string' ? JSON.parse(args) : args
const { base, files, guidance, doneWhen, sprint, invariants } = a ?? {}
if (!base || !Array.isArray(files) || files.length === 0 || !doneWhen || !sprint)
  throw new Error('local-code-review args missing (base/files/doneWhen/sprint) — refusing to run on undefined input')
const VOTES = 1   // bump to 3 for large/risky/ultracode diffs (majority of ALL required votes must confirm)
const INVARIANTS = invariants && invariants.trim()
  ? invariants
  : '(no project-specific hard invariants declared — apply general correctness/safety reasoning)'

const RUBRIC = `Confidence rubric (use verbatim): 0 = false positive / pre-existing on an unchanged line;
25 = maybe, unverified; 50 = real but minor/nitpick; 75 = verified, important, hits in practice;
100 = certain, frequent, evidence-confirmed.`

const DIMENSIONS = [
  { key: 'guidance', prompt: `Does the change obey the repo CLAUDE.md conventions and the relevant DESIGN.md
    decisions, and meet the feature Done-when ("${doneWhen}")? CLAUDE.md is author-guidance — confirm it
    *specifically* calls out anything you flag. Watch for hardcoded literals that should be config tunables.` },
  { key: 'bugs', prompt: `Shallow-read the CHANGED code only: logic errors, off-by-one, null/empty/edge cases,
    wrong math, type/shape errors, resource leaks. Verify any external/library API you suspect against its
    real source/docs before claiming it's wrong. Large bugs only — no nitpicks.` },
  { key: 'invariants', prompt: `Audit the project's load-bearing invariants against the changed code:\n${INVARIANTS}` },
  { key: 'silent', prompt: `Hunt silent failures in the changed code: swallowed exceptions, bare catch,
    ignored return values, defaults masking errors, NaN/null propagation, silent type coercion, lost writes
    to immutable/frozen structures whose result is dropped.` },
  { key: 'interface', prompt: `Type & interface design of the changed code: data-structure/API clarity, naming,
    units, mutable-default & aliasing traps, type correctness, field-name agreement across modules.` },
]

const FINDINGS = {
  type: 'object', additionalProperties: false,
  properties: { findings: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    properties: {
      file: { type: 'string' }, line: { type: 'string' },
      title: { type: 'string' }, description: { type: 'string' },
      reason: { type: 'string' }, suggested_fix: { type: 'string' },
    },
    required: ['file', 'line', 'title', 'description', 'reason', 'suggested_fix'],
  } } },
  required: ['findings'],
}
const VERDICT = {
  type: 'object', additionalProperties: false,
  properties: {
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    verified: { type: 'boolean' }, rationale: { type: 'string' },
  },
  required: ['confidence', 'verified', 'rationale'],
}

const reviewPrompt = (d) => `You are a senior engineer reviewing a code change in this repo.
Scope: the diff \`git diff ${base}...HEAD\` restricted to these changed files: ${JSON.stringify(files)}.
Re-derive each file's diff (\`git diff ${base}...HEAD -- <file>\`) and Read the full files for context.
Guidance to apply (read these paths as needed): ${JSON.stringify(guidance)}.
Review dimension: ${d.prompt}
Report ONLY issues on lines this diff changed. Skip nitpicks, formatting, and anything a
linter/typechecker/test run catches. Return candidate findings (no confidence field — that's scored next).`

const verifyPrompt = (f, lens) => `Adversarially verify this code-review finding — try to REFUTE it.
Finding: ${f.title} @ ${f.file}:${f.line}\n${f.description}\nReason: ${f.reason}
Inspect the actual code (\`git diff ${base}...HEAD\`, Read the file). ${lens}
Is it real, on a line this diff changed, and does it actually trigger in practice? If uncertain, score LOW.
${RUBRIC} Set verified=true only if confidence >= 80.`

const LENSES = [
  'Lens: correctness — does the logic/math actually produce a wrong result?',
  'Lens: invariant — does it break one of the declared project invariants?',
  'Lens: does-it-trigger — find a concrete input/state/path that hits it, or concede it cannot.',
]

// A failed reviewer or verifier is NEVER an empty/clean result: record it and mark the review incomplete.
const failures = []
const safe = async (what, run) => {
  try {
    const r = await run()
    if (r == null) failures.push(`${what}: no result`)
    return r ?? null
  } catch (e) { failures.push(`${what}: ${e?.message ?? e}`); return null }
}
const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((x, y) => x - y), m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}
const NEEDED = Math.floor(VOTES / 2) + 1   // majority of REQUIRED votes (1 of 1, 2 of 3)

// Classification never averages: actionable iff a majority of required votes confirm at >= 80.
const classify = (f, d, votes) => {
  const ok = votes.filter(Boolean)
  const missing = VOTES - ok.length
  const confirming = ok.filter((v) => v.verified && v.confidence >= 80)
  const confidence = median((confirming.length ? confirming : ok).map((v) => v.confidence))
  const status = confirming.length >= NEEDED ? 'actionable'
    : missing > 0 ? 'unresolved'                     // a missing vote could change the outcome
    : (ok.some((v) => v.confidence >= 50) || confidence >= 26) ? 'techdebt'
    : 'discard'
  return { ...f, dimension: d.key, status, confidence, votes: ok.length, missing,
           confirms: confirming.length, rationale: ok.map((v) => `${v.confidence}: ${v.rationale}`).join(' | ') }
}

const reviewed = await pipeline(
  DIMENSIONS,
  (d) => safe(`review:${d.key}`, () =>
    agent(reviewPrompt(d), { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS })),
  (review, d) => {
    if (!review || !Array.isArray(review.findings)) {
      if (review) failures.push(`review:${d.key}: malformed result`)
      return []                                      // failure already recorded above
    }
    return parallel(review.findings.map((f, i) => () =>
      parallel(Array.from({ length: VOTES }, (_, v) => () =>
        safe(`verify:${d.key}#${i}.v${v}`, () =>
          agent(verifyPrompt(f, LENSES[v % LENSES.length]), { label: `verify:${d.key}`, phase: 'Verify', schema: VERDICT }))))
        .then((votes) => classify(f, d, votes))))
  }
)

const all = reviewed.flat().filter(Boolean)
const pick = (s) => all.filter((f) => f.status === s)
const actionable = pick('actionable'), unresolved = pick('unresolved'), techdebt = pick('techdebt')
const complete = failures.length === 0 && unresolved.length === 0
log(`${complete ? 'COMPLETE' : 'INCOMPLETE'}: ${all.length} candidates -> ${actionable.length} actionable, ` +
    `${unresolved.length} unresolved, ${techdebt.length} tech-debt; ${failures.length} agent failures`)
return { complete, failures, actionable, unresolved, techdebt, all, base, sprint }
```

### 3. Process the result (back here, after the Workflow returns)
- **Completeness first.** If `complete` is `false`, the review gate has **NOT** passed — regardless of how
  few findings came back. `failures` lists reviewer/verifier agents that crashed or returned nothing;
  `unresolved` lists findings missing a required vote. Re-run the skill (retrying the failed parts) until
  it returns `complete: true`. If it cannot complete, record the review as **incomplete** in the report and
  stop the sprint at the review gate — never treat a partial review as clean, and never substitute an
  inline self-review.
- **Partition** (already done by the script): `actionable` (a majority of required votes confirmed ≥ 80;
  `confidence` is the median of the confirming votes) · `techdebt` (not actionable, but some vote ≥ 50 or
  median ≥ 26, or an actionable one you deliberately defer with a reason) · `discard` is dropped.
- **Report:** write findings to `reviews/<sprint-id>.md` (durable record): the base and head SHAs reviewed,
  `complete`/`failures`, then findings grouped **Critical** vs **Important**, each with `file:line`, reason,
  a concrete fix, and its votes/rationales. Surface a short summary inline.
- **Record tech-debt:** append every `techdebt` item to `TECH-DEBT.md` with its reason — never just drop a
  plausibly-real finding.
- **Fix:** proceed to sprint-workflow step 3 — fix **all** `actionable` findings (deferred → TECH-DEBT.md).
  If fixes were substantial, **re-run this skill** on the new diff until it converges or comes back clean.
- If `complete` is `true` and `actionable` is empty → report "No actionable issues found" (still log
  tech-debt) and stop.

## Known false positives (reviewers are told to skip; discard if they slip through)
- Pre-existing issues on lines the feature didn't change.
- Anything a linter/typechecker/test run catches (imports, type errors, formatting) — assume CI runs them.
- Pedantic nitpicks a senior engineer wouldn't raise.
- Intentional changes that are the feature's purpose.
- Missing tests **at this step** — tests are sprint-workflow step 4; flag only genuinely untestable designs.
