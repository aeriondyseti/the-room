---
title: Code-fence handling is minimal
where: src/tui/format.ts
source: task 5.1 review (lean)
date: 2026-09-28
confidence: 30
---
# Code-fence handling is minimal

Code-fence handling is CommonMark-style but minimal: no indented code blocks, no inline code styling, and an
unclosed fence runs to the end of the message. Severity: low. Source: `git show v0.9.0:reviews/5.1.md`.

## Why it waits

It covers the fenced blocks agents actually send, and nothing is ever dropped.

Suggested fix: extend `bodyLines` if agents use other markdown forms.
