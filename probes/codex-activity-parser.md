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
in that snapshot). These include nested work inside exec. Follow-up qualification separated web.search extensions (independent IDs) from clock.sleep mirrors
(same response call IDs) and subagent lifecycle notices. Web results are shown; clock metadata and
qualified subagent lifecycle notices are ignored, with parent tool calls preserved. Child agent
transcripts are separate sources and are not traversed by this parser.
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

Validation: 216 complete-suite tests pass; six focused parser tests cover calls/results, pairing,
message/turn timestamps, ignored mirrors/reasoning, unknown/malformed shapes, known sensitive fields,
UTF-8 bounds, terminal controls and error statuses. Correctness reviewer independently reran the
focused tests and returned no findings. Shared reader/TUI tests must still qualify cursor reset,
retention, pairing presentation and no-feedback behavior.


## Contract-review follow-up

Two real repository rollouts were audited read-only: Astra thread 01a0e605-2485-7693-a111-97e35d22a97e
(5598 records at final audit), and the MCP identity-probe thread
01a0e657-f65e-7ce1-892c-c1fad1b41efd (57 records). Both now produce zero unknown records. No persisted
exec_command_begin/end, patch_apply_begin/end, or mcp_tool_call_begin/end events were found.
Genuinely unknown future record types still return unknown. The earlier 2000-record sample above
records the initial coverage gap, before this follow-up.

Peer agent_message text is shown as an observed peer message with no authoritative role. Encrypted
content blocks are ignored and never decoded or displayed. function/custom outputs in these samples
have no qualified structured exit-code metadata: isError is absent when unknown, never inferred as
success. Native command exit codes, declined and failed statuses are mapped explicitly.

The correctness reviewer independently reran all six focused tests after these additions, with no
findings. Claude supplied the independent contract review and requested the cross-rollout checks;
they are satisfied by the evidence above. Integration and final 6.1 review remain Claude's work.
