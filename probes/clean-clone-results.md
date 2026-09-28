# Clean-clone quickstart check — 2026-09-28

Verified from README commit73a404b on sprint/5.3, based on main v0.0.17 (2bcdcdf). The clone was a separate full local Git clone (`--no-local --single-branch`), not a worktree and not a shared node_modules installation.

Fixture: OS temp directory `vpfix-clean-clone-dPFnsk`. No session.toml or room ledger was inherited. No agents were registered or messaged.

Commands and results:

- `npm ci`: installed140 packages from the committed lockfile; exit0.
- `npm run build`: exit0.
- `node dist/cli/main.js --help`: listed the implemented CLI commands, including reply.
- `node dist/cli/main.js who`: auto-started an empty local room; reported0 agents.
- `node dist/cli/main.js doctor --json`: canonical clone root, empty registry, resolved native Codex executable, active service; exit0.
- Closed that owned service through its IPC shutdown request before further validation.
- `npm test`:193/193 passed, including CLI child-process, native adapter fixtures, actual process restart/crash tests, MCP and Ink TUI tests.
- `node dist/cli/main.js tui --help`: exit0 and expected startup instructions.

This checks install/build, empty-room service setup and automated TUI startup/rendering coverage. It is not a manual visual review in a physical terminal, a global npm-link test, or full harness qualification. The4.1 wake/soak and Codex approval gates remain separate. No global harness configuration was modified.
