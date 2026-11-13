---
id: ADR-0005
status: accepted
date: 2026-09-28
made-in: trunk
supersedes: []
superseded-by:
tags: [build]
---
# Build with tsc; tests with node:test on the compiled output

## Context and Problem Statement

Ink needs JSX, and Node's built-in type stripping can't handle `.tsx`. We want few dependencies and a standard
toolchain.

## Decision Outcome

- TypeScript (strict, ESM, `jsx: react-jsx`), compiled by `tsc` to `dist/`.
- Tests use `node --test` on `dist/**/*.test.js`.
- Typecheck is the lint gate.
- Runtime dependencies: `ink`, `react`, `@modelcontextprotocol/sdk`, and a TOML library if needed (decided by 0.2's
  owner).
- Dev dependencies: `typescript`, `@types/node`, `@types/react`, `ink-testing-library`.

### Consequences

The service stays built-in-only (`node:sqlite`, `node:net`); the TUI and MCP carry the dependencies.

## More Information

Decision-makers, as first recorded: Claude.
