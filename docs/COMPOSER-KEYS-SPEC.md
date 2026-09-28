# Composer editing shortcuts

Status: proposed implementation spec, 2026-09-28. Requested by Kevin; no runtime changes in this branch.

## Behavior

| Key | Composer action |
| --- | --- |
| Enter | Existing send/command/confirmation behavior. |
| Ctrl+Enter | Insert exactly one newline at the cursor. Never send, execute a command, choose a command suggestion, or confirm a destructive action. |
| Ctrl+Backspace | Delete backward to the previous whitespace-delimited token boundary, as described below. |
| Ctrl+Left / Ctrl+Right | Move to the previous / next token boundary without changing text. |
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

## Word navigation (Kevin's follow-up)

Add pure `wordLeft(Draft)` and `wordRight(Draft)` helpers with the same whitespace-token definition and grapheme
safety as deletion. Ctrl+Left skips whitespace to the left, then moves to the beginning of the preceding token.
Ctrl+Right skips the remaining current token and then following whitespace, landing at the next token's beginning
or end of draft. Navigation may cross newlines; deletion retains the explicit line-join behavior above.

Examples: `hello world|` → Ctrl+Left → `hello |world`; `hel|lo world` → Ctrl+Right → `hello |world`;
`hello |world` → Ctrl+Left → `|hello world`. At start/end, clamp. Neither shortcut sends, changes routing text, or
modifies history. Handle modifier+arrow before plain arrow. This ticket defines Ctrl+Left/Right; Ctrl+Up/Down are
not assigned a new meaning. Shift+selection is outside this ticket.

## Growing composer and bottom-bar isolation (Kevin's follow-up)

Current code caps logical lines with `MAX_DRAFT_ROWS = 5` and budgets `draft.text.split('\n').length`. Logical-line
counts miss terminal soft wrapping, so a long line can consume unbudgeted rows. Replace that calculation with one
shared visual-line model for both layout and rendering.

- Measure grapheme display columns (including wide CJK and emoji), the prompt/continuation gutter and cursor cell;
  preserve hard newlines and calculate soft wraps explicitly. Ink must not independently create additional rows.
- Grow from one visual row to a configurable ceiling, proposed `ROOM_TUI_COMPOSER_MAX_ROWS=12`. The actual ceiling
  also respects available terminal height after all other chrome and at least three conversation rows when space
  permits. On a typical 30-row pane, a draft with six to eight lines must be usable without covering the footer.
- Reserve bottom status/routing, separator, actual wrapped feedback and suggestion rows BEFORE assigning composer
  and conversation height. Include them in the top-grid height guard (addresses TD-0027); collapse detail as needed
  without overwriting the saved grid preference. Avoid contradictory minimum heights that exceed physical rows.
- When the draft exceeds its viewport, scroll inside the composer to keep the cursor visible; retain the whole draft.
  Show above/below overflow indicators in a reserved gutter or existing row, not an unbudgeted extra line.
- Resize recomputes wraps and cursor position without editing the draft. Shrinking the terminal, changing layout,
  opening suggestions, or displaying an error must never overwrite the bottom bar or lose text. Small terminals
  prioritize an editable cursor row and essential send/status feedback over decorative sections.
- Preserve existing history behavior in this ticket; word navigation and cursor-following must not accidentally
  activate history. A later ticket can define multiline Up/Down navigation independently.

Acceptance adds explicit 6/8/12/30-line drafts, long soft-wrapped lines, wide/combining text, cursor at each edge,
resize in both layouts, suggestions plus feedback, and a frame-height assertion that the footer remains separate.
Verify the physical terminal as well as line-model tests; screenshot/observed rendering is needed to close the
reported footer-overwrite defect, not just a logical line-count test.

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
| `\x1b[1;5D`, `\x1b[1;5C` | left/right, ctrl=true |
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
