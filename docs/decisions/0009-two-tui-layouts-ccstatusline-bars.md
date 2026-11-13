---
id: ADR-0009
status: accepted
date: 2026-09-28
made-in: "6.8"
supersedes: []
superseded-by:
tags: [tui]
---
# Two TUI layouts, ccstatusline bars, colour by meaning

## Context and Problem Statement

Kevin couldn't choose between the 6.6 top bar and the earlier left sidebar, and asked for colour grouping and his
ccstatusline "slider" bars. Astra researched his settings and the renderer, read-only.

## Decision Outcome

- Keep both layouts over one shared metric model (`bars.ts`, `accountWindows`, `workspaceSegments`), so the values
  can't diverge between them.
- The viewer's choice lives in `.room/tui.json` (a UI preference, not harness config). <!-- docs-check-ignore -->
- A narrow terminal falls back automatically without changing the preference.
- Bars reproduce ccstatusline `slider` exactly. Colours are fixed per meaning, from Kevin's 256-colour palette.
- Status is always textual (`n/a`, `(stale)`, `(last known)`, `?`, bold `!`), so NO_COLOR loses nothing.
- One deviation from Astra's spec: agent names keep their per-agent colour, because it's the colour their messages
  use in the conversation and links chip to speaker. Model and branch are cyan as specified.

### Consequences

- High usage no longer turns red or yellow; it keeps its group colour plus a bold `!`.
- The left panel needs `max(tuiPanelBreakpoint, tuiPanelWidth + 51)` columns; the default panel is 34 wide, so a bar
  plus "Fable weekly" fits.

## More Information

Decision-makers, as first recorded: Kevin, Claude.
