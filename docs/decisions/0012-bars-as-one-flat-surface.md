---
id: ADR-0012
status: accepted
date: 2026-09-28
made-in: "6.15"
supersedes: []
superseded-by:
tags: [tui]
---
# Bars as one flat surface (changes ADR-0011's rendering)

## Context and Problem Statement

Kevin: the ░ track with a flat-backed label "reads as a patch pasted over a textured strip"; he wants a single flat
surface.

## Decision Outcome

- A bar cell is a *surface* (`Segment.surface`).
- In colour: the fill is a solid background in the state colour (`STALE_FILL` grey when stale) with dark label text
  (`TEXT_ON_FILL`); the track is a solid dim background (`TRACK_BG`, ansi256 237) with an explicit light foreground
  (`TEXT_ON_TRACK`). Label glyphs have no background of their own.
- In monochrome (no backgrounds): a reverse-video fill and a ░ track, so the extent (and a 0% bar) stays visible.
- Rendering is centralised in `surfaceStyle` and the app's `SegmentText`.

### Consequences

- ADR-0011's layout is kept (the number inside, aligned, monotonic sizing); only the cell rendering changes.
- Tests assert bars through the monochrome rendering (`barText`), plus rendered colour and mono frames.

## More Information

The old log titled this record "amends ADR-0011's rendering". Records are no longer amended; ADR-0019 (proposed)
states the bar decisions of ADR-0009 to ADR-0012 as one record.

Decision-makers, as first recorded: Kevin, Claude.
