---
title: Harness-update compatibility probes
raised-by: Kevin
date: 2026-09-28
trigger: a Claude Code or Codex update; Kevin parked it as a bonus feature for after v0.1.0
---
# Harness-update compatibility probes

A repeatable probe suite to run whenever Claude Code or Codex updates, checking that the harness behaviour the room
depends on still holds. Reuse the existing identity, messaging and background probe evidence instead of assuming
internal protocols remain stable across versions.

## Candidate checks

- Native delivery wakes an idle session, busy messages run in order as later turns, and an offline recipient does
  not stall other recipients. Record enqueue, turn-start and reply times separately.
- Exact routing with multiple instances of each harness; no cross-session delivery. MCP caller identity remains
  correct across concurrent sessions, resume and identity rotation; stale bindings are detected.
- Claude registry, process-start, pipe and key resolution and framing; Codex queue argv quoting, Unicode, envelope
  budget and returned native id. Never log authentication material.
- Honest submission evidence, ambiguous-error handling, no automatic duplicate resend, service restart recovery,
  and cooperative pause semantics. Explicitly distinguish room invariants from harness facts.
- Approval waits and refusals remain visible without treating submission as processing or bypassing harness
  permissions. Optional observer checks verify usage formats, cursors and unavailable states.
- Background hosting and interrupt checks remain optional until that feature is adopted; baseline MCP and
  native-delivery checks should not require the background architecture.

## Execution and output

Use isolated throwaway sessions and fixtures, never a user's active thread. Record harness and build versions, OS
and Node version, launch mode, transport, trial counts and cleanup results. Emit a concise human report plus
machine-readable results (pass, fail, unsupported or not tested); keep raw evidence with secrets redacted and
compare against the last qualified baseline. A preflight smoke suite should finish quickly; an explicit extended
mode can repeat trials and exercise crash and recovery. A changed assumption should identify the adapter or
invariant affected and the next diagnostic step, without silently changing config, permissions or delivery paths.
Run on demand initially; detecting a new harness version can later offer the suite through `room doctor`.

## Done when, if promoted

Both harnesses can be requalified from one documented command, a deliberately broken fixture is detected,
ambiguous results cannot pass, reports compare versions, and all created sessions and processes are accounted for
in cleanup.
