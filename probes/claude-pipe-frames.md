# Claude messaging pipe: frames sent back to the sender (TD-0008 qualification)

Date: 2026-09-28 · Claude Code 2.1.283 · Windows 11. The target was one **throwaway fixture only** (`vpfix-fxp`,
`claude --bg --model haiku`), and the probe refuses any other session. The peer token was never printed.
Probe: `scripts/probes/pipe-frames.mjs <sessionId> idle|burst|badtoken`.

| Case | What we sent | Frames back | Connection | Reached the model? |
|---|---|---|---|---|
| idle | auth + 1 user frame | **none** in 8s | held open until we closed it | ✅ in the transcript |
| burst | auth + 2 user frames back to back | **none** in 8s | held open | ✅ both, in order |
| badtoken | wrong token + 1 user frame | **none** | **receiver closed after ~3ms** | ❌ absent from the transcript |

## Conclusion

- The receiver sends **no receipt or status frames** for ordinary `user` frames. There's nothing to parse into
  "accepted" or "held" evidence, so TD-0008 is resolved by qualification, not new code.
- The strings `peer_message_status` and `peer_idle_notice` in the binary are control actions a peer has to *request*
  (see probes/claude-background-results.md). They are not unsolicited acks, and using them would mean adopting an
  unqualified control protocol, which we don't do.
- **Evidence stays as designed (2.2):**
  - the frame was written and the receiver held the connection through the settle window → `submitted`;
  - a close inside the window → `uncertain`.
  - The bad-token case shows why the window matters. An auth rejection is a fast close, and it is indistinguishable
    on the wire from a close after reading, so it stays `uncertain` and is never auto-retried (invariant 2; TD-0007).
