// Error contract: stable codes shared by service, IPC, CLI, MCP and TUI. Every code has a default hint
// so agents and humans always learn what to do next (ROADMAP 5.2).
import type { ErrorInfo } from './domain.js';

export const ERROR_HINTS = {
  bad_request: 'Check the request parameters against the tool or command help.',
  unknown_recipient: 'Run `room who` (or room_who) to list participant names.',
  no_recipients: 'Address at least one participant, e.g. to="astra", or use "all".',
  identity_unresolved: 'Register this session with `room join --as <name>` (or room_join), or pass --as <name>.',
  identity_mismatch: "The detected session doesn't match that name. Re-run `room join --as <name>` from the right session.",
  not_registered: 'Register first with `room join --as <name>` (or room_join).',
  duplicate_name: 'That name is taken by another session; choose a different name.',
  duplicate_binding: 'This session is already registered under another name; use that name.',
  rebind_conflict:
    'That name is bound to a different session. To move it to this session, repeat the join passing the current binding (shown by `room who`) as expectedPrevious.',
  dedup_conflict: 'That client_message_id was already used with a different message; use a new id.',
  message_too_large: 'Shorten the message, or split it into parts that each make sense on their own.',
  not_found: 'Check the id; `room read` lists recent message ids.',
  invalid_state: 'The requested action does not apply in the current state; refresh with `room who`.',
  service_unavailable: 'Start the room service with any `room` command, or run `room doctor`.',
  unsupported_version: 'Upgrade the older of client and service so their protocol versions match.',
  internal: 'Unexpected error; see the service log under .room/ and run `room doctor`.',
} as const satisfies Record<string, string>;

export type ErrorCode = keyof typeof ERROR_HINTS;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_HINTS, value);
}

/** The one error class used across modules; serializes to ErrorInfo for IPC/MCP/CLI. */
export class RoomError extends Error {
  readonly code: ErrorCode;
  readonly hint: string;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
    this.hint = hint ?? ERROR_HINTS[code];
  }

  toInfo(): ErrorInfo {
    return { code: this.code, message: this.message, hint: this.hint };
  }
}

/** Convert anything thrown into ErrorInfo without leaking stack traces or unknown object contents. */
export function toErrorInfo(err: unknown): ErrorInfo {
  if (err instanceof RoomError) return err.toInfo();
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'internal', message, hint: ERROR_HINTS.internal };
}

/** Rehydrate an ErrorInfo received over IPC into a RoomError (unknown codes become `internal`). */
export function fromErrorInfo(info: ErrorInfo): RoomError {
  return new RoomError(isErrorCode(info.code) ? info.code : 'internal', info.message, info.hint);
}
