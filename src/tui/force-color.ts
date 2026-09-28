// Test helper: pin full colour before Ink's chalk loads (it reads FORCE_COLOR once, at import). Import this FIRST in
// tests that assert on colour/inverse escape codes, so they don't depend on whether the caller's stdout is a TTY.
// `node --test` runs each test file in its own process, so this never leaks into other files.
process.env.FORCE_COLOR = '3';
export {};
