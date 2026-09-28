# Findings: Claude Code inter-session messaging

Investigation date: 2026-09-27 · Claude Code 2.1.283 · Windows 11

**Question:** can an external process (a Node CLI, not a Claude session)
deliver a message into a specific, running Claude Code session so that it
**starts a turn when idle** and is **queued when busy**? This is the wake
requirement from [proposal-claude.md](proposal-claude.md).

**Answer: yes.** Write an auth line plus a `type:"user"` frame to the
session's `cc-msg` named pipe. Verified end-to-end on a throwaway session. It
is the same technique `X:\Development\claude-message-mcp` uses. The
messaging feature is documented, but the external-sender path depends on
**undocumented internals**.

Evidence labels: **VERIFIED** = observed in the experiment ·
**DOCUMENTED** = official docs · **INFERRED** = deduced, not confirmed.

## Summary

| Question | Result | Evidence |
|---|---|---|
| Idle session starts a turn on an injected message? | Yes | VERIFIED |
| Busy session? | Queued; handled between tool calls or after the current turn | VERIFIED (queued and processed after the turn); DOCUMENTED (between tool calls) |
| Flags or config needed on the receiver? | None, but see `crossSessionInbound` below | VERIFIED |
| Supported for external senders? | Only a script posting to its **own** session via `CLAUDE_CODE_MESSAGING_TOKEN`; reading another session's `.key` is internal | DOCUMENTED / VERIFIED |
| Supported push alternative? | Channels (research preview), which need a launch flag | DOCUMENTED |
| Stop hook can force continuation? | `{"decision":"block","reason":...}` or exit code 2 | DOCUMENTED |

## How it works

### Registry (VERIFIED)

Every session writes `C:\Users\Kevin\.claude\sessions\<pid>.json`,
containing:
- `sessionId`, `name`, `jobId`, `kind` (e.g. `"bg"`)
- `status` (`idle` / `busy`)
- `peerProtocol: 1`, `peerFeatures: ["notify_idle","artifact_yield"]`
- `messagingSocketPath`: `\\.\pipe\LOCAL\cc-msg-<32hex>`

Pipes named `cc-daemon-*-control/pty/rv-<jobId>` belong to the
background-session daemon, not to messaging.

### Auth key (VERIFIED, undocumented)

A sibling file,
`sessions\<pid>.<sha256(lowercased pipe path)>.key`, contains
`{"peerToken":"<32hex>","procStartFt":..,"pidDomain":..}`. On native
Windows the first line on the pipe must authenticate, or the connection is
closed (DOCUMENTED). A session also accepts a separate child token, which it
exports to its own hooks and Bash as `CLAUDE_CODE_MESSAGING_TOKEN`
(DOCUMENTED).

### Wire format (VERIFIED from the binary and a live test)

Newline-delimited JSON:

```json
{"type":"auth","token":"<peerToken>"}
{"type":"user","message":{"content":"text"},"from":"<label>","priority":"next","msg_id":"<uuid>"}
```

- `priority` is one of `now`, `next` or `later`.
- Optional fields:
  - `session_id` — a mismatch drops the message.
  - `from_mode` — affects the bypass-mode inbound filter.
  - `file_attachments`.
- Control frames also exist:
  `{"type":"control","action":"rename"|"notify_when_idle"|"peer_message_status"|...}`.
- The connection closes if no complete line arrives within 30 s
  (DOCUMENTED).

### Addressing

- The session name (`--name`, `/rename`, or auto-generated) or the job id
  resolves to a registry entry, which gives its pipe.
- `ListAgents` shows a short `[nnnnnn]` suffix to tell apart sessions with
  the same name (DOCUMENTED). Where the suffix comes from was not located.

## How it was tested

A subagent ran the experiment. It never messaged or modified any of the
user's existing sessions.

1. **Throwaway session:**
   `claude --bg --model haiku --name ext-inject-probe`.
2. **Injector:** a 20-line Node script (below) that:
   - finds the registry entry by name,
   - reads its `.key` file,
   - connects to the pipe and writes the two lines.
3. **Test A — idle session:** injected a PING-style message.
   - `status` went idle → busy → idle.
   - The transcript showed a queue enqueue, a dequeue, then a user turn
     beginning "Another Claude session sent a message: …" plus a
     no-escalation warning.
   - The origin was recorded as
     `{"kind":"peer","from":"external-node-cli"}`.
   - The model replied **PONG**.
4. **Test B — busy session:** injected a second message ("BETA") while a
   turn was running. It was enqueued and processed after the running turn.
5. **Cleanup:** the probe was stopped and removed with `claude stop` and
   `claude rm`.

### The injector used (`inject.mjs`)

```js
// Usage: node inject.mjs <sessionName|jobId> <text> [priority]
import fs from 'fs'; import path from 'path'; import os from 'os'; import net from 'net'; import crypto from 'crypto';
const [,, target, text, priority='next'] = process.argv;
const dir = path.join(os.homedir(), '.claude', 'sessions');
const regs = fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f)).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const reg = regs.find(r => r.name === target || r.jobId === target || r.sessionId === target);
if (!reg) throw new Error('no session ' + target);
const sock = reg.messagingSocketPath;
const hash = crypto.createHash('sha256').update(sock.toLowerCase()).digest('hex'); // canonical: pipe path lowercased
const keyFile = path.join(dir, `${reg.pid}.${hash}.key`);
const { peerToken } = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
console.log('target', reg.name, reg.status, sock, 'keyfile exists');
const c = net.connect(sock, () => {
  c.write(JSON.stringify({ type: 'auth', token: peerToken }) + '\n');
  c.write(JSON.stringify({ type: 'user', message: { content: text }, from: 'external-node-cli', priority, msg_id: crypto.randomUUID() }) + '\n');
  setTimeout(() => c.end(), 500);
});
c.on('data', d => console.log('recv:', d.toString()));
c.on('error', e => console.error('err', e.message));
c.on('close', () => console.log('closed'));
```

## Caveats

- **Stability:**
  - Cross-session messaging (`ListAgents`, `SendMessage`, the inbox pipe) is
    DOCUMENTED at code.claude.com/docs/en/cross-session-messaging and needs
    v2.1.234+ on native Windows.
  - Reading another session's `.key` file and the `type:"user"` frame shape
    are internal and could change in any release.
  - `claude-message-mcp` hardcodes its captured protocol at 2.1.282.
  - Pin tests to captured frames and smoke-test after each Claude Code
    upgrade.
- **Inbound filter:** delivery depends on the receiver's
  `crossSessionInbound`. The user's is `"accept"`. Without it, a session in
  bypass-permissions mode holds unverified peer messages for the user's
  approval (DOCUMENTED).
- **Limits (DOCUMENTED):**
  - about 1M characters per message,
  - per-sender rate limits,
  - at most 50 queued messages.
- **No reply address:** injected messages arrive without one. For a real
  reply route, a sender would have to bind its own `cc-msg-` pipe and set
  `from` to a `uds:` address (INFERRED; untested). vibe-pairing doesn't need
  this, because agents reply by posting to the room.
- **Excluded sessions:** `--bare` sessions bind no pipe. `claude -p`
  sessions do (DOCUMENTED).

## Alternatives

- **Channels (DOCUMENTED, research preview):**
  - An MCP server declares `capabilities.experimental['claude/channel']: {}`
    and sends `notifications/claude/channel {content, meta}`. The model sees
    a `<channel source=...>` event.
  - Events queue in order and are batched while Claude is busy.
  - Custom servers require launching with
    `claude --dangerously-load-development-channels server:<name>`, because
    `--channels` only accepts allowlisted plugins.
  - Events from a server the session didn't opt into are dropped silently.
  - The docs don't explicitly say an idle session wakes on a channel event.
  - This is the supported fallback if the pipe route breaks.
- **Stop hook (DOCUMENTED):**
  - `{"decision":"block","reason":"..."}` (or exit code 2) prevents stopping
    and hands `reason` to Claude.
  - Default timeouts: 600 s for command/http/mcp_tool hooks, 30 s for
    UserPromptSubmit and prompt hooks, 60 s for agent hooks. No stated
    maximum apart from the 60 s SessionEnd budget.
  - Verify the `stop_hook_active` semantics on the hooks page before relying
    on it.
- **`asyncRewake: true` (DOCUMENTED):** runs a hook in the background and
  wakes Claude when it exits with code 2, showing its stderr. This is a
  candidate for a harness-native room listener.
- **Remote Control:** not investigated. It routes through Anthropic's
  servers.

## Implications for vibe-pairing

- **Idle wake for Claude is solved:** the dispatcher writes to the agent's
  pipe, as `inject.mjs` does. No PTY injection is needed.
- **Registration:** `room up` or the first hook records
  `name → pid, sessionId, messagingSocketPath` from `~/.claude/sessions`.
- **Delivery while busy:** the `PostToolUse` hook's `additionalContext`
  still gives real-time delivery. A pipe message with priority `next` also
  arrives between tool calls.
- **Mitigate the internal-protocol risk:**
  - put pipe delivery behind a small adapter with captured-frame tests,
  - keep Channels plus the `Stop` hook as the fallback.

Sources:
[cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging),
[channels](https://code.claude.com/docs/en/channels),
[channels reference](https://code.claude.com/docs/en/channels-reference),
[hooks](https://code.claude.com/docs/en/hooks)
