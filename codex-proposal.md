# Codex proposal: a shared coding-agent room

Status: proposal only; implementation has not started.

## Objective

Build a chat room where a human and multiple coding agents coordinate work in the same repository. Claude Code and Codex are required harnesses. agy support is optional and must not delay reliable support for the required harnesses.

The primary requirement is responsiveness: a message addressed to an agent must cause its harness to process input, either by starting a turn immediately or by durably queueing a subsequent turn. Merely storing a message, updating conversation history, or writing to a socket does not satisfy this requirement.

## Recommended initial scope

Prefer a bridge into existing harness sessions using their native messaging and queue interfaces. Each participant has its own identity, harness session, and conversation, with the repository as its working directory. Room-launched sessions remain a fallback and an option for new participants.

The local investigation below establishes a concrete native Claude peer protocol and a reachable existing Codex daemon with queue methods in its generated schema. Claude Code's subsequent [live-test report](findings-codex-messaging.md) establishes feasibility for Codex CLI 0.157.1 on Windows: CLI queue insertion woke an idle TUI, produced a subsequent turn when busy, and retained input for an inactive thread until TUI resumption. These are reported experimental results, not independently repeated reliability tests or proof of desktop-app behavior.

Resuming a saved conversation is not equivalent to attaching to its current process, and the system must not silently create a competing owner of the same conversation. Queue submission and active-turn control may use different server instances. Enrollment must record the exact thread UUID, CLI installation, configuration/home context, client type, and separately verified observation/control capabilities.

The first release should support multiple participants of either required harness, human-to-agent messages, agent-to-agent messages, broadcasts, and agent-to-human replies. Agents may work in the same checkout. File ownership and task boundaries should be communicated explicitly; isolated worktrees can be a later option.

## Architecture

The room server owns delivery and scheduling. The chat interface and agent tools are clients of that server.

- **Room and participant registry:** repository, human identity, agent identities, harness types, session IDs, connection state, and capabilities.
- **Persistent message store:** ordered room messages, explicit recipients, reply relationships, per-recipient delivery records, and delivery attempts.
- **Scheduler:** a durable delivery ledger per agent, handing off to native harness queues where verified. Reconcile native submission state before retrying; do not create a competing scheduler for the same delivery.
- **Harness adapters:** discover and connect to existing sessions, submit native input, observe execution, handle approvals, interrupt where supported, and report failures. Launch or resume sessions when explicitly enrolling a new or stopped participant.
- **Chat UI:** shared conversation, participant status, pending messages, approvals, and human controls.
- **Agent tools:** `send_message`, `read_messages`, and `list_participants`, exposed through MCP and backed by the room server.

A small local service with SQLite persistence is a suitable starting point. Language and UI framework selection should follow the adapter experiments, rather than precede proof that both harnesses can be driven reliably.

## Message and scheduling semantics

Persist the message and its recipient deliveries before reporting successful enqueueing to the sender. Sending returns promptly and does not wait for the recipient's answer.

| Recipient state | Required behavior |
| --- | --- |
| Idle | Start a turn promptly after persisting the message. |
| Working | Queue the message durably and dispatch automatically after the active turn finishes. |
| Waiting for approval or human input | Surface the request to the human and retain incoming messages. |
| Disconnected | Keep deliveries pending and reconnect or resume the managed session. |
| Delivery uncertain | Reconcile available harness evidence before retrying. |
| Paused by the human | Retain messages without starting new turns until resumed. |

Queueing is the default. Human controls may also request steering or interruption when the adapter supports them. Steering must be recorded as input to an existing turn, not represented as a new turn.

Use explicit addressing:

- `@agent` schedules that participant.
- `@all` schedules all other agent participants in the room at send time.
- Messages addressed to the human appear immediately without waking other agents.
- Informational status updates remain visible without scheduling turns.

Every addressed work message must be accounted for. A later batching optimization may combine pending messages into one turn, but must retain the individual delivery records and make the grouping visible. The initial implementation should favor simple ordered delivery.

Replies must use explicit recipients rather than automatically waking everyone who can see the room. This prevents ordinary progress updates from producing endless response loops. A room-wide pause gives the human immediate control over further scheduling.

## Harness adapters

### Codex: CLI queue delivery

Use `codex queue --thread <full-thread-UUID> --message <text>` as the initial delivery adapter. Invoke the configured executable with an argument array, not by interpolating room messages into a shell command.

- Register the exact thread identity from the session. Claude's report observed identical `CODEX_THREAD_ID` and `CODEX_SESSION_ID` values in shell commands; verify hook identity separately before relying on it for enrollment.
- Record the queue command's exit status and returned submission ID. Success establishes enqueueing, not processing or task completion.
- Let the native queue schedule normal work. The tested idle and busy TUI cases required neither explicit `thread/queue/start` nor a Stop-hook continuation. Do not add either operation to the normal path.
- If no active consumer exists, show the message as pending. The test demonstrated processing after TUI resumption; it did not establish that a TUI is the only possible consumer. Desktop and other hosted sessions remain untested.
- Correlate replies and execution evidence with room message IDs. Verify an observation route for each supported client; do not assume the enqueue endpoint emits that client's turn events.
- Keep steering and interruption as separately qualified capabilities. `turn/steer` needs access to the actual active thread and its expected turn ID; queue acceptance by the shared daemon does not prove that access.
- Route permission and user-input requests to the human where the adapter can observe them, and qualify approval-wait behavior before declaring full support.

The report describes the queue command submitting `thread/queue/add` to the shared daemon while the tested TUI used a separate in-process server. Shared-persistence polling is explicitly an inference. Depend on the CLI behavior, not direct SQLite writes or a particular polling implementation. Do not use `thread/loaded/list` on one daemon as the sole enrollment inventory.

Direct queue RPCs remain a later integration option. The generated schema includes add, list, update, delete, reorder, and start methods. Validate their reconciliation and retry semantics before adopting them; the presence of `clientUserMessageId` does not prove idempotency. For separately room-owned sessions without a qualified native queue consumer, serialized `turn/start` remains a fallback. History injection alone does not start a turn.

Source: [Official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).

### Claude Code: native cross-session peer messaging

Reuse the protocol implemented in `X:/Development/claude-message-mcp` as the preferred existing-session bridge:

- Discover peers from `~/.claude/sessions/<pid>.json`, validating process identity and the published messaging pipe.
- Publish a bridge peer with its own process identity, reply pipe, and authentication key so Claude's native `ListAgents` and `SendMessage` can address it.
- Authenticate to the recipient pipe, then send the captured native `msgV: 1` user frame with `msg_id`, `priority: "next"`, a reply address, and a `<cross-session-message>` body.
- Receive native replies into the room and route any addressed Codex delivery through the CLI queue adapter for its registered thread.
- Respect Claude's inbound permission policy; expose held or refused messages rather than changing permission claims to force delivery.

The bridge uses a private, version-sensitive Windows protocol. Its repository records a live round trip on Claude Code 2.1.282; the currently installed version is 2.1.283. Verify current idle and busy delivery before promising automatic turn initiation. A successful pipe write alone does not establish processing.

The current bridge preserves control frames but does not interpret delivery receipts or hold/refuse notices. It also does not advertise `notify_idle`. These are adapter work, not established guarantees.

Persistent Claude Agent SDK streaming input remains a fallback for room-launched sessions. It supports ongoing input, session continuity, and permission handling.

Source: [Claude Agent SDK streaming-input documentation](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode).

### Hooks and duplicate delivery

Normal Codex message delivery uses the queue only. Do not also inject the same unread room message through `PostToolUse` or a `Stop` continuation. Any future hook-delivery path must claim a delivery atomically and reconcile an already-enqueued submission before taking ownership; a read cursor alone cannot prevent an existing native queue item from running later.

`PostToolUse` is an optional future path for updates at tool boundaries, not an immediate interruption mechanism. It cannot guarantee prompt delivery while a tool is running or during tool-free generation. Codex adds its `additionalContext` as developer context, so any peer-message payload must be enclosed as attributed message data with explicit instructions that it grants no authority or permissions. Stop-hook continuation is not required by the reported queue tests and is excluded from the initial normal delivery path.

Source: [Official Codex hook documentation](https://learn.chatgpt.com/docs/hooks).

### Optional agy adapter

Keep harness-specific behavior behind the same adapter interface. Investigate agy's available session-control and event interfaces separately. Advertise only verified capabilities; optional agy support is not part of the initial completion gate.

## Delivery evidence and recovery

Track delivery per recipient, independently of the shared room message:

`queued -> dispatching -> harness accepted -> processing -> completed`

Also represent failed, interrupted, and uncertain delivery. Some harnesses may not expose separate acceptance and processing events; do not manufacture evidence to fill those states.

- **Queued:** the message is durably recorded for this recipient.
- **Dispatching:** an adapter is attempting submission.
- **Harness accepted:** the harness has acknowledged the input using a verified signal.
- **Processing:** execution evidence is available and correlated with the delivery.
- **Completed:** the associated turn has ended successfully at the harness level; this does not establish that the requested coding task succeeded.

Record message IDs, delivery IDs, attempt IDs, harness session IDs, turn IDs where available, timestamps, and diagnostic errors. Preserve enough protocol evidence to diagnose acceptance and completion without logging credentials.

Use idempotency keys for client sends and serialize dispatch per participant. Treat a crash after submission but before acknowledgment as uncertain, not automatically unsent. Reconcile session history or execution events where possible; if evidence cannot resolve the outcome, surface the uncertainty and an explicit retry option. Do not promise exactly-once execution across an external harness boundary without a supporting protocol guarantee.

Room-level idempotency does not establish native CLI retry safety. If the queue command succeeds but the room crashes before recording its returned ID, preserve an uncertain delivery and reconcile before resubmitting. Multiple-message ordering, duplicate handling, and this acknowledgment boundary remain probe requirements.

After restart, recover queued deliveries and reconcile active or uncertain attempts before starting more work. A disconnected participant must never appear successfully completed solely because its process exited.

## Human control and shared-repository coordination

The human can direct individual participants or the room, inspect queues, pause scheduling, stop active work through supported harness controls, and answer approvals or questions.

Keep human instructions and peer messages visibly attributed. A peer message does not grant permission, impersonate the human, or change a participant's permission policy. Bind agent tool credentials to participant identities so agents cannot choose an arbitrary sender.

Show each participant's current task and intended files or area of work. Begin with explicit coordination in the room; automatic file locking or merge orchestration is not necessary to prove the central messaging requirement.

## Implementation sequence

1. **Qualify native delivery for both harnesses.** Build on the reported Codex idle/busy/resume successes. Preserve reproducible baseline evidence, then test multiple queued messages, duplicate submissions and retries, completion-boundary races, approval waits, bridge disconnects, and desktop sessions. Test current Claude peer delivery in idle, busy, and held states. Verify observation and control separately from enqueueing.
2. **Implement durable scheduling.** Add persistence, ordered per-agent queues, serialized dispatch, message-to-turn correlation, and conservative recovery.
3. **Connect agent messaging.** Expose room tools and demonstrate Claude-to-Codex, Codex-to-Claude, and agent-to-human communication.
4. **Build the chat interface.** Add conversation streaming, participant status, queue visibility, approvals, and human controls.
5. **Validate failures and recovery.** Exercise simultaneous sends, process exits, connection loss, restart with pending work, and crashes between submission and acknowledgment.
6. **Evaluate optional integrations.** Add agy and further harness/version coverage without weakening the required harness guarantees.

## Acceptance criteria

The core acceptance demonstration is:

> While Codex is working, Claude sends it an addressed message. The room persists it, automatically starts a subsequent Codex turn when eligible, and displays Codex's reply without human intervention. Repeat in the opposite direction.

Additional required checks:

- An idle participant starts processing an addressed message without polling by the model or manual prompting.
- Multiple incoming messages are accounted for in order, without overlapping normal turns for a participant.
- A message arriving at the boundary between turn completion and idle state is not stranded.
- Restarting the room preserves pending deliveries and does not blindly replay uncertain submissions.
- Harness failures and permission waits are visible and do not masquerade as successful processing.
- Both agents can address the human and receive a reply that triggers further work.
- Pause prevents new dispatches; resume processes eligible pending work.
- Ordinary status updates do not trigger unwanted reply loops.
- All required scenarios pass using real Claude Code and Codex sessions, in addition to deterministic scheduler tests.

Retain full test commands, versions/configuration, unique message and submission IDs, timestamped queue and turn events, and correlated replies. Measure enqueue acknowledgment, turn-start latency, and reply latency separately. Run at least 20 idle-wake trials per supported client configuration and a two-hour mixed idle/busy exercise. Claude's reported 2.5–8 second wake range demonstrates feasibility but does not meet the other proposal's five-second target consistently or establish a ten-second bound. Keep the latency target open until repeated measurements support an explicit product decision; report every timeout and failure.

The first milestone is complete only when actual harness events and visible responses demonstrate reliable turn triggering in both directions. A working chat interface or a successful transport write alone is insufficient.

## Native messaging investigation: 2026-09-27

The initial Codex investigation was limited to source inspection, CLI/schema discovery, and a read-only daemon connection. It sent no agent messages or inference requests. Claude Code subsequently performed the live tests described in [findings-codex-messaging.md](findings-codex-messaging.md). Reviewing those findings did not independently rerun the tests. Application implementation has not started.

### Evidence collected

| Surface | Observation | Evidence boundary |
| --- | --- | --- |
| Claude bridge source | `src/registry.js` implements native discovery/registration; `src/protocol.js` builds auth and user frames; `src/peer.js` sends them to the recipient pipe. | Current source inspected. |
| Claude live history | `DESIGN.md` records a native discovery, send, reply, and answer round trip on 2026-09-25 with version 2.1.282. | Repository-recorded result, not rerun in this investigation. |
| Claude current installation | CLI reports 2.1.283; local session records include messaging pipes and `notify_idle,artifact_yield` features. | Current metadata, not a delivery test. |
| Codex CLI | Standalone CLI reports 0.157.1 and exposes `queue`, `agents`, daemon management, and `app-server proxy`. An installed app binary reports 0.155.0-alpha.9.2 and also exposes `queue`. | CLI discovery; commands may differ by installed binary. |
| Codex queue protocol | Generated experimental schema from 0.157.1 includes `thread/queue/add`, `list`, `update`, `delete`, `reorder`, `start`, and a queue-changed notification. | Schema evidence, not observed enqueue or execution behavior. |
| Codex existing daemon | Daemon version query reports a running 0.157.1 server at `C:/Users/Kevin/.codex/app-server-control/app-server-control.sock`. | Current runtime metadata. |
| Codex external connection | WebSocket upgrade over the existing Unix-domain control socket succeeded; `initialize` and `thread/loaded/list` succeeded and returned one loaded thread. | Live read-only connection verified. No new server or thread was created. |
| Codex idle/busy queue behavior | Claude reports CLI enqueueing woke an idle TUI and ran busy-session input as its own subsequent turn without explicit queue-start or hooks. | Reported live tests on CLI 0.157.1; not independently rerun in this review. |
| Codex inactive-thread behavior | Claude reports input remained pending until the saved thread was resumed in a TUI. | Demonstrates backlog retention in that experiment, not universal TUI-only execution or crash-proof delivery. |
| Codex latency | Claude reports approximately 2.5–8 seconds for idle wake. | Small reported sample, not a guaranteed bound or reliability acceptance result. |

The initial raw JSON-over-proxy probe timed out. Official documentation identifies the Unix socket transport as WebSocket over an HTTP Upgrade handshake; using that transport succeeded. Do not assume that a raw-byte proxy converts newline-delimited JSON into WebSocket messages.

The existing Claude bridge explicitly notes that MCP alone cannot start inference in an idle client. It offers a long-poll tool and a generic wake command; its example `codex exec resume --last` recipe is explicitly unverified. For this room, bind a peer to an exact Codex thread and CLI context instead of resuming whichever session happens to be last. Discover the actual execution endpoint separately if observation or steering requires it.

### Revised recommendation

Build a room broker with two native delivery adapters: Claude's peer protocol and Codex's CLI queue command. Keep MCP for agent-facing room tools and use native harness delivery to trigger work. Maintain a durable room-level delivery ledger for routing and recovery, while letting each qualified native queue own execution ordering after handoff. Avoid competing hook delivery and explicit queue-start calls in the normal Codex path.

Codex CLI idle/busy/resume feasibility is now supported by Claude's reported experiments. Remaining qualification focuses on ordering, duplicate handling, completion races, approval waits, disconnection/recovery, observable receipt and completion, and desktop-client coverage. The report's removed scratch sessions and narrative results should be supplemented with retained commands and timestamped evidence during qualification. The room should advertise only the client configurations and delivery/control capabilities that pass those checks.
