# Review — remove outer divider

Complete: true. Scope: explicit user-requested reversal of6.17 after visual testing.
Implementation aebf47f. Independent cross-review: Claude, room m-mulkj1yq,
APPROVE with no actionable findings. Small reversal uses the established direct cross-review gate.
Only the outer divider wrapper and dimension reservation are removed. The inner layout remains.
The previous edge test now verifies absence of cyan background and visible bottom status across
both layouts, narrow fallback, help and long draft. Full branch suite:340/340.
6.18 is still separate; Claude will adapt its pending left-layout status-row assertion after this merge.
