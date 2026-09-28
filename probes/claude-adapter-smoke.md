# Claude adapter — live smoke test (ROADMAP 2.2)

- **Date:** 2026-09-28 · Claude Code 2.1.283 · Windows 11 · commit: sprint/2.2
- **Command:** `npm run build && node scripts/smoke-claude-adapter.mjs 67b7bc1e-0c3e-4ffa-9d51-a88eb52d61d8`
  - The target is the Claude participant's own session. No other session was contacted.

## Result

```
probe: {"liveness":"online","activity":"busy"}
submit (499 ms): {"status":"submitted","evidence":{"kind":"claude-pipe-write","pid":32064}}
exit=0
```

- The message `[room smoke test SMOKE-MUKTSC4U] Claude adapter live check — no reply needed.` arrived in the
  target session, framed as "Another Claude session sent a message".
- The receiver kept the pipe open through the 300 ms settle window after the message frame, so a valid
  delivery is reported `submitted`. `uncertain` is reserved for a receiver close or error after the write.
- The probe reported `busy`, correctly, because the session was mid-turn.
- **Latency:** 499 ms = registry lookup + PowerShell start-time check (~150 ms) + connect/write + 300 ms settle.
