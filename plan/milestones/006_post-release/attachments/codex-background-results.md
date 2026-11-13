# Codex background-hosting checks — bounded results

Date: 2026-09-28. Codex CLI and shared daemon **0.157.1**, Node **24.18.0**, native Windows. Research for the parked background-agent idea, **not a change to the proposal**. Kevin stopped further investigation after these checks; no additional experiments are planned here.

Labels: **VERIFIED** = observed in this run; **DOCUMENTED** = official interface documentation; **INFERRED** = interpretation, not a demonstrated guarantee.

## Summary

| Check | Result |
| --- | --- |
| C1: Daemon-hosted thread, no TUI, idle queue | **VERIFIED:** `codex queue` automatically started a turn. About 196 ms from CLI invocation to `turn/started`, 4.922 s to completion in this sample. No explicit queue/start. |
| C1: Busy queue | **VERIFIED:** second message ran as a separate turn, starting 14 ms after the first completed. |
| C1: No attached probe client | **VERIFIED, bounded:** after unsubscribe/disconnect, queue input still ran on the loaded daemon thread; confirmed completed when reconnecting 15 s later. This was within the unload grace period. |
| C1: Adopt a saved thread | **VERIFIED:** `thread/resume` loaded a saved, no-longer-owned thread onto the daemon; subsequent queue input ran automatically. |
| C2: Serialized exec fallback | **VERIFIED:** `codex exec resume <id> <prompt>` completed and preserved the ID when no other writer owned the thread. |
| C2: Competing owner | **VERIFIED:** exec resume exited 1 with an active-writer conflict for both a daemon-owned thread and a thread held by an actual throwaway TUI. |
| C3: Interrupt | **VERIFIED:** `turn/interrupt` ended a running sleep turn with `status: interrupted` in 226 ms after the interrupt request. Same thread accepted a subsequent turn. |
| C4: Approval without TUI | **VERIFIED:** server-to-client JSON-RPC approval request reached both subscribed clients. Withheld approval stalled execution. Disconnect/reconnect preserved and replayed the request. |
| C5: Transcript observation | **VERIFIED:** rollout JSONL grew, including assistant messages, tool calls/results, token counts, and interruption records, despite `historyMode: paginated`. |

These are small feasibility samples, not latency guarantees or reliability acceptance tests.

## Method and retained evidence

- Used the existing daemon at `C:\Users\Kevin\.codex\app-server-control\app-server-control.sock`; did not restart it, change its configuration, or enable remote control.
- Created only throwaway threads in `X:\Development\vibe-pairing\.roundtable\probes\codex-background-20260928`.
- Runner: `probes/codex-background-check.mjs`. It restricts thread RPCs to IDs in its own manifest.
- Local evidence retained under that ignored scratch directory: `manifest.json`, `events.jsonl`, and copies of the three materialized probe rollouts. Events include timestamps, exact request/response frames, CLI arguments, exit codes and output. These diagnostic artifacts are local, not committed.
- Thread starts used the inherited `gpt-6-astra` model with low reasoning effort, read-only sandbox, and bounded prompts. Normal tests used approval policy `never`; approval tests explicitly used `untrusted` with reviewer `user`. No approval was granted, and neither approval-marker file was created.
- No messages, interrupts, resumes, or deletion requests targeted Kevin's or Astra's existing threads.

PowerShell phase commands (run sequentially; the TUI fixture between standalone and conflict is described below):

```powershell
$node = 'C:\Users\Kevin\AppData\Local\mise\installs\node\24.18.0\node.exe'
$runner = 'probes/codex-background-check.mjs'
$scratch = '.roundtable/probes/codex-background-20260928'
& $node $runner $scratch idle
& $node $runner $scratch busy-stop
& $node $runner $scratch disconnected
& $node $runner $scratch approval
& $node $runner $scratch exec-conflict
& $node $runner $scratch exec-standalone
# Open the throwaway standalone thread in a TUI, then:
& $node $runner $scratch exec-tui-conflict
# Close only that TUI, then:
& $node $runner $scratch approval-no-client
& $node $runner $scratch adopt
& $node $runner $scratch cleanup
```

The runner is a research fixture, not a production transport. In particular, it uses a small WebSocket implementation and retains raw probe diagnostics locally.

## C1 — Hosting and queue behavior

**VERIFIED:** connect a client to the existing daemon, initialize, then call `thread/start` to create a hosted thread or `thread/resume` to adopt an existing unowned one. No agent TUI is necessary. A lightweight room client could own this connection.

The probe connected using `codex app-server proxy --sock <socket>` as a raw-byte tunnel and performed the WebSocket HTTP Upgrade/framing itself. Sending bare JSONL to the proxy is not equivalent. Initial direct Node `net.connect` against the Windows Unix-socket file failed with EACCES; the native proxy with WebSocket framing succeeded.

Idle command:

```text
codex queue --thread 01a0e668-5209-7592-b143-2e4a3404a924 --message "Reply with exactly BG-IDLE-PONG. Do not use tools."
```

- Invocation-to-CLI-return: 163 ms.
- `turn/started`: about 196 ms after invocation (33 ms after the CLI returned).
- Completion: 4.922 s after invocation, with `BG-IDLE-PONG`.
- Queue list was empty afterward. No queue/start or turn/start was used for this queued message.

Busy test started a turn executing `Start-Sleep -Seconds 12; Write-Output BG-SLEEP-DONE`, waited for its command-start event, then queued `BG-BUSY-SECOND`. First turn completed with `BG-BUSY-FIRST`; the second turn began 14 ms later and completed with its own requested marker. **VERIFIED:** queue input was not mid-turn steering in this test.

After unsubscribing and disconnecting the probe client, a new queued marker completed while no probe client remained attached. Reconnection after 15 s found the completed turn and an empty queue. The saved exec thread was also adopted by `thread/resume`, retaining its ID; its queued `BG-ADOPTED-PONG` reply completed without a TUI.

**DOCUMENTED:** after the last subscriber disappears, a loaded thread has a 30-minute no-subscriber/no-activity grace period before unloading. **NOT TESTED:** consumption after expiry, daemon restart, automatic reload of a completely unloaded thread, or long-term hosting reliability. Keep a room-service subscription if designing around this behavior; do not assume the grace period is permanent hosting. [App Server thread lifecycle](https://learn.chatgpt.com/docs/app-server)

## C2 — Exec fallback and competing ownership

Created a separate seed with:

```text
codex exec --ignore-user-config --skip-git-repo-check --json -m gpt-6-astra -c model_reasoning_effort="low" "Reply exactly BG-EXEC-SEED. Do not use tools."
codex exec resume --ignore-user-config --skip-git-repo-check --json <seed-id> "Reply exactly BG-EXEC-RESUMED. Do not use tools."
```

Both exited 0 and reported thread `01a0e66b-df40-7a00-a138-9ca70f811659`. The resumed response was `BG-EXEC-RESUMED.` (including a period). **VERIFIED:** sequential exec resumption preserves identity and produces a response; this is not a resident background host.

The same command against the still-daemon-owned queue thread exited 1:

```text
thread-store conflict: thread <id> already has an active writer
Error: thread/resume: thread/resume failed ... (code -32600)
```

For the actual TUI case, unified exec's PTY creation failed with an OS error, so a dedicated hidden WezTerm process launched:

```text
codex --no-daemon --no-alt-screen resume 01a0e66b-df40-7a00-a138-9ca70f811659
```

Confirmed Codex PID 50520 under the probe terminal PID 74320. Exec resume against that same thread again failed with the active-writer conflict. Closed only those verified probe processes afterward. **INFERRED:** a room must establish/release ownership before using serialized exec as fallback; it cannot safely treat an existing interactive or daemon-owned thread as freely resumable.

## C3 — Interrupt and resumability

Started a turn executing `Start-Sleep -Seconds 45; Write-Output BG-SHOULD-NOT-FINISH`. Two seconds after its command-start event, sent:

```json
{"method":"turn/interrupt","params":{"threadId":"<probe-id>","turnId":"<running-turn-id>"}}
```

**VERIFIED:** the turn completed as `interrupted` 226 ms after the request. Rollout records include:

- Tool result: `aborted by user after 2.9s`.
- `event_msg` with `type: turn_aborted`, matching turn ID, `reason: interrupted`.
- Subsequent turn on the same resumed thread completed with `BG-AFTER-INTERRUPT`.

This demonstrates cancellation of the active model/tool turn, not daemon shutdown. The experiment did not establish a universal guarantee that every possible detached grandchild process is killed or external side effects are rolled back.

## C4 — Approval routing and absence of answers

Two clients subscribed to one probe thread (the second via `thread/resume`). Requested a harmless `Set-Content` under a read-only policy requiring user approval.

**VERIFIED:** both received `item/commandExecution/requestApproval`, same request ID 17 and matching thread/turn/item IDs. Its decisions included `accept`, a policy-amendment option, and `cancel`. The probe did not accept or persist an amendment.

- After 10 s without an answer: `activeFlags: [waitingOnApproval]`; no marker file, no completed turn.
- After disconnecting the initiating client and waiting 5 s: still waiting; the other subscribed client could interrupt it.
- A second approval request (ID 18) was left pending with **all probe clients disconnected** for 10 s. Read-only inspection after reconnect still showed waiting and no marker.
- `thread/resume` on the new connection replayed that pending request with ID 18. Replying `{"id":18,"result":{"decision":"cancel"}}` ended the turn as interrupted.

**INFERRED:** the room could render and answer these server requests without an agent TUI. Multiple connected clients need coordination to avoid racing approval decisions. **NOT TESTED:** accept path, conflicting simultaneous decisions, every approval type, long-term timeout, or crash/restart during approval. The no-answer result is bounded to these observation windows, not a promise of infinite waiting. [Documented approval protocol](https://learn.chatgpt.com/docs/app-server)

## C5 — Observation

**VERIFIED:** the daemon returned a rollout path under `~/.codex/sessions/2026/09/28/`. The queue probe's JSONL was observed at 98,743 bytes during testing and 112,234 bytes before cleanup. It contained two `response_item/custom_tool_call` records, two corresponding outputs, assistant/user message records, `event_msg/item_completed`, task start/completion, token counts, and the interruption record. The completed sleep tool output included `BG-SLEEP-DONE`.

These threads reported `historyMode: paginated`; nevertheless their rollout files existed and grew in this installation. `thread/turns/list` with `itemsView: full` also returned the completed no-client turn and its input/output. A version-specific observer can use either verified source; do not generalize this exact on-disk format to every version or assume tool output is flushed continuously while a tool is running.

One early setup attempt subscribed a second client before a brand-new thread had materialized its first rollout and got `invalid paginated history lineage ... missing source rollout`. Completing a no-tools warmup turn before the second subscription avoided that issue. No further investigation was done.

## Cleanup and limits

All four probe threads were deleted successfully through `thread/delete`, restricted to the manifest IDs:

- `01a0e668-5209-7592-b143-2e4a3404a924` — daemon queue/interrupt.
- `01a0e66a-8885-7431-9343-ad9faaecfa10` — unused early approval setup.
- `01a0e66a-ba9e-7a52-afb6-adcff3141531` — approval checks.
- `01a0e66b-df40-7a00-a138-9ca70f811659` — standalone exec, TUI conflict, daemon adoption.

The temporary TUI and terminal were stopped. All probe clients/proxies closed. The shared daemon was left running. Local evidence copies remain in the ignored scratch folder. No project proposal changes, user configuration changes, or actions on existing user threads were made by these checks.

Conclusion: **background daemon hosting is feasible in this tested build**, including native queue consumption, observable turns and approvals, cancellation, and resumption. The parked idea remains parked; this report does not change MVP scope.
