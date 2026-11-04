---
id: ADR-0019
status: proposed
date: 2026-11-03
decision-makers: [Kevin, Claude]
made-in: trunk
supersedes: [ADR-0009, ADR-0010, ADR-0011, ADR-0012]
superseded-by:
tags: [tui]
---
# Usage bars and the top bar: two layouts, state colours, the number inside one flat surface

## Context and Problem Statement

Four records each changed part of the one before: ADR-0009 (two layouts, ccstatusline bars, colour by meaning),
ADR-0010 (organised top bar, state colours, replacing ADR-0009's palette), ADR-0011 (the number inside the bar,
replacing the "bar then number" form) and ADR-0012 (one flat surface, changing ADR-0011's rendering). Records are now
superseded whole, never patched, so this record states the decision as it stands after all four. The choices were
made in tasks 6.8, 6.10, 6.14 and 6.15, mostly by Kevin (his mockup and his options a and c).

## Decision Outcome

Layouts:
- Two layouts, the top bar and the left panel, over one shared metric model (`bars.ts`, `accountWindows`,
  `workspaceSegments`), so the values can't diverge between them.
- The viewer's choice lives in `tui.json` in the room's `.room/` folder (a UI preference, not harness config). A
  narrow terminal falls back automatically without changing the preference.
- The top bar is two labelled grids, AGENTS and BUDGETS, with measured columns. Like pieces line up: values, reset
  times and caveats each get a column. The grid falls back to the wrapping lines when it doesn't fit in width or
  height, or while an overlay is open.
- Compact density is only ever explicit (`/compact`, Ctrl+T) and is remembered.

Colour and text:
- Bars take state colours: green below 70%, amber 70–90%, red above 90%, plus a bold "!" from 70%. Model, branch and
  reset are quiet. Agent names keep their per-agent colour, the colour their messages use in the conversation.
- Status is always textual (`n/a`, `(stale)`, `(last known)`, `?`, bold `!`), so NO_COLOR loses nothing. A missing
  value is "—".
- The "login unverified" caveat is hidden on screen (Kevin: almost always true); it stays in the data.

The bar:
- The number sits inside the bar, centred, padded per column so decimals align. Bar size is the largest that fits
  (monotonic in width); caveats go inline or wrap.
- A bar cell is a surface (`Segment.surface`). In colour, the fill is a solid background in the state colour
  (`STALE_FILL` grey when stale) with dark label text (`TEXT_ON_FILL`), and the track is a solid dim background
  (`TRACK_BG`, ansi256 237) with an explicit light foreground (`TEXT_ON_TRACK`); label glyphs have no background of
  their own. In monochrome, a reverse-video fill and a ░ track, so the extent (and a 0% bar) stays visible.
- Rendering is centralised in `surfaceStyle` and the app's `SegmentText`.

### Consequences

- ccstatusline's slider form and its palette, where the bars started, are both replaced.
- The message stream and bottom-bar parts of Kevin's mockup are deferred.

### Confirmation

Tests assert bars through the monochrome rendering (`barText`), plus rendered colour and mono frames:
src/tui/topbar.test.ts, src/tui/topgrid.test.tsx, src/tui/layout.test.tsx.

## More Information

Drafted at the docs migration of 2026-11-03 to consolidate the chain. Proposed: ADR-0009 to ADR-0012 stay in force
until Kevin accepts this record.
