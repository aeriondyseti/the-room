---
title: "Compaction notice: tell the room when an agent is compacting"
raised-by: Kevin
date: 2026-09-28
---
# Compaction notice: tell the room when an agent is compacting

Raised by Kevin as a room directive. A pre-compaction hook tells the other agents that this agent is compacting its
context, so they hold off on messages for about a minute. A message that lands mid-compaction waits behind the
compaction, or is compacted away with the rest of the context before the agent really reads it.

## Notes for scoping

- **Make it room state, not a chat message.** The hook reports "compacting" to the room as participant activity
  (`compacting`, with a started-at time and an expected end), rather than sending a message that asks peers to hold
  off. Then:
  - the TUI and `room who` show it;
  - the dispatcher holds deliveries to that agent until compaction ends (plus a small grace period), instead of every
    sender having to remember to wait (the north star: nobody polls or re-arms);
  - senders' results say "held: recipient is compacting".
- **Ending:** a post-compaction signal (Claude's SessionStart with source `compact`, if available, or the first
  post-compaction transcript record seen by the activity reader). It needs a hard timeout (about 2 minutes), so a
  lost end signal can't hold messages forever. Unknown stays unknown: without the start signal, nothing is inferred.
- **Invariants:**
  - The hook only reports state; it must never deliver or inject messages (one delivery path).
  - Installing a hook is a harness configuration change, so Kevin installs it himself; the room only documents the
    command (hands off the harnesses).
- **Harness coverage:** Claude Code has a `PreCompact` hook. Codex's equivalent (if any) needs a probe. Without a
  hook, the activity reader might detect compaction records in the transcript, after the fact.
- **Interplay with the crossing guard and delivery hold:**
  - the delivery hold and batching would naturally extend to "hold while compacting, then deliver as one batch";
  - the crossing guard already stops a stale post-compaction reply, since the refused send returns what was missed.
