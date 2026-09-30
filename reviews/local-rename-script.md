# Local checkout migration script review

- Base: `4129c548` (`main`, project rename already merged)
- Reviewed head: `11c2112` (`chore/local-rename-script`)
- Reviewers: independent correctness and contracts reviews, then one batched adversarial verifier and focused recheck
- Code review complete: **true**
- Execution status: pending; this Codex app holds the source directory open, so Kevin will run the script after leaving the session

## Important findings and fixes

- `scripts/rename-local-checkout.ps1`: preflight the existing global npm junction, any `the-room` entry, and `room` shims before unlinking or linking. Remove only residual shims that still target the old package. The verifier checked the `EEXIST` fix against the installed npm behavior.
- `scripts/rename-local-checkout.ps1`: check the room service lock owner, request graceful shutdown only for the running owner, and wait for its PID to exit before moving the directory. The script instructs the user to close the TUI to prevent a restart race.
- `scripts/rename-local-checkout.ps1`: close Claude Code sessions using the checkout before migration. Keep the optional probe MCP setting unchanged because the user authorized room MCP path changes only.
- `scripts/rename-local-checkout.ps1`: repair all nested linked worktrees and check each with `git rev-parse`. Git's documented worktree repair procedure supports this move.

## Operational limit

The old Codex project trust entry remains under the old path. The script warns Kevin to re-establish trust for the new checkout; it does not change permission settings. The migration cannot be executed or fully verified while this Codex app holds the old directory open.

## Tech debt

None from the script review.
