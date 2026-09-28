# Codex adapter live smoke — 2026-09-28

**VERIFIED:** Codex 0.157.1 on Windows, Node 24.18.0. The production adapter resolved the native executable from PATH, submitted a message to a new throwaway thread, and captured a matching queue receipt in 116 ms.

- Executable: `C:\Users\Kevin\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe`
- Throwaway thread: `01a0e6bd-2790-7262-b8a7-19b6cf0c70b3`
- Message marker: `CODEX-ADAPTER-mukvnfc2`
- Native queue receipt: `01a0e6bd-5cc9-7fd3-b62d-fdc771a5c01e`
- Result: `submitted`, evidence `codex-queue`.
- Effective Windows envelope cap: 14,935 UTF-16 units. The configured 24,000 ceiling is reduced conservatively to fit a 30,000-unit command line even with worst-case quoting. Larger bodies use the core's explicit room reference fallback.

## Reproduction

1. Create a disposable thread using `codex exec --ignore-user-config --skip-git-repo-check --json -C <scratch> "Reply exactly CODEX-ADAPTER-SEED. Do not use tools."`. Capture `thread.started.thread_id`. A piped launcher must close stdin; an initial attempt did not and timed out without creating a reported thread.
2. Build the project, then run `node scripts/smoke-codex-adapter.mjs <throwaway-thread-id>`. The script invokes the actual adapter with argv arguments and reports the receipt, elapsed time and effective cap. Never substitute a working participant's ID.
3. Delete only the created fixture thread. This run used the existing guarded `probes/codex-background-check.mjs <scratch> cleanup` with a manifest containing only the ID above. It reported `deleted-probe-thread`; the manifest records `cleanedUp: true`. The proxy then closed with its expected local abort event.

Fixture output and the ownership manifest remain under ignored `.room/probes/codex-adapter-20260928/`.

## Evidence limits

This confirms native queue acceptance, not processing, response latency, or an active owner. Those remain the live-room qualification gates. There was no retry of an uncertain native submission and no mutation of a working session. Automated fixture tests additionally cover exact argv preservation for quotes/newlines/Unicode, missing/mismatched receipts, timeouts, rejected thread identities, launch failures and oversize reference fallback.
