// Claude Code transcript → activity items (6.1). Pure: one decoded record in, a verdict out (contract: ActivityParser).
// Record shapes qualified on Claude Code 2.1.283 transcripts (2026-09-28). Hidden reasoning (`thinking`) is never
// exposed; subagent (sidechain) records are ignored so a subagent's work isn't shown as the main agent's.
import type { ActivityItem, ActivityParseResult, ActivityParser } from '../contracts/activity.js';
import { capDetail, displayJson, summaryLine } from './activity-text.js';

type Item = Omit<ActivityItem, 'stream' | 'seq'>;

/** Record types that carry nothing to show (session metadata, UI state, queue bookkeeping, costs). */
const HOUSEKEEPING = new Set([
  'custom-title', 'agent-name', 'mode', 'permission-mode', 'atis-latch', 'file-history-snapshot', 'attachment',
  'last-prompt', 'queue-operation', 'cost-state', 'summary',
]);

/** `mcp__room__room_send` → `room.room_send`; other tool names pass through. */
export function toolName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]}.${m[2]}` : name;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  return content === undefined || content === null ? '' : displayJson(content);
}

export const claudeActivityParser: ActivityParser = {
  harness: 'claude',
  parse({ value }, { detailBytes }): ActivityParseResult {
    if (!value || typeof value !== 'object') return { kind: 'unknown', reason: 'not an object' };
    const r = value as { type?: unknown; timestamp?: unknown; isSidechain?: unknown; subtype?: unknown; message?: { content?: unknown } };
    const type = typeof r.type === 'string' ? r.type : null;
    if (type === null) return { kind: 'unknown', reason: 'record has no type' };
    if (HOUSEKEEPING.has(type)) return { kind: 'ignored' };
    if (r.isSidechain === true) return { kind: 'ignored' };
    const at = typeof r.timestamp === 'string' ? r.timestamp : null;
    const detail = (text: string) => {
      const d = capDetail(text, detailBytes);
      return { detail: d.detail, detailTruncated: d.truncated };
    };

    if (type === 'system') {
      if (r.subtype === 'turn_duration') return { kind: 'items', items: [{ at, kind: 'turn_end', summary: 'turn ended', detailTruncated: false }] };
      return { kind: 'ignored' };
    }

    const content = r.message?.content;
    if (type === 'assistant') {
      if (!Array.isArray(content)) return { kind: 'unknown', reason: 'assistant record without content blocks' };
      const items: Item[] = [];
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          items.push({ at, kind: 'message', role: 'assistant', summary: summaryLine(block.text), ...detail(block.text) });
        } else if (block?.type === 'tool_use') {
          const tool = toolName(String(block.name ?? 'tool'));
          const args = displayJson(block.input ?? {});
          items.push({
            at, kind: 'tool_call', tool, ...(typeof block.id === 'string' ? { callId: block.id } : {}),
            summary: summaryLine(`${tool} ${args}`), ...detail(args),
          });
        }
        // `thinking` / `redacted_thinking` and anything else: never shown.
      }
      return items.length ? { kind: 'items', items } : { kind: 'ignored' };
    }

    if (type === 'user') {
      if (typeof content === 'string') {
        return content.trim() === '' ? { kind: 'ignored' } : { kind: 'items', items: [{ at, kind: 'message', role: 'user', summary: summaryLine(content), ...detail(content) }] };
      }
      if (!Array.isArray(content)) return { kind: 'unknown', reason: 'user record without content' };
      const items: Item[] = [];
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type === 'tool_result') {
          const out = textOf(block.content);
          const isError = block.is_error === true;
          items.push({
            at, kind: 'tool_result', ...(typeof block.tool_use_id === 'string' ? { callId: block.tool_use_id } : {}),
            ...(isError ? { isError } : {}), summary: summaryLine(`${isError ? 'error: ' : ''}${out || '(no output)'}`), ...detail(out),
          });
        } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          items.push({ at, kind: 'message', role: 'user', summary: summaryLine(block.text), ...detail(block.text) });
        }
      }
      return items.length ? { kind: 'items', items } : { kind: 'ignored' };
    }

    return { kind: 'unknown', reason: `unrecognised record type "${type.slice(0, 40)}"` };
  },
};
