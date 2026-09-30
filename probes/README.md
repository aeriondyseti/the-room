# Thread identity MCP probe

Standalone Node stdio server, with no packages to install. This is an experiment, not the room implementation.

Tools:

- `probe_identity`: allowlisted environment IDs, PID/parent PID, startup time, random server-instance ID, and call counter.
- `probe_call_context`: the same information plus request metadata field names and explicit thread/session ID values. Other metadata values are omitted.
- `probe_echo`: exact string echo, UTF-8 SHA-256, and lengths for multiline/quoting/Unicode checks.

No file writes, subprocesses, network calls, or messages to agents. Stdout contains MCP frames only. It does not read `session.toml` or infer an ID from arguments. Absent environment IDs are returned as `null`.

## Codex configuration

The installed Node executable discovered on this machine is:
`C:/Users/Kevin/AppData/Local/mise/installs/node/24.18.0/node.exe`

```toml
[mcp_servers.thread-id-probe]
command = 'C:\Users\Kevin\AppData\Local\mise\installs\node\24.18.0\node.exe'
args = ['X:\Development\the-room\probes\thread-id-mcp.mjs']
```

Do **not** set or explicitly forward `CODEX_THREAD_ID` or `CODEX_SESSION_ID` for the first experiment: that would contaminate the default-inheritance observation. No thread ID is baked into this server or its configuration.

After restarting/resuming Codex, call `probe_identity` and `probe_call_context`. Compare the observed IDs with the harness's known thread ID. Repeat in another concurrent Codex session, then after a new thread/fork and after resumption.

- Same `server_instance_id` in two threads means they reached the same server process.
- Different IDs mean different server processes, but do not alone prove correct native identity binding.
- A missing environment ID is evidence about this launch, not proof that all harness configurations omit it.
- A fixed environment ID cannot identify multiple calling threads; look for per-call identity and test it.
- A changed process ID after resume is normal; compare the native session identity separately.
- Tool approvals/discovery can be observed when calling these read-only tools. No permission policy is changed by the probe.

For `probe_echo`, try quotes, backticks, dollar signs, newlines, backslashes, and emoji. Compare `echo.text` exactly to the submitted text. These tools do not assess whether the downstream `codex queue` command can accept a payload of the same size.

## Smoke test

Run `node probes/smoke-test.mjs`. It exercises the actual child-process stdio transport with clean and synthetic identity environments. Synthetic IDs only verify the probe plumbing; they are not evidence of harness inheritance.
