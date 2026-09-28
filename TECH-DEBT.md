# Tech Debt Ledger

Known issues we **consciously chose not to fix now**, so they aren't lost. Sources: code-review findings
that fell below the action threshold or were deferred as out of scope, acknowledged shortcuts taken to
keep a sprint focused, and "good enough for now" decisions worth revisiting.

**What to log here:** plausibly-real review findings we didn't work (for example confidence around
26–79), any finding of 80 or more we deliberately defer (with a reason), and intentional shortcuts.
**Don't** log obvious false positives (confidence 25 or below) or things the typechecker already handles.

**Status key:** 🔵 Open · 🟢 Resolved · ⚪ Won't-fix (with reason)

| ID | Date | Sprint | Source | Description | Conf./Severity | Why deferred | Suggested fix | Status |
|---|---|---|---|---|---|---|---|---|
| TD-0001 | 2026-09-28 | (bootstrap) | shortcut | `poc/` (pair-poc) duplicates messaging logic that the real room replaces; its participant ids are hard-coded | —/low | Needed for coordination until 4.1 | Delete `poc/` after 4.1 moves both agents to the real room | 🔵 Open |
| TD-0002 | 2026-09-28 | 0.1 | review (guidance) | `MAX_FRAME_BYTES` (4 MiB) is a contract constant, not a `ROOM_*` tunable | 30/low | It's a wire-protocol limit both peers must agree on, so a per-process override could break connections. Envelope budgets (≤900K chars) are enforced far below it with `message_too_large` | Revisit only if legitimate frames approach 4 MiB | ⚪ Won't-fix |
| TD-0003 | 2026-09-28 | 0.1 | review (interface) | `NativeEvidence` doesn't tie `harness` to `source` at the type level (e.g. `harness: 'claude'` with `source: 'codex-env'` type-checks) | 40/low | A runtime check in the service is simpler than a discriminated union at this stage | 1.2/2.3/2.4: the service rejects mismatched harness/source with `bad_request`; test it | 🔵 Open |
| TD-0004 | 2026-09-28 | 0.1 | review (silent) | `fromErrorInfo` downgrades unknown error codes to `internal` (the original code survives only in the message text) | 35/low | Codes are a closed set shared by both sides at one protocol version | If the protocol versions ever diverge, carry the original code in a field | 🔵 Open |
| TD-0005 | 2026-09-28 | 0.1 | review (guidance/invariants) | `Caller {kind:'human'}` is asserted by the client frame; human authority relies on the connection's `hello` client kind (`tui`/`cli`, never `mcp`) | 45/medium | The connection-level rule is documented in the contract; enforcement belongs to the service | 1.2: the service enforces "human only from tui/cli connections" for send/pause/resume/retry/shutdown. 2.3: the CLI sends an agent caller whenever it detects agent context and refuses human-only commands there (the rule is in the Caller doc). Test both | 🔵 Open |
| TD-0006 | 2026-09-28 | 2.2 | cross-review (Astra) | Claude adapter still submits when the session record's process start time cannot be verified (PowerShell query failed or no procStart recorded); probe reports liveness `unknown` in that case | 50/low | Blocking would stall every Claude delivery wherever the start-time query is unavailable. Evidence that makes it safe: the target pipe name and key file are bound to that exact session (the key file name hashes the pipe path; the pipe dies with the process), so a reused pid cannot serve it — the worst case is a connect failure (`failed`), never delivery to the wrong session | Add a cheaper, reliable start-time source (e.g. native process query) so unverified becomes rare; surface `unverified` in delivery evidence if Kevin wants it visible | 🔵 Open |
| TD-0007 | 2026-09-28 | 2.2 | review (contract) | A Claude receiver that rejects our auth token closes the connection after we've written both frames, so it's reported `uncertain` rather than the ROADMAP's `failed` for auth failures | 55/low | The protocol sends no auth acknowledgement, so an auth rejection can't be told apart from a close after delivery; `uncertain` is the honest result. The token is re-read from the key file on every submit, so stale tokens are rare | If Claude adds an auth ack or a status frame (see TD-0008), wait for it before writing the user frame | 🔵 Open |
| TD-0008 | 2026-09-28 | 2.2 | shortcut | The Claude pipe client ignores control and status frames from the receiver (e.g. `peer_message_status`, hold notices) | —/medium | Their format isn't qualified yet, and MVP delivery evidence is the pipe write | Qualify the frames on a live session; map receipts and holds to delivery evidence (accepted/held) in the ledger | 🔵 Open |

---

### Notes
- Add a row whenever a review (or development) surfaces something we don't fix in the current sprint.
  IDs are allocated sequentially; either agent may add rows.
- Reference the originating `reviews/<sprint-id>.md` where relevant.
- Triage at milestone boundaries; Milestone 6.3 works the ledger after v0.1.0.
