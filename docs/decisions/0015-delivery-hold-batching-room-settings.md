---
id: ADR-0015
status: accepted
date: 2026-09-28
made-in: "7.6"
supersedes: []
superseded-by:
tags: [delivery, settings]
---
# Delivery hold, same-sender batching and room settings (7.6)

## Context and Problem Statement

Kevin asked for a short hold before delivery so withdraw is useful, configurable in settings, and for held messages
(especially his) to go as one message.

## Considered Options

A fixed hold with no batching was simpler, but it ignored Kevin's request that held messages go as one.
Cross-sender batching gave fewer wake-ups but would blur the authority header, so it was rejected. Keeping settings
in environment variables only was rejected because they aren't editable settings for the human.

## Decision Outcome

- **Hold:** ordinary messages get a persisted `notBefore` (`deliveryHoldMs`, default 500 ms). Urgent messages and
  stop requests bypass both the hold and batching. Pause is independent. A hold of 0 disables the hold and
  batching.
- **Batching:** consecutive held messages from the same sender (native scope, `from`, authority) to the same
  recipient binding form a burst. Each joining message extends the deadline, capped at `batchMaxHoldMs` (default
  2000 ms) from the burst's first message. A burst goes as ONE native envelope (`buildBatchEnvelope`) with one
  authority header, each message whole under a tagged part line, and the token covering exactly the included
  messages. Claim and settlement are atomic per batch.
- **No mixing senders:** batches never mix senders, because the first-line header is the recipient's only trusted
  authority marker.
- **Settings:** `.room/settings.json` (versioned, locked atomic writes, unknown keys preserved) is read live and <!-- docs-check-ignore -->
  edited only by the human from the TUI's `/settings`. `ROOM_*` environment variables override the effective values
  and are reported as such.
  - Invalid environment policy fails at service start.
  - A bad file at runtime never blocks delivery: the service uses the last good values (or the defaults), reports the
    problem, and a human save repairs the file, backing up the bad content.
- **Older binaries:** a binary from before 7.6 ignores `notBefore` and `burst` and delivers each queued message on
  its own, right away and without the hold. That degrades safely; restoring the newer binary resumes holding.

## More Information

The old log gave this record no status line or author; it is converted as accepted (it shipped in v0.8.1). The
progress notes name Astra (core) and Claude (envelope text, `/settings`, docs) as 7.6's owners.

Decision-makers, as first recorded: Kevin, Astra, Claude.
