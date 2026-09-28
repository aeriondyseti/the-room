# Failure and recovery qualification — 2026-09-28

Status: automated suite and Codex native transport checks passed; Claude live checklist pending. No release claim.

## Automated evidence (VERIFIED)

`npm test` at sprint/4.2, after main v0.0.15 integration: 187/187 passing.

- `src/qualification/recovery.test.ts` starts actual independent fixture-service processes, with fake adapters only. Offline pending work survives shutdown/restart and submits once.
- The crash fixture exits immediately after logging simulated native acceptance, before persisting the receipt. The new process recovers the durable in-flight attempt as uncertain; repeating the original client message id finds the same message without native replay. Exactly two logged attempts exist across the preceding ordinary test message and crashed message.
- Four instances (two of each harness): pause holds ordinary work, while one stop request submits per recipient. Remove, add and same-name rebind change future broadcasts only. Old removed/rebound recipients remain held against their original IDs. Oversized reference envelopes remain within budget and the ledger retains the full body.
- A real Git linked worktree resolves to the same canonical room endpoint and reads the same ledger.
- Existing IPC qualification also exercises independent concurrent auto-start clients, exclusive endpoint ownership and stale owner metadata.

## Codex native checklist (VERIFIED, bounded)

Codex 0.157.1, Node 24.18.0, native Windows. An explicitly owned new saved thread `01a0e6cc-befe-7db1-a2cf-06594f2d756d` was registered in isolated `.room/probes/failure-native-20260928`, never in the working room. The guarded script `scripts/qualify-native-failure.mjs <fixture-root>` requires the ownership manifest.

- Stop request was exempt from its pause hold: native receipt `01a0e6cc-f921-7a90-9d2b-2fd1069fa8a3`, 113 ms.
- A later ordinary message had no native attempts while held.
- Close/reopen the real room service: pause and held work persisted.
- Resume released the ordinary oversized message: native receipt `01a0e6cc-f9a1-78f1-947e-a04aa9858b5b`, 106 ms. Configured envelope cap 1,200 UTF-16 units forced the explicit reference path.
- The room read API returned the exact complete original body, including its final qualification marker.
- These receipts show acceptance, not processing or enforced interruption.

An additional recipient-side check used `codex exec resume` on the saved thread and asked it to fetch the full message with the room CLI. Identity was preserved, but its shell tool was **blocked by harness policy**. The final marker was not retrieved. This is a failed processing/permissions check, not a pass; no policy workaround was attempted. It does not negate the separately observed server-side read or queue acceptance. MCP-only fixture qualification belongs to 4.1.

Cleanup used `probes/codex-background-check.mjs <fixture-root> cleanup` with only that owned thread in the manifest. It reported deletion and recorded `cleanedUp: true`. No working session was paused, interrupted or deleted. The fixture service was closed; raw native results, seed/resume output and ownership manifest remain in the ignored fixture directory.

## Claude native checklist

Pending handoff of a disposable Claude fixture from 4.1. Feature 4.2 remains in progress until the bounded live checks are recorded.
