# Crossing guard, withdraw and urgent sends (Milestone 7)

Status: **draft for alignment** (Claude owns this consolidated spec; Astra cross-reviews). No runtime code until the
contract (`src/contracts/crossing.ts`, Astra, sprint/7.1) and this spec agree. Sources:
- Kevin, 2026-09-28: "An agent should be able to withdraw/cancel a message that hasn't been received yet. An agent
  should have a way to send something that is urgent without waiting for the other agent. Other than those two, I'm not
  solid on the invariants … consider your own ergonomics more important than mine for this feature."
- Kevin, 2026-09-28: "Once inference has begun on a message, recalling it falls within the realm of message-history
  editing, which is out of scope. Let's stick with 'if native harness has accepted = too late to recall'."
- IDEAS.md, "Crossed-reply guard".
- The Claude ⇄ Astra design exchange of 2026-09-28, including Astra's amendments and spec cross-review of f65545e.

## 1. Problem

Two agents reply to each other at the same time, each from a view of the conversation that is already out of date,
so their messages cross. The 6.17 → v0.7.5 divider hand-off crossed three times in a row. The room cannot know what a
model considered or understood. It can know which addressed messages the snapshot token supplied with a send
**covers**, and refuse the send when something addressed to the sender is not covered.

## 2. Terms

- **Coverage:** the set of messages addressed to a participant binding (the human's messages included) that a snapshot
  token covers. Coverage is a set that can have holes, not a single "everything up to revision N" watermark.
- **Inbox revision:** a per-recipient-binding monotonic counter, used only for change detection. It never implies that
  every earlier message is covered.
- **Snapshot token:** opaque evidence the room issues together with the content it covers, bound to the room and the
  sender's binding. It certifies only that content was returned; it is never comprehension evidence. Tokens can extend
  coverage cumulatively across pages, validated by the server. Delivering a native envelope never advances any
  reviewed state.
- **Not covered by snapshot:** an addressed message outside the supplied token's coverage. The TUI and tools say "not
  covered by snapshot" / "new since snapshot", never "unseen".
- **Attempt:** one send request, with a server-issued `attemptId`. A revised retry names the attempt it replaces via
  `revisesAttemptId`; lineage is never inferred from text or timing.

## 3. Guarded send (compare-and-send)

- `room_send` / `room send` take `snapshot`. At commit, atomically with the persist-before-acknowledge transaction
  (invariant 4):
  - **Any addressed message is not covered** (including older ones an envelope token omitted): the result is
    `not_sent` (`snapshot_stale`), with nothing enqueued. It returns an inbox review page of the uncovered messages, a
    fresh token covering what it returned, and the `attemptId`.
  - **Everything addressed is covered:** the send commits as today.
  - **Token from another binding or room, or malformed:** `not_sent` (`snapshot_invalid`).
- **A missing token is also `not_sent`** (`snapshot_required`), with the same shape. A cold first send costs exactly
  one retry **only when the whole uncovered inbox fits the response budget**. Otherwise the page reports `hasMore`,
  `remaining` and `nextCursor`, and the agent pages on (`room_inbox`) to build cumulative coverage before sending.
- **Getting a token:**
  - `room_inbox` returns a review page (`items`, `snapshot`, `hasMore`, `nextCursor`, `remaining`).
  - A delivered envelope carries a token covering **that one message only**. A reply made with it is `not_sent` when
    anything else addressed to the sender is uncovered, as intended.
  - `room_read` stays historical and exposes a token only for content it actually returns in full.
  - No token certifies an omitted body. An oversized message's labelled reference is not coverage until the reference
    has explicit read/coverage semantics; that shape is settled before implementation, not assumed.
- **Human messages:**
  - They count as addressed messages for agents: a directive must be covered before replying.
  - The human's own sends bypass the guard (`guard: 'human'`).
- **A blocked send is not a sent message.** It is audited separately (attempt id, reason, delta size) and is not shown
  as a room message.
- **Legacy callers:** if an unguarded compatibility mode is retained, it is explicit and labelled (advisory mode,
  configured). There is no implicit "last acknowledged" watermark and no shared latest token.

## 4. Urgent send (Kevin's requirement)

- `urgent: { reason }` (reason required, nonblank) skips the coverage check (`guard: 'urgent'`) and is audited. The
  result reports `newSinceSnapshot`: a count when a valid snapshot was supplied, and `null` (shown as "unknown")
  otherwise, never a fabricated number.
- **Delivery:**
  - the same native transport (invariant 1);
  - a **room-side priority lane**: among a recipient's deliveries the room has not yet submitted, urgent ones go
    first, FIFO within the urgent lane and within the normal lane. This is a deliberate, recorded exception to the
    per-recipient ordering of invariant 4; it needs its own ADR, and it is recorded in the ledger per delivery;
  - it never preempts a delivery already being submitted or already accepted by the harness;
  - it respects the human's /pause, since urgency is an agent's claim and the pause is the human's authority. While
    paused it is held, labelled urgent, and released first on /resume.
- **Visibility:** the envelope is marked URGENT with its reason, and so is the TUI.
- "Never waits" means never waits on the guard, plus the room-side priority lane. When the recipient processes it is
  up to the harness; there is no promise of immediate receipt, processing, or a turn boundary.

## 5. Withdraw (Kevin's requirement, bounded by his scope decision)

- `room_withdraw(message_id, recipients?)` / `room withdraw <id>`, by the original sender only. Identity is resolved as
  for sends; a later registry rebinding does not confer old ownership.
- **The cutoff is native acceptance.** Once the harness has accepted a delivery it is too late to recall. Recalling it
  would be message-history editing, which is out of scope. Withdraw cancels only broker-pending deliveries.
- **A compare-and-swap against the dispatcher's claim, per recipient**, returning one of:
  - `withdrawn`: not yet claimed for submission; cancelled by the broker.
  - `already_submitting`: a delivery attempt is in flight. This is not a success; it may still fail later.
  - `submitted`: the harness accepted it; too late to withdraw.
  - `uncertain`: submission may have happened (never retried, invariant 2); not a success.
  - `already_visible`: the recipient is the human. The message was visible in the TUI history at commit, and there is
    no queued delivery to cancel.
  - `replied` / `already_withdrawn`.
- **Rules:**
  - A partly delivered broadcast is never shown as wholly withdrawn.
  - Tombstones and history are kept; withdrawing never erases history that was already exposed.
  - Never infer "not received" from the absence of a reply.
  - The tool description says plainly that withdraw covers only messages the room has not yet handed to the harness.
- **Option for Kevin (not a default):** a short broker-side hold before submission would widen that window at a latency
  cost on every message. It is listed so he can choose it; nothing is silently delayed.

## 6. Native recall: out of scope

Earlier drafts proposed probing native recall. Per Kevin's decision (§5), M7 has no native recall, no `recalled`
result, and no recall probes. For the record:
- **Claude:** no recall mechanism is known.
  - "Submitted" means the pipe write was accepted and the receiver stayed open for the settle window
    (`src/adapters/claude/pipe.ts`); no receipt comes back.
  - Processing is harness-controlled. 4.1 evidence showed a second message to a busy session attached mid-turn, so no
    turn boundary is promised.
- **Codex:** the 0.157.1 app-server schema lists `thread/queue/delete`. It was only inspected locally and never
  probed live.

## 7. Surfaces (Claude)

- **MCP / CLI:**
  - `room_inbox`;
  - `snapshot`, `urgent: { reason }`, and `revisesAttemptId` on `room_send`;
  - `room_withdraw`;
  - `room send|withdraw|inbox` in the CLI.

  Tool descriptions are written for models:
  - on `not_sent`, read the returned messages, then page on if `hasMore`;
  - revise, and retry with the fresh token and `revisesAttemptId`;
  - reply with the envelope's token;
  - urgent is for time-critical messages and requires a reason;
  - withdraw is too late once the harness has accepted a message.

  Overrides are deliberate and audited, never suggested as the first escape.
- **TUI:**
  - ⤫ marks a send made against a snapshot that did not cover an addressed message (not a proven semantic conflict);
  - withdrawn deliveries are shown struck and labelled per recipient;
  - URGENT and its reason are shown;
  - agent chips show "N not covered" and name the snapshot they summarize (the latest one the agent was issued). This
    watermark is display only and never authorizes a send;
  - a blocked-then-revised attempt appears as one line ("revised after #N"), never as two messages.

## 8. Ownership (agreed at the milestone boundary)

- **Astra:** `src/contracts` shapes, coverage and tokens, ledger, dispatch, withdraw CAS, the urgent lane, and audit.
- **Claude:** this spec, the ROADMAP/PROGRESS rows, MCP/CLI tools, envelopes, and the TUI.
- Each cross-reviews the other. Contracts land first; the surfaces are built against fakes in parallel.

## 9. Acceptance (draft)

- **Crossing:** a reciprocal A→B and B→A, each sent with a token current for its **own** binding at the time. Exactly
  one commits; the other gets `not_sent` with the delta and commits on a revised retry. This guarantee is for that
  setup only, not for every set of concurrent sends.
- **Coverage holes:** a reply made with an envelope token while an older addressed message is uncovered is `not_sent`.
- **Missing token:** `not_sent` with the inbox and a token. The cold send takes one retry when the inbox fits the
  budget, and paging with `hasMore`/`remaining` when it does not.
- **Human messages:** a human directive arriving mid-draft blocks the agent's stale send; the human's own sends are
  never blocked.
- **Urgent:**
  - commits over uncovered messages, with `newSinceSnapshot` null when no valid snapshot was given;
  - is labelled and audited;
  - is FIFO within its lane and never preempts an in-flight or accepted delivery;
  - is held while paused.
- **Withdraw:**
  - every per-recipient outcome is reachable in fixtures: pending → withdrawn; in flight → already_submitting;
    accepted → submitted; human → already_visible;
  - there is no false success;
  - tombstones are visible.
- **No regressions:** invariants 1–9 hold, with the urgent-lane exception to per-recipient order recorded in an ADR;
  existing tools keep working in the explicit mode.
