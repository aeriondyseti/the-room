# Composer editing shortcuts

Status: proposed implementation spec, 2026-09-28. Requested by Kevin; no runtime changes in this branch.

## Behavior

| Key | Composer action |
| --- | --- |
| Enter | Existing send/command/confirmation behavior. |
| Ctrl+Enter | Insert exactly one newline at the cursor. Never send, execute a command, choose a command suggestion, or confirm a destructive action. |
| Ctrl+Backspace | Delete backward to the previous whitespace-delimited token boundary, as described below. |
| Backspace | Existing single-character deletion. |
| Alt+Enter | No application shortcut; leave Windows Terminal's fullscreen binding alone. If received by the app, ignore it rather than accidentally sending. |
| Backslash then Enter | Retain the existing explicit newline fallback for terminals lacking distinguishable Ctrl+Enter. |

These bindings apply to the composer, not activity/detail/help overlays. Editing uses the existing `edit()` path so it
cancels pending confirmations, invalidates stale completion state, and updates routing previews. Newline insertion
keeps all text to the right of the cursor and moves the cursor immediately after the inserted newline.

## Backward word deletion

Implement a pure `deleteWordBackward(Draft): Draft` helper alongside `backspace()` in `src/tui/composer.ts`.

1. At position zero, do nothing.
2. At the start of a line, delete only the preceding newline (join lines). Do not also erase the prior line's word.
3. Otherwise skip horizontal whitespace immediately left of the cursor, then delete the preceding maximal
   non-whitespace token, stopping at the current line boundary. If the prefix is indentation only, remove indentation.
4. Preserve the suffix after the cursor exactly; position the cursor at the deletion's left edge.
5. Use grapheme-safe boundaries; never leave half a surrogate pair, combining sequence, or joined emoji. Reuse a
   small `Intl.Segmenter` helper if needed. No selection/undo/editor navigation overhaul in this ticket.

`|` below denotes the cursor, not literal text:

| Before | After |
| --- | --- |
| `hello world|` | `hello |` |
| `hello world   |` | `hello |` |
| `hello wor|ld` | `hello |ld` |
| `hello\n   |` | `hello\n|` |
| `hello\n|world` | `hello|world` |
| `use @claude|` | `use |` |
| `open X:\repo\file.ts|` | `open |` |

Whitespace-delimited tokens deliberately keep paths, mentions and punctuation attached; this is not language-aware
code editing. Document that choice so implementation and tests agree.

## Terminal delivery and qualification

Read-only local probe against the installed Ink parser:

| Received bytes (escaped) | Parsed result |
| --- | --- |
| `\r` | return, ctrl=false |
| `\n` | enter, ctrl=false (not Ink's `key.return`) |
| `\x08`, `\x7f` | backspace, ctrl=false |
| `\x17` | w, ctrl=true |
| `\x1b[13;5u` | return, ctrl=true |
| `\x1b[127;5u` | backspace, ctrl=true |
| `\x1b[27;5;13~` | unrecognized in the installed parser |

Evidence: `node_modules/ink/build/parse-keypress.js` and `hooks/use-input.js`; synthetic parser calls only. This does
not prove which bytes Kevin's Windows Terminal actually emits. Do not relabel bare BS/DEL as Ctrl+Backspace, or plain
CR as Ctrl+Enter: those are ambiguous and would break ordinary editing/sending. Do not globally reinterpret paste
newlines as keyboard shortcuts. Recognized key-release events must not perform an edit a second time.

Handle `key.return && key.ctrl` before the ordinary return/send branch, and `key.backspace && key.ctrl` before
single-character backspace. Alt-return must not fall through to send. If the real terminal sends a legacy distinct
sequence, add only the mapping demonstrated by a focused key probe, with a regression through Ink's input path.

Qualification can use a temporary explicit key-diagnostic mode in the user's own terminal: display key names and
escaped bytes for the requested key presses only; do not record message bodies or general typing. Test physical
Ctrl+Enter and Ctrl+Backspace, ordinary Enter and Backspace, then Alt+Enter fullscreen. Do not claim complete native
Windows Terminal support from injected sequences alone.

If the terminal cannot distinguish the keys, explain the limitation and retain backslash+Enter. An optional,
user-applied Windows Terminal `sendInput` mapping can emit `\u001b[13;5u` for Ctrl+Enter and `\u001b[127;5u` for
Ctrl+Backspace. These sequences are verified with the local Ink parser; the terminal configuration itself still needs
live validation. Never edit terminal settings automatically as part of this ticket.

Microsoft documents the `sendInput` action and keybinding structure in
[Windows Terminal tips](https://learn.microsoft.com/en-us/windows/terminal/tips-and-tricks#send-input-commands-with-a-key-binding).

## Acceptance and integration

- Pure helper tests: empty/start/end/middle, multiple spaces/tabs, punctuation/path/mention tokens, indentation,
  newline joining, non-ASCII words, combining marks, joined emoji and suffix preservation.
- App tests through real Ink input decoding: modified Enter inserts a newline with zero send/command/retry/restart
  requests; plain Enter retains behavior; modified Backspace deletes a token; plain Backspace deletes one character;
  Alt+Enter never sends. Cover command suggestions, pending confirmations, overlays and multiline paste.
- Live Windows Terminal checks recorded separately from synthetic tests; capture actual sequences if unsupported.
- Update help, composer hint, README and onboarding wherever Alt+Enter was advertised. New primary hint:
  `Enter send · Ctrl+Enter newline · Ctrl+Backspace delete word`.
- No broker, native delivery, harness configuration or message-format changes. Claude owns the TUI implementation;
  Astra can review the pure helper and key-decoding coverage. Coordinate changes to `app.tsx` with ongoing TUI work.
