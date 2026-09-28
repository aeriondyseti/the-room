# vibe-pairing — unified proposal

Status: reconciled proposal by Astra and Claude, incorporating Kevin's scope decisions. Claude's final review is recorded in [claude-reconciliation.md](claude-reconciliation.md); its remaining enrollment condition is incorporated here. Proposal only; implementation has not started. This is the single current proposal; the two original proposals remain historical references.

## Product and confirmed scope

Build a local room where Kevin and multiple Claude Code and Codex sessions coordinate work in the same repository. The defining requirement is that addressed messages reach the harness and cause processing without an agent remembering to poll or re-arm a listener.

Kevin has selected these first-version requirements:

- Run a TUI in a separate terminal pane alongside the existing agent panes.
- Ordinary human input broadcasts to all enrolled agents; `@name` targets one. Send once rather than repeat the same instruction in both harnesses.
- Show shared room messages in the MVP TUI. Kevin explicitly deferred full harness output, including tools, until after MVP.
- Connect to already-running sessions first. Launching or replacing sessions is not required.
- Claude Code and Codex are required. agy is optional and cannot delay either required harness.
- More than two agents and multiple simultaneous instances of the same harness are required in MVP. A room may contain, for example, two Codex sessions and two Claude Code sessions; it must not assume a single participant per harness or a fixed pair.
- A thin local stdio MCP front-end is included in MVP and is the preferred agent interface when configured; CLI access remains the baseline/fallback. Kevin accepts resuming existing sessions to load the MCP server. Existing-session support does not require seamless hot installation.

Initial platform: native Windows, matching the installations and transports investigated. Support multiple participants per harness, with Astra and Claude as the first end-to-end fixture. No driver/navigator roles, turn grants, automatic task assignment, or repo-wide edit locks.

Kevin confirmed reliable queueing while busy is sufficient for version one; active-turn steering comes later. Claude's [reconciliation review](claude-reconciliation.md) also records Kevin's choices of one room per repository shared by worktrees, an Ink TUI, participant status and delivery details, and token/context usage. Kevin directed Astra to Claude's pause decision: **hold new deliveries and send a stop request to all agents**, without enforcement hooks. Runtime metrics must be labeled unavailable when they cannot be established.

## User experience

Start `room tui` in a third pane. Each existing agent self-registers with `room join --as <name>`, guided by a small Claude `/room` skill or a Codex skill/AGENTS.md instruction. The command detects its harness and native session ID and adds or updates only those two fields in its own section of repository-root `session.toml`. This file is the minimal human-readable participant registry, read by the service on startup and after validated changes. No credentials belong in it.

Registration writes use a lock and atomic replacement, preserving every other participant's section. Reject duplicate names or conflicting active bindings instead of clobbering them. If auto-detection is unavailable, the skill can guide an agent to append its verified harness and session ID manually. Keep this machine-specific file git-ignored in the implementation. Worktrees share the canonical repository's registry. Revalidate sessions and resolve Claude's changing pipe/key information at send time; a stored session ID is not proof of liveness.

Registry sections are keyed by unique participant name, not harness type. Each section contains exactly `harness` (`codex` or `claude` for MVP) and `session_id` (Codex thread UUID or Claude native session ID):

```toml
[participants.astra]
harness = "codex"
session_id = "01a0e605-2485-7693-a111-97e35d22a97e"

[participants.claude]
harness = "claude"
session_id = "67b7bc1e-0c3e-4ffa-9d51-a88eb52d61d8"
```

The CLI derives everything else: Claude PID/process start, pipe and key location from the live registry by session ID; Codex executable from PATH or room-level configuration; repository cwd from the canonical room root; frames, limits and send recipes from adapter code. Timestamps, resolved connection snapshots, liveness, delivery state, usage and observation cursors belong in SQLite, never in `session.toml`. Do not add optional participant fields speculatively; a non-default Codex home override, for example, requires a demonstrated need and an explicit schema decision.

The current hand-written `session.toml`, including its protocol/send recipes and harness-specific tables, is migration input only. Preserve both participant identities when migrating and remove derivable metadata from the new registry. Two names must not accidentally enroll the same native session twice and duplicate broadcasts.

Bind Claude by exact session ID, validating its current PID and process start identity; display names are labels and may be duplicated. Bind Codex by exact thread UUID, resolving installation/home context from the runtime environment or room-level configuration. Capture that resolved context with delivery attempts, not as duplicated participant configuration. A process or pipe changing while the same session resumes can be revalidated without treating a reused PID or matching display name as identity proof.

The room skill/instructions tell agents to rerun `room join --as <same name>` after a clear, new conversation, fork, or resume that changes their native identity. Detect a confirmed invalid or changed binding at send time, show `rebind needed`, and hold unsent deliveries against their original session snapshots. An unavailable process or a thread absent from one daemon's loaded list alone is not proof of identity rotation: distinguish offline, unknown, and confirmed stale bindings. Rejoining enables new messages for the new binding; old pending work is not redirected automatically. An explicit readdress/resend action creates a linked new delivery and retains the original outcome. Submitted or uncertain attempts still require reconciliation before any resend.

The TUI includes:

- A participant strip with names, harnesses, session connection, observed activity, and pending deliveries. Unknown or stale status is shown explicitly.
- Participant and recipient lists scroll or collapse as the room grows; layout and addressing must work beyond two agents. `@name` always resolves a participant, not every instance of its harness.
- A chronological room conversation with sender, recipients, replies, and per-recipient delivery evidence.
- A compact participant panel with reported token/context usage, its measurement time, and unavailable/stale markers where needed. Full transcript and tool-output views are post-MVP.
- A composer with a persistent, conspicuous `To: all` or selected-recipient indicator. Enter sends; a multiline mode supports longer directions. Escape cancels composition without interrupting an agent.
- Scrollback that does not jump when new output arrives, a new-events count, and an explicit follow-live action. A narrow pane switches views rather than squeezing all columns together.

Example layout (illustrative, not a fixed rendering contract):

```text
vibe-pairing    Astra / Codex: working    Claude: idle
[Conversation] [Deliveries]    Astra ctx: 41%    Claude ctx: unavailable

Kevin -> all     Reconcile the persistence approach.
  Astra: queued     Claude: processing
Claude -> Astra  A read cursor alone cannot prove inference.
Astra -> Claude  Agreed; let's record delivery attempts separately.

To: all > _
```

Default broadcast applies to human input. Agent sends require explicit recipients (`@name`, `@all`, or the human) so progress reports do not wake the entire room. Every room message is visible to Kevin regardless of destination. A broadcast snapshots the enrolled recipient set at send time and creates independent deliveries; an offline participant does not block the others.

Human broadcast reaches all enrolled agents, including every instance of the same harness. Agent `@all` reaches all other enrolled agents and does not wake the sender itself. Point-to-point messaging works equally within one harness and across harnesses. Adding or removing participants must not rewrite the recipient set or target-session snapshots of previously accepted messages.

The Claude room skill and Codex instructions direct agents to reply to the specific sender, linking `reply_to`, and reserve `@all` for information or requests relevant to the whole room. Linking a reply does not implicitly broadcast it. The composer and send result show the resolved recipient count; in a four-agent room an agent broadcast can schedule three recipients. This complements the visible rate indicator without silently throttling exchanges.

## Room messages versus observed state

These are different event types with different effects:

| Event | Visible in TUI | Schedules an agent |
| --- | --- | --- |
| Human room message | Conversation | Every explicit recipient; all by default |
| Agent room message | Conversation | Only explicit agent recipients |
| Observed activity, usage, receipt, or approval state | Participant/delivery details where available | Never by observation alone |
| Native assistant text and tool output | Original harness panes in MVP; optional activity view later | Never by observation alone |
| Delivery receipt or reconnect event | Delivery detail and status | Only the scheduler's explicitly recorded recovery action |

Agents communicate through the `room_send` MCP tool when configured, or `room send` as the fallback, so agent-to-agent messages enter the room before transport. Existing sessions receive concise enrollment instructions for publishing replies with `reply_to`. MCP and CLI use the same service operations and delivery ledger. A session can be resumed to load MCP, or use the CLI without changing its MCP configuration.

For CLI calls, resolve the calling Codex session through `CODEX_THREAD_ID`; for Claude, qualify ancestor-process lookup against its live session registry. `room send --as <name>` verifies detected identity against that participant's `session.toml` entry and refuses a clear mismatch. If detection is unavailable, accept the explicitly declared registered name in this local, trusted room, marking its identity as declared rather than verified. MCP caller identity uses the separate per-harness rules below. Never silently post an unbound agent message as the human. These checks provide local routing evidence, not isolation from malicious processes running as the same OS user.

Agents must publish conversational replies through `room_send` or `room send` for them to appear in the MVP room view; native-only replies remain in the original harness pane. Enrollment instructions make this explicit. This requirement governs where replies are published, not whether a message wakes the agent: waking is harness-driven. Associate observed copies of room input with its original ID for delivery evidence, without adding duplicate conversation rows. Never automatically turn tool output or assistant commentary into broadcast messages.

## MCP front-end and caller identity

The MCP process is a thin client of the room service. It has no independent message store, delivery queue, listener-rearming requirement, or native wake logic. Structured arguments remove sender-shell quoting hazards; the downstream native adapters still enforce their own payload limits and access requirements. Use the official MCP SDK for the product front-end; the dependency-free experimental probes are not a requirement to hand-roll the production protocol. Keep the room service itself minimal.

| MCP tool | Contract |
| --- | --- |
| `room_send({to, text, reply_to?, client_message_id?})` | Resolve caller, validate explicit recipients, persist once, and return room message ID and per-recipient state promptly; never wait for inference to finish |
| `room_read({message_id?, cursor?, limit?})` | Read room messages with bounded output and pagination; support fetching referenced oversized content |
| `room_who({})` | List participant identities and runtime state with evidence/freshness labels |
| `room_join({name})` | Derive native caller identity and reuse the CLI registration operation; write only harness/session ID to that participant's registry section |

Sending and joining are write operations; read/who are read-only. Tool availability and approvals are configured explicitly for the room server; do not claim that MCP bypasses harness approval policy or sandbox restrictions. Human pause/admin actions are not included in the agent tool surface. A write requires resolved identity; registration may establish a new entry, while other calls require an existing binding.

### Codex MCP identity

For the tested Codex 0.157.1 host, read `params._meta.threadId` fresh on every tool call and resolve that native UUID against `session.toml`. Cross-check supplied `sessionId` and nested `x-codex-turn-metadata` thread/session fields; inconsistent native identity fields are an error. Environment `CODEX_THREAD_ID` and `CODEX_SESSION_ID` were absent in the tested MCP children even though shell commands exposed the thread ID.

Two concurrent threads under the same host supplied their own correct per-call IDs and used separate MCP processes. Resuming one thread preserved its native ID while replacing the MCP process. Therefore neither MCP PID nor an environment snapshot is the caller identity. Do not infer identity from cwd, clientInfo, JSON-RPC request ID, or a process-global participant selected by an earlier call. This is observed version-specific behavior, not a portable MCP guarantee; missing metadata produces an explicit unavailable-identity result and CLI fallback, not guessed attribution.

### Claude Code MCP identity

On every call, read the live Claude registry entry for the MCP server's direct parent PID, validating PID/process-start identity. If needed, walk verified ancestors to locate a unique owning Claude process. Resolve its current `sessionId` against `session.toml`; never choose by display name. Cross-check `CLAUDE_CODE_SESSION_ID` from the MCP environment. Claude's tested per-call metadata contained tool-use/progress identifiers but no native session ID.

A uniquely validated fresh registry identity is primary. If the environment disagrees, flag the mismatch and use the registry identity only when it resolves unambiguously to the registered participant; never fall back to the stale environment's participant or silently rewrite a binding. Missing/ambiguous registry evidence, conflicting live identities, or an unregistered identity rejects sending and requests registration/rebinding as appropriate. The same resolution may be used by `room_join` to explicitly establish the new binding. Do not infer a native session from MCP PID, cwd, clientInfo, or model-supplied identity.

Claude's reported 2.1.283 headless probes found direct-parent registry identity and `CLAUDE_CODE_SESSION_ID` agreeing in two concurrent sessions and after `--resume`, with the native ID preserved despite new processes. The interactive/background launch paths and identity changes while an MCP process remains alive still require qualification. `CLAUDE_CODE_MESSAGING_TOKEN` may be inherited but must never be logged or returned by room tools; caller identification does not require that token.

### Installation, retries, and compatibility

Provide a narrow MCP setup recipe and keep the existing CLI usable if tools are unavailable. Resume the exact native conversation when installing; verify that its registry binding still matches afterward. Do not switch to a fork or new thread implicitly. No MCP installation detail, process metadata, or credentials are added to the minimal `session.toml` schema.

MCP and CLI accept the same optional `client_message_id`. Scope deduplication by room and resolved sender identity, return the original result for an identical retry, and reject reuse with a different payload. Preserve that key across a timeout and fallback to CLI rather than posting twice. This room-level guarantee does not make ambiguous native delivery safe to resend.

## Architecture and persistence

Use one local room service for persistence, delivery, and observation, with lightweight TUI, CLI, and MCP clients. This service is a dispatcher, not an agent supervisor or turn-grant system. It stays alive independently of a TUI view or MCP process; closing either does not cancel agent work. Multiple readers may attach to one room, but there is only one writer/dispatcher owner.

Any client may start the service when absent, detached and without opening a window, under the single-owner startup lock. It waits for readiness before sending. Failure to start produces an explicit error; a message is not reported accepted until the service commits it. An explicit service-shutdown command is separate from closing the TUI or pausing the room.

Implementation baseline: TypeScript on a pinned Node runtime with built-in `node:sqlite`, and Ink for the TUI. Confirm runtime support and Windows terminal behavior before implementation. Keep the service on built-in facilities where practical; TUI dependencies do not become a zero-dependency constraint on the whole project.

SQLite stores the room sequence, messages, resolved recipients, per-recipient deliveries and attempts, participant runtime state, and observation cursors. `session.toml` is authoritative for participant registration; database copies are runtime snapshots, not a second independently editable registry. Commit the message and all initial deliveries in one transaction before showing it as accepted. Snapshot the exact enrolled session for each delivery; changing a registration must not silently redirect already-queued work to a new conversation. MVP observers retain only needed metric values and delivery correlations, not copies of full harness transcripts or tool output. Keep runtime data under an ignored `.room/` directory. JSONL is an export format, not a competing source of truth.

Start with `messages`, `deliveries`, `participants`, and `usage_cursors`. Delivery rows retain an attempt number, native ID where available, current state, error, timestamps, and prior attempt evidence; retrying must not erase the outcome being reconciled. No generalized workflow or transcript archive schema is needed for MVP.

Use a local named-pipe IPC interface for the TUI, CLI, and MCP front-end. Single-owner locking prevents two dispatchers from submitting the same delivery. One room belongs to a repository; registered worktrees map to the same canonical room using Git common-directory resolution, with an explicit override for ambiguous layouts. Validate a linked-worktree fixture instead of assuming that taking the parent directory always yields the intended room.

Proposed commands:

| Command | Purpose |
| --- | --- |
| `room tui` | Open the human conversation/activity interface and connect to the room service |
| `room join --as <name>` | Detect harness/session ID and write only those fields under the caller's participant name in repository-root `session.toml` |
| `room send` | Publish an addressed room message; accept text from stdin or a file as well as arguments |
| `room read`, `room who` | Inspect room history and registered participants |
| `room doctor` | Check versions, target reachability, observation coverage, and integration readiness |
| `room pause`, `room resume` | Hold future delivery and send a human stop request, or release held work in order |

These command names are design proposals, not existing functionality.

## Native delivery adapters

### Codex

Use `codex queue --thread <full UUID> --message <envelope>` with a process argument array. Read the exact thread identity from the minimal participant entry; resolve the executable through PATH or a room-level override and determine home/configuration context and client capabilities at runtime. Record diagnostic snapshots in SQLite. Do not use `--last` or rely on display names.

Claude's reported tests on CLI 0.157.1 found idle TUI wake, a separate next turn when busy, and retention until resumption for an inactive saved thread. Queueing does not establish that a session is running, that a particular observation endpoint owns it, or that the message has been processed.

No explicit `thread/queue/start`, Stop-hook continuation, or PostToolUse reinjection belongs in the normal path. Direct App Server RPCs may later replace the CLI after equivalent behavior and reconciliation are qualified. A daemon accepting queue input may differ from the server executing the turn; determine observation/control separately. Do not write Codex's SQLite databases.

### Claude Code

Resolve the exact registered session at send time, validate process identity, read the corresponding local authentication material, and write the auth frame followed by a native user-message frame to its messaging pipe. Use `priority: next` for normal messages and retain a stable delivery message ID. Authentication material is never copied into the room transcript or shared configuration.

Borrow and test the known registry/protocol behavior from `claude-message-mcp`, keeping version-sensitive details in one adapter. The reported 2.1.283 experiments and Astra/Claude introduction demonstrate current feasibility. Respect held/refused inbound messages and the receiver's permission policy. Native pipe completion is transport evidence only.

Replies normally go through `room_send` or `room send`, so first-version delivery need not publish a synthetic Claude peer for every external agent. Native-peer discovery integration can be added later if it materially improves use.

### Message envelope

For the first version, send the addressed room content in a bounded envelope containing room ID, message ID, sender, recipients, reply reference, and body. Attribute peer instructions as peer messages, not human approvals. Normal-sized messages carry their complete body.

Qualify a conservative Codex envelope budget (initial candidate: 24,000 characters) against the actual Windows command-line length after serialization and quoting, including the executable and options. Qualify Claude's separate pipe limit. For oversized content, retain the complete original and send a bounded preview plus an explicit `room read <message-id>` reference, labeling that delivery as referenced content in the TUI. Reserve space for the identifiers and fetch instruction; never silently truncate or split one directive into unrelated turns. Fetching is only the oversize fallback, not the normal wake mechanism, and needs its own acceptance test.

Prefer this full-message path over a bare doorbell that requires a model to call `room read` before seeing the task. Both durable storage and native scheduling are deterministic; model-authored replies remain normal agent behavior. Coalescing batches can come later once ordered delivery is proven.

## Delivery states, recovery, and control

The MVP lifecycle is `queued -> submitted -> replied`, with `failed` and `uncertain` outcomes and independent held status. `queued` means committed to the room; `submitted` means the adapter completed its send operation, with its evidence kind recorded. Codex's successful queue command and native ID establish native queue acceptance; Claude's successful pipe write establishes transport submission only. Neither is processing evidence.

`replied` requires an attributed room reply from that recipient linked by `reply_to`, and is not proof that the coding task succeeded. An observer may add receipt/processing/turn-completion evidence when correlated events actually support it, but those states are not required to invent a full lifecycle in MVP. A read cursor, process exit, or empty queue alone does not prove receipt or processing.

Each delivery has one owner and one normal transport. Do not enqueue content and also inject it through hooks. Room-level idempotency prevents duplicate client submissions, but does not establish native retry safety. A crash between submission and acknowledgment produces an uncertain attempt; reconcile before retrying, and expose manual retry when evidence is insufficient.

Submit to busy agents through their qualified native queue rather than suppressing submission based on a possibly stale busy flag. Preserve per-recipient ordering; an unavailable recipient cannot stall delivery to another. Avoid silent resends after long tasks or approval waits. On reconnect, recover pending room work and observation cursors without replaying accepted messages blindly.

The TUI's `/pause` atomically holds future ordinary room delivery and creates one human stop-request message to all enrolled agents. That recorded control message is exempt from the hold it creates and uses each normal native transport; the UI shows its per-recipient send state. Repeating pause while already paused does not send another stop request unless explicitly requested. Agents may still publish replies into the room while deliveries are held.

This is a cooperative stop request, not forced interruption: a busy Codex session may see it only after the active turn, and already-submitted messages may execute ahead of it. Pause does not recall native queue items or halt current tools. `/resume` releases remaining held deliveries in per-recipient order; it cannot retract a stop request already submitted. Do not claim the agent has stopped without evidence. No PreToolUse enforcement hooks in MVP. Approval decisions stay in the original harness pane; show a pending approval if observable.

A visible rate indicator may warn about sustained agent-to-agent exchanges so Kevin can pause. Do not silently throttle, drop, or rewrite conversation based on a heuristic.

## Minimal observation now; full output after MVP

MVP needs a small read-only observer for token/context usage and whatever delivery/activity evidence is available. It is independent of each sender adapter. Prefer an available event stream from the actual session host; otherwise use a verified transcript/history reader for the installed version. Claude's reconciliation identifies local Claude JSONL usage records and Codex token-count events as sources to qualify. Do not assume every Codex session exposes a plain append-only JSONL file or that the queue daemon can stream its turns.

Label usage carefully: cumulative tokens are not current context occupancy. Show source-backed categories and freshness, derive a percentage only with a known context limit and compatible occupancy measure, and do not infer usage from transcript file size. Retain relevant metric snapshots and correlation IDs. An unavailable observer must not block message delivery or masquerade as zero usage.

Preserve source event IDs and restartable cursors for the records actually read. Handle partial trailing records, reconnect replay, file replacement/rotation, compaction, and paginated history where applicable. A tagged input appearing in a transcript proves receipt; progression to processing/completion requires correlated execution evidence rather than the tag alone.

The next milestone after MVP can add full activity/transcript views, with expandable complete tool inputs/results, filtering, chunk assembly, and scrollback that remains responsive under large outputs. Qualify actual exposed coverage before promising it; never manufacture hidden/internal output. Avoid persisting a second copy of every tool output by default. Observation is never a feedback path into delivery.

## Evidence and remaining probes

Evidence: [Claude messaging findings](findings-claude-messaging.md), [Codex messaging findings](findings-codex-messaging.md), the initial [Codex investigation](codex-proposal.md), and the live Astra/Claude introduction in this project. The introduction and acknowledgment establish one actual two-way exchange between these participants. They do not establish repeated reliability or full output capture.

MCP identity evidence: Astra directly observed correct Codex per-call metadata in thread `01a0e605-2485-7693-a111-97e35d22a97e`; Kevin relayed matching tool/shell results from thread `01a0e657-f65e-7ce1-892c-c1fad1b41efd` before and after resume. MCP environment IDs were absent in all three observations. Claude's headless concurrent/resume results were inspected with `git show 7be2154:probes/claude-identity-results.md` on branch `claude/mcp-identity-probe`; those probe artifacts were not merged as part of this proposal edit. Claude's tools were pre-allowed, so these results do not establish approval-prompt UX.

Before declaring either adapter supported, qualify:

1. Existing-session registration, caller identity, and native delivery, plus read-only usage/status sources and message correlation. Full tool-output capture is not an MVP gate.
2. Idle/busy delivery, multiple ordered messages, duplicate submissions, simultaneous sends, and insertion at the completion boundary.
3. Receiver approval waits, refusal/hold, closed sessions, service restart, and ambiguous submission recovery.
4. A single human broadcast reaching every enrolled agent independently, followed by visible agent-to-agent and agent-to-human responses. Required fixture: four simultaneous agents, two Codex and two Claude Code sessions. Verify all four receive the broadcast, `@name` reaches only the selected instance, same-harness and cross-harness replies work, and one offline/busy instance does not block the others. Add/remove a participant while the room remains running and verify stable routing and scrollable TUI state. Four is an acceptance fixture, not a product limit.
5. Pause with a stop-request exemption, repeated pause, resume ordering, oversized-message references, concurrent service startup, linked-worktree room identity, and responsive TUI rendering. Test desktop clients separately from CLI/TUI configurations; steering remains deferred.
6. Identity rotation and rebind: exercise clear/new/fork/resume, changing pipes/PIDs, duplicate Claude display names, and a Codex thread missing from an unrelated daemon's loaded list. Verify distinct offline/unknown/rebind-needed states, no cross-session misdelivery, preserved pending snapshots, and explicit readdressing. In the four-agent fixture, verify a targeted reply does not fan out and agent `@all` excludes its sender.
7. Minimal-registry migration and runtime resolution: preserve existing participant identities, ensure join writes only harness/session ID, derive fresh Claude connection details without rewriting the file, and resolve executable/cwd through their designated sources. Reject ambiguous or unsupported configuration rather than silently choosing another session.
8. MCP qualification: actual Claude background/TUI launches, live clear/compact and fork/new behavior, missing/conflicting caller signals, and approval allow/deny behavior under intended policies. Reuse the completed two-session/resume identity evidence for its tested configurations. Verify exact multiline/quote/Unicode input, long-message fallback, paging, lost-response retry across MCP/CLI, and service restart/reconnect without duplicate room posts. Include the MCP preferred path in the four-agent fixture and exercise CLI fallback.

Retain runnable probe commands, versions/configurations, message IDs, timestamps, event excerpts, and tagged responses. Repeat idle wake at least 20 times per supported configuration and run a two-hour mixed exercise. Measure enqueue, turn-start, observation, and response latency separately. The reported 2.5–8-second Codex sample is not a hard bound; choose and publish a latency target after repeatable measurements rather than asserting an unproven five- or ten-second guarantee.

## Delivery milestones

1. **Qualify attachment and remaining native-delivery behavior.** Start with these actual sessions, then qualify the four-agent fixture with two instances per harness. Confirm independent registration, receipt, room replies, usage where supported, and no identity collisions. Document unsupported cases.
2. **Room service, adapters, and agent access.** Durable message transactions, `session.toml` enrollment, native sends, delivery evidence/recovery, agent CLI and preferred MCP front-end, minimal usage readers, and the Claude `/room` skill plus Codex equivalent instructions. Include installation/resume instructions and per-call identity checks. Prove a two-way exchange through the room using MCP, with CLI fallback.
3. **Separate-pane MVP TUI.** Broadcast composer, targeted sends, room messages, participant/usage panel, scrollback, delivery details, pause/stop-request/resume, and reconnect replay.
4. **Acceptance and operational polish.** Failure probes, honest pause semantics, responsiveness under long conversations, repeated/two-hour exercises, and integration diagnostics.

Full harness/tool-output views are the next milestone after MVP. Launching agents, web UI, agy, broader plugin distribution, automatic file claims, steering, hard stop/remote approval controls, and alternative transport fallbacks are later extensions. The local agent MCP front-end is part of MVP. No fallback may silently restart sessions or weaken their permissions.

The first release is complete when Kevin can connect multiple existing agents, including multiple instances of each required harness, watch their room conversation in a separate pane, send one direction to all or target one instance, and see their room replies without manually waking them. Each participant's delivery and metric limitations remain visible. The initial Astra/Claude pair is a starting fixture, not the scope limit.

## Reconciliation record

- Adopt Claude's small-room model, broadcast human input, explicit participant identity, and native external wake rather than model polling.
- Adopt Astra's separate delivery evidence, uncertain-outcome recovery, exact session addressing, and independent observation/control qualification.
- Replace the web-first UI with the user-requested TUI; honor Kevin's later correction that MVP shows room messages only and full harness output follows it.
- Adopt a single local service with SQLite rather than competing JSONL/cursor and native-queue delivery ownership; Claude's review agrees.
- Prefer full native messages and one delivery path over doorbell-plus-hook reinjection for version one, with a visible reference fallback for oversized content.
- Incorporate Claude's concrete review of service startup, caller identity, envelope limits, minimal MVP receipt states, and Kevin's cooperative pause decision.
- Incorporate Kevin's self-registration decision: repository-root `session.toml` is authoritative, agents preserve each other's entries, and declared sender identity is allowed when automatic checks are unavailable.
- Incorporate the R11 minimal-registry requirement: only harness and native session ID per named participant; the CLI derives connection details and SQLite stores runtime state. The existing verbose file is migration input, not the target schema.
- Incorporate R12/R13 and Kevin's approval: preferred local MCP tools in MVP with CLI fallback, Codex per-call metadata identity, Claude fresh parent-registry identity with environment cross-check, and unchanged native wake paths. Tested identity/resume behavior is distinguished from remaining launch-path and approval probes.
- Claude's final review (R8) approved the design conditional on that enrollment edit. Astra incorporated it and reviewed the resulting document; this document is now the single implementation proposal. Both original proposals and findings remain historical input.
