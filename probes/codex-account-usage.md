# Codex account usage source (6.6)

Verified on Windows, Codex 0.157.1, 2026-09-28. Read-only RPC through the existing shared daemon:
`account/rateLimits/read` with exactly `{excludeResetCreditDetails:true}`. The optional
supportsLunaReserve capability is never sent (its generated schema describes experiment exposure).
No daemon/thread starts, queue inserts, auth-file reads or configuration writes are performed.

Generated native schema establishes windowDurationMins, usedPercent and resetsAt (epoch seconds),
plus a legacy rateLimits mirror and rateLimitsByLimitId. The source prefers keyed buckets and never
adds percentages. Each bucket remains separate. Only source-provided durations identify a 5h or
weekly window; primary/secondary are slots, not fixed time meanings.

Live provider returned account scope and a valid weekly window in primary; secondary was absent.
The pinned 5h window has usedPercent:null and an explicit missing reason. Latest enrolled rollout
rate_limits also provided only a weekly window; no 5h value was invented or sourced from an
unattributed old account. Live status observation still returned online/busy after transport reuse.
No raw account id, auth material, profile path or personal quota values are recorded here.

Account identity is sha256(harness + purpose + native account id); a profile/source has a separate
hashed home key. When identity is absent, scope is profile, not an account assertion. A newly
identified account with unusable windows keeps its new key so the monitor cannot retain the old
account's values. Backend ordinaryUsageAllowed is preserved independently of percentages.
The shared monitor owns sampling cadence and stale-last-good policy. Source failure is unavailable;
exceptions yield fixed diagnostics. Source successes carry checkedAt and local observation time.

The existing bounded WebSocket proxy reader now permits only thread/read and account/rateLimits/read.
It reconstructs parameters itself, limits total input bytes/time, rejects oversized outgoing frames,
and logs no raw native payloads. Existing thread-ID response validation remains in the status wrapper.
ROOM_CODEX_STATUS_TIMEOUT_MS / ROOM_CODEX_STATUS_MAX_BYTES bound both read-only daemon requests.

Validation: 254/254 full-suite tests. New fixtures check endpoint allowlisting, no experiment fields,
oversized frames, mirror dedup, primary-weekly and primary-5h ordering, multiple buckets, missing/invalid
values, reset timestamps, account switches, unavailable sources and exception privacy. Existing status
framing/timeout tests remain green. Independent correctness review reran 10 focused tests before the
final outgoing-frame guard; Claude's contract review approved with that guard as a nonblocking nit,
now implemented and regression-tested.
