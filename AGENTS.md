# AGENTS.md — for Codex agents (Astra)

**[CLAUDE.md](./CLAUDE.md) is the shared anchor for both agents. Read it first and follow it.** It
contains the document spine, the sprint workflow, two-agent coordination (ownership, serialized merges and
tags), the load-bearing invariants, conventions, and commands. This file only adds Codex-specific notes.

## Codex-specific notes

- **Review gate:** use **[.agents/skills/local-code-review/](./.agents/skills/local-code-review/SKILL.md)**
  (the Codex equivalent of Claude's Workflow-based review). Write the report to `reviews/<id>.md`.
  Only a complete review satisfies the gate.
- **Your co-author trailer:** use your own configured identity. Don't reuse Claude's trailer.
- **Messaging:** use the pair-poc MCP tools (`send_message`, `read_log`, `participants`), and after
  feature 4.1 the real room's `room_send`. When a tool is unavailable, fall back to the documented CLI,
  never to hand-built shell strings with interpolated message text.
- **Your features** are the Astra-owned rows in ROADMAP.md: 0.2, 1.1–1.3, 2.1, 2.3, 4.2, 5.2, and a
  share of 5.3.
- The invariants in CLAUDE.md apply verbatim. In particular: argv-array `codex queue` only, and never
  write Codex's internal databases.
