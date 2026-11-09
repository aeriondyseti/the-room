---
id: ADR-0011
status: accepted
date: 2026-09-28
made-in: "6.14"
supersedes: []
superseded-by:
tags: [tui]
---
# Percentage inside the bar

## Context and Problem Statement

Kevin asked for the percentages inside the progress bars and chose the htop/btop style (option a).

## Decision Outcome

- A bar is cells: the filled part in reverse video in its state colour, a dim ░ track, and the number centred over it
  (padded per column so decimals align).
- Padding shows the bar beneath it.
- Bar size is chosen as the largest that fits (monotonic in width); caveats inline or wrapped.

### Consequences

- The number no longer needs its own column, so a metric is about 6 cells narrower, and Fable fits on Claude's row in
  narrower panes.
- Reverse video keeps the fill visible without colour.
- Supersedes the "bar then number" form from ADR-0009 and ADR-0010; the state colours from ADR-0010 are unchanged.

## More Information

Decision-makers, as first recorded: Kevin, Claude.
