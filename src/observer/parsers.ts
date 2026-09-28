// Pure parsers for harness transcript records → usage samples. Formats qualified on Claude Code 2.1.283 and
// Codex 0.157.1 (DESIGN §3: version-sensitive details stay in one place). Unknown shapes yield null, never 0.

export interface TokenCounters {
  /** Non-cached input tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageSample {
  /** ISO timestamp of the transcript record. */
  at: string | null;
  /** Counters contributed by this record (Claude: per message) or the running total (Codex: cumulative). */
  counters: TokenCounters;
  /** Tokens occupying the context window at this record, when derivable. */
  contextTokens: number | null;
  /** Context window size, when the source reports it. */
  contextLimit: number | null;
}

// ---- Claude Code: assistant messages carry message.usage (per API response) ------------------------------

export interface ClaudeUsageRecord {
  messageId: string;
  /** Model id from the record (used to look up a known context limit), when present. */
  model: string | null;
  sample: UsageSample;
}

/**
 * Claude writes one transcript line per streamed content block, repeating the same `message.id` and usage.
 * Callers dedupe by `messageId`. Context occupancy for a response = everything it read as input
 * (input + cache creation + cache read).
 */
export function parseClaudeRecord(value: unknown): ClaudeUsageRecord | null {
  if (!isRecord(value) || value['type'] !== 'assistant') return null;
  const message = value['message'];
  if (!isRecord(message) || typeof message['id'] !== 'string') return null;
  const usage = message['usage'];
  if (!isRecord(usage)) return null;
  const input = num(usage['input_tokens']);
  const output = num(usage['output_tokens']);
  const cacheWrite = num(usage['cache_creation_input_tokens']) ?? 0;
  const cacheRead = num(usage['cache_read_input_tokens']) ?? 0;
  if (input === null || output === null) return null;
  return {
    messageId: message['id'],
    model: typeof message['model'] === 'string' ? message['model'] : null,
    sample: {
      at: typeof value['timestamp'] === 'string' ? value['timestamp'] : null,
      counters: { input, output, cacheRead, cacheWrite },
      contextTokens: input + cacheWrite + cacheRead,
      contextLimit: null, // not recorded in the transcript; never guessed (invariant 3)
    },
  };
}

// ---- Codex: event_msg/token_count carries cumulative totals + last-turn usage + context window --------------

/**
 * Codex reports cumulative `total_token_usage` (input includes cached input) and `last_token_usage` for the
 * latest request. Context occupancy = the latest request's input tokens.
 */
export function parseCodexRecord(value: unknown): UsageSample | null {
  if (!isRecord(value) || value['type'] !== 'event_msg') return null;
  const payload = value['payload'];
  if (!isRecord(payload) || payload['type'] !== 'token_count') return null;
  const info = payload['info'];
  if (!isRecord(info)) return null; // Codex emits token_count with info=null before the first response
  const total = info['total_token_usage'];
  if (!isRecord(total)) return null;
  const input = num(total['input_tokens']);
  const output = num(total['output_tokens']);
  if (input === null || output === null) return null;
  const cached = num(total['cached_input_tokens']) ?? 0;
  const last = info['last_token_usage'];
  const window = num(info['model_context_window']);
  return {
    at: typeof value['timestamp'] === 'string' ? value['timestamp'] : null,
    counters: {
      input: Math.max(0, input - cached),
      output,
      cacheRead: cached,
      cacheWrite: num(total['cache_write_input_tokens']) ?? 0,
    },
    contextTokens: isRecord(last) ? num(last['input_tokens']) : null,
    contextLimit: window !== null && window > 0 ? window : null,
  };
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
