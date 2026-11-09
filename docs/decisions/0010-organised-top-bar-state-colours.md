---
id: ADR-0010
status: accepted
date: 2026-09-28
made-in: "6.10"
supersedes: []
superseded-by:
tags: [tui]
---
# Organised top bar; state colours for bars (supersedes ADR-0009's palette)

## Context and Problem Statement

Kevin's mockup ("The Room: a layout that's easier to parse") asked for a clearer hierarchy. He chose option c: the
mockup's state colours for bars, keeping per-agent name colours. The scope is the top bar only.

## Decision Outcome

- The top bar is two labelled grids (AGENTS, BUDGETS) with measured columns. Like pieces line up: values, reset
  times and caveats each get a column, and percentages are right-aligned.
- The 6.8 group colours are replaced by state colours: green < 70%, amber 70–90%, red > 90%, plus a bold "!" from
  70%. Model, branch and reset are quiet.
- A missing value is "—".
- The "login unverified" caveat is hidden on screen (Kevin: almost always true); it stays in the data.
- The grid falls back to the wrapping lines when it doesn't fit in width or height, or while an overlay is open.
- Compact density is only ever explicit (`/compact`, Ctrl+T) and is remembered.

### Consequences

- ccstatusline's bar format is kept, but its palette is not.
- The left panel is unchanged apart from the bar colours.
- The message stream and bottom-bar parts of the mockup are deferred.

## More Information

Decision-makers, as first recorded: Kevin, Claude.
