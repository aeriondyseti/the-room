# Codex activity parser qualification

Date: 2026-09-28. Codex 0.157.1, native Windows. Pure parser only; shared reader/TUI integration is
owned by sprint/6.1 and is not claimed complete here.

Shapes inspected from the enrolled Astra rollout without printing message/tool bodies:
- response_item: custom_tool_call, function_call, their outputs, user/assistant message content;
- event_msg: task_started, task_complete, turn_aborted;
- item_completed: CommandExecution, McpToolCall, FileChange.

Completed native tools produce paired call/result items with their native item id; both use the
record timestamp, not an invented start time. In the inspected rollout, supported native tool IDs
had no intersection with top-level response call IDs (108 MCP, 450 command, 46 file-change records
in that snapshot). These include nested work inside exec. Extensions/subagent representations did
show overlap, so they remain explicitly unsupported/partial until pairing/dedup is qualified.
Mirrored user/assistant event messages are ignored in favor of response_item messages. Reasoning,
analysis-channel messages, developer/system instructions, context and usage records are not displayed.

A read-only sample of the last 2000 records yielded 1049 items, 1081 ignored records, and 44 unknown
records (30 unsupported native items, 14 unsupported response items). Counts of items can exceed
records because completed tools emit a pair. All details stayed within 4096 bytes; sample parsing
completed in 161 ms. No source content or authentication data was written to this report.

Unknown/malformed shapes yield static reasons for partial coverage, not raw dumps. Timestamps missing
or invalid are null. JSON-encoded arguments/results are decoded before sensitive-field redaction;
shared helpers sanitize controls, redact known token patterns and cap bytes. This is best effort,
not universal detection of secrets in arbitrary stdout. Truncation is explicit. The parser never
reads files, sends messages, changes identity/liveness, or executes tool content.

Validation: 215 complete-suite tests pass; five focused parser tests cover calls/results, pairing,
message/turn timestamps, ignored mirrors/reasoning, unknown/malformed shapes, known sensitive fields,
UTF-8 bounds, terminal controls and error statuses. Correctness reviewer independently reran the
focused tests and returned no findings. Shared reader/TUI tests must still qualify cursor reset,
retention, pairing presentation and no-feedback behavior.
