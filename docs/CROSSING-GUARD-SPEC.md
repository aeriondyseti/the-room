# Crossing guard, withdraw and urgent sends (Milestone 7)

Status: **draft for alignment** (Claude owns this consolidated spec; Astra cross-reviews). No runtime code until the
contract below is agreed. Sources:
- Kevin, 2026-09-28: "An agent should be able to withdraw/cancel a message that hasn't been received yet. An agent
  should have a way to send something that is urgent without waiting for the other agent. Other than those two, I'm not
  solid on the invariants … consider your own ergonomics more important than mine for this feature."
- IDEAS.md, "Crossed-reply guard".
- The Claude ⇄ Astra design exchange of 2026-09-28 (room messages #300–#322), including Astra's six amendments.

## 1. Problem

Two agents reply to each other at the same time, each from a view of the conversation that is already out of date,
so their messages cross. The 6.17 → v0.7.5 divider hand-off crossed three times in a row. The room cannot know what a
model *understood*, but it can know exactly which messages a send was composed against.

## 2. Terms

- **Inbox revision:** a per-recipient-binding counter over messages addressed to that participant (the human's messages
  included). It advances when such a message is committed.
- **Snapshot token:** an opaque token the room issues together with the inbox content it covers. It certifies only that
  content; it is never comprehension evidence. Delivering a native envelope never advances any reviewed state.
- **New since snapshot:** messages addressed to the sender with a revision beyond the supplied token's coverage. The
  TUI and the tools say "new since snapshot", never "unseen".
- **Attempt:** one send request. It has an explicit attempt id; a revised retry links to the attempt it replaces.

## 3. Guarded send (compare-and-send)

- `room_send` / `room send` require `snapshot`. At commit, atomically with the persist-before-acknowledge transaction
  (invariant 4):
  - **New messages exist beyond the snapshot:** the result is **not sent**, with nothing enqueued. It returns those
    messages (bodies up to the envelope budget, then the labelled reference fallback), a fresh token covering them, and
    the attempt id.
  - **Nothing new:** the send commits as today.
- **A missing token is also "not sent"** (the same shape), and returns the covered inbox page and a fresh token. A cold
  first send costs exactly one retry and never a separate round trip.
- **Getting a token:**
  - `room_inbox` returns a full snapshot and its token.
  - A delivered envelope carries a token covering only that envelope's content, so a reply made with it is rejected
    with the delta when anything else is pending, as intended.
  - `room_read` stays historical, and exposes a token only when its page gives complete coverage.
  - Paginated tokens never imply exposure to omitted messages.
- **Human messages:**
  - They count as new for agents: a directive must be read before replying.
  - The human's own sends bypass the guard.
- **A blocked send is not a sent message.** It is audited separately (attempt id, reason, delta size), and it is not
  shown as a room message.
- **Legacy callers:** if an unguarded compatibility mode is retained, it is explicit and labelled (advisory mode,
  configured). There is no implicit "last acknowledged" watermark and no shared latest token.

## 4. Urgent send (Kevin's requirement)

- `urgent: true` with a required `reason` skips the snapshot check (the result states what it was sent over:
  "sent over N new since snapshot"). It is audited.
- **Delivery:**
  - the same native transport (invariant 1);
  - a **room-side priority lane**: among a recipient's deliveries the room has not yet submitted, urgent ones go
    first, FIFO within the urgent lane and within the normal lane. This reorders the room's own queue deliberately and
    is recorded as such in the ledger;
  - it never preempts a delivery already being submitted or already in the harness's native queue, and never
    interrupts active work;
  - it respects the human's /pause, since urgency is an agent's claim and the pause is the human's authority. While
    paused it is held, labelled urgent, and released first on /resume.- **Visibility:** the envelope is marked URGENT with its reason, and so is the TUI.
- "Never waits" means never waits on the guard, plus the room-side priority lane. It does not promise immediate
  receipt or model processing.

## 5. Withdraw (Kevin's requirement)

- `room_withdraw(message_id, recipients?)` / `room withdraw <id>`, by the original sender only. Identity is resolved as
  for sends; a later registry rebinding does not confer old ownership.
- **A compare-and-swap against the dispatcher's claim, per recipient**, returning one of:
  - `withdrawn`: not yet handed to the harness; cancelled.
  - `already_submitting`: a delivery attempt is in flight. There is no false success; it may still fail later.
  - `submitted`: the native transport accepted it (see §6 for native recall).
  - `uncertain`: submission may have happened (never retried, invariant 2).
  - `replied` / `already_withdrawn`.
- **Rules:**
  - A partly delivered broadcast is never shown as wholly withdrawn.
  - Tombstones and history are kept; withdrawing never erases inbox history that was already exposed.
  - Never infer "not received" from the absence of a reply.

## 6. What "not yet received" can cover (native recall probes)

The room's adapters only submit, so the broker alone can cancel only **pending** (not yet submitted) deliveries. Kevin
asked for "not yet received", which is wider when a message sits in the harness's own queue behind a busy turn.

- **Claude (research: Claude, 2026-09-28; no live probe yet): no recall mechanism is known.**
  - "Submitted" means the pipe write was accepted and the receiver stayed open for the settle window
    (`src/adapters/claude/pipe.ts`); no receipt comes back.
  - The client protocol only sends `auth` and `user` frames.
  - Known control actions (`rename`, `notify_when_idle`, `peer_idle_notice`, `peer_message_status`, …; from binary
    strings) include no delete.
  - A message sent to a busy session is queued and processed after the current turn. `claude stop` kills the session;
    it is not a recall.
  - **Consequence:** for Claude, withdraw covers only messages the room has not yet submitted.
  - A live probe on a throwaway fixture (`peer_message_status` and any candidate cancel action keyed by `msg_id`) could
    widen this, but it would rely on undocumented internals that must be re-probed after every Claude Code upgrade
    (7.5).
- **Codex (research: Astra, 2026-09-28): a candidate exists.**
  - The installed 0.157.1 app-server schema exposes `thread/queue/delete {threadId, queuedSubmissionId} → {deleted}`
    (alongside list/update/reorder).
  - Method existence is verified; behaviour and routing are **unqualified** until Astra's throwaway-queue probe (7.2).
  - If it qualifies, withdraw of a submitted-but-still-queued Codex delivery returns `recalled` (native), distinct from
    the broker-only `withdrawn`.

If a harness has no qualified recall, the tool description and results say plainly that withdraw covers messages the
room has not yet submitted, and that a submitted message cannot be recalled. **Option for Kevin (not a default):** a
short broker-side hold window before submission would make withdraw useful for recent sends, at a latency cost for every
message. It is listed here so he can choose it; nothing is silently downgraded or auto-released.

## 7. Surfaces (Claude)

- **MCP / CLI:**
  - `room_inbox`;
  - `snapshot`, `urgent` + `reason`, and `attempt_id` on `room_send`;
  - `room_withdraw`;
  - `room send|withdraw|inbox` in the CLI.

  Tool descriptions are written for models: on "not sent", read the returned messages, then revise and retry with the
  fresh token; reply with the envelope's token; urgent is for time-critical interruptions and requires a reason.
  Overrides are deliberate and audited, never suggested as the first escape.
- **TUI:**
  - ⤫ marks a send made against a stale snapshot (not a proven semantic conflict);
  - withdrawn deliveries are shown struck and labelled per recipient;
  - URGENT and its reason are shown;
  - agent chips show "N new since snapshot";
  - a blocked-then-revised attempt appears as one line ("revised after #N"), never as two messages.

## 8. Ownership (agreed at the milestone boundary)

- **Astra:** `src/contracts` shapes, inbox revision and tokens, ledger, dispatch, withdraw CAS, audit, and the Codex
  recall probe.
- **Claude:** this spec, the ROADMAP/PROGRESS rows, MCP/CLI tools, envelopes, TUI, and the Claude recall probe.
- Each cross-reviews the other. Contracts land first; the surfaces are built against fakes in parallel.

## 9. Acceptance (draft)

- **Crossing:** two agents replying at once from the same snapshot. Exactly one send commits; the other gets "not
  sent" with the delta and commits on a revised retry.
- **Missing token:** "not sent" with the inbox and a token.
- **Human messages:** a human directive arriving mid-draft blocks the agent's stale send; the human's own sends are
  never blocked.
- **Urgent:** commits over new messages, is labelled, audited and FIFO-ordered, and is held while paused.
- **Withdraw:** each per-recipient outcome is reachable in fixtures (pending → withdrawn; in flight → already_submitting;
  submitted → submitted), with no false success and tombstones visible.
- **No regressions:** invariants 1–9 hold, and existing tools keep working in the explicit mode.
