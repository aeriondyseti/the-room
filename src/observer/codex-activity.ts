// Pure Codex rollout activity parser. Qualified shapes: Codex 0.157.1; no harness I/O here.
import type { ActivityItem, ActivityParser, ActivityParseResult, ActivityRecordInput } from '../contracts/activity.js';
import { capDetail, displayJson, summaryLine } from './activity-text.js';

type Item = Omit<ActivityItem, 'stream' | 'seq'>;
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null;
const text = (v: unknown): string | undefined => typeof v === 'string' && v.length > 0 ? v : undefined;
const ignored: ActivityParseResult = { kind: 'ignored' };
const unknown = (reason: string): ActivityParseResult => ({ kind: 'unknown', reason });
const housekeeping = new Set(['session_meta', 'turn_context', 'world_state', 'token_usage_record', 'compacted', 'inter_agent_communication_metadata']);
const ignoredEvents = new Set(['token_count', 'agent_reasoning', 'agent_message', 'user_message', 'thread_settings_applied']);

// Arguments and MCP text results often contain encoded JSON. Decode before sensitive-field redaction;
// leave ordinary stdout as text. Bounded depth avoids recursion through adversarial input.
function decoded(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[nested content omitted]';
  if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
    try { return decoded(JSON.parse(value), depth + 1); } catch { return value; }
  }
  if (Array.isArray(value)) return value.map(v => decoded(v, depth + 1));
  if (object(value)) return Object.fromEntries(Object.entries(value as Obj).map(([k, v]) => [k, decoded(v, depth + 1)]));
  return value;
}
const display = (value: unknown) => displayJson(decoded(value)) ?? '';

export const codexActivityParser: ActivityParser = {
  harness: 'codex',
  parse: parseCodexActivity,
};

export function parseCodexActivity(record: ActivityRecordInput, limits: { detailBytes: number }): ActivityParseResult {
  const r = object(record.value);
  if (!r || typeof r.type !== 'string') return unknown('Malformed Codex rollout record');
  if (housekeeping.has(r.type)) return ignored;
  const p = object(r.payload);
  if (!p || typeof p.type !== 'string') return unknown('Missing Codex activity payload');
  const at = typeof r.timestamp === 'string' && Number.isFinite(Date.parse(r.timestamp)) ? r.timestamp : null;
  const turn = text(p.turn_id) ?? text(object(p.internal_chat_message_metadata_passthrough)?.turn_id);
  const metadata = { at, ...(turn ? { turnId: summaryLine(turn) } : {}) };
  const cap = Number.isSafeInteger(limits.detailBytes) && limits.detailBytes >= 0 ? limits.detailBytes : 0;
  const make = (kind: Item['kind'], title: string, value?: unknown, extra: Partial<Item> = {}): Item => {
    const detail = value === undefined ? undefined : capDetail(display(value), cap);
    return { ...metadata, kind, summary: summaryLine(title), detailTruncated: detail?.truncated ?? false,
      ...(detail ? { detail: detail.detail } : {}), ...extra };
  };
  const items = (...values: Item[]): ActivityParseResult => ({ kind: 'items', items: values });
  if (r.type === 'response_item') {
    if (p.type === 'reasoning') return ignored;
    if (p.type === 'message') {
      // Developer/system instructions and analysis are context, not user-visible activity.
      if (p.role === 'developer' || p.role === 'system' || p.channel === 'analysis') return ignored;
      if (p.role !== 'user' && p.role !== 'assistant') return unknown('Unsupported Codex message role');
      if (!Array.isArray(p.content)) return unknown('Malformed Codex message content');
      const parts: string[] = [];
      for (const part of p.content) {
        const c = object(part);
        if (!c) return unknown('Malformed Codex message block');
        if (['input_text', 'output_text', 'text', 'Text'].includes(String(c.type)) && typeof c.text === 'string') parts.push(c.text);
        else if (['input_image', 'image', 'input_audio', 'audio'].includes(String(c.type))) parts.push('[non-text content omitted]');
        else return unknown('Unsupported Codex message block');
      }
      const body = parts.join('\n');
      if (!body) return ignored;
      // Summary must use the same field-redacted representation as detail, not raw JSON text.
      return items(make('message', `${p.role}: ${display(body)}`, body, { role: p.role }));
    }
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      const name = text(p.name), call = text(p.call_id);
      const input = p.type === 'function_call' ? p.arguments : p.input;
      if (!name || !call || input === undefined) return unknown('Malformed Codex tool call');
      return items(make('tool_call', `Call ${name}`, input, { tool: summaryLine(name), callId: summaryLine(call) }));
    }
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const call = text(p.call_id);
      if (!call || p.output === undefined) return unknown('Malformed Codex tool result');
      return items(make('tool_result', 'Tool result', p.output, { callId: summaryLine(call), ...(typeof p.is_error === 'boolean' ? { isError: p.is_error } : {}) }));
    }
    return unknown('Unsupported Codex response item');
  }
  if (r.type !== 'event_msg') return unknown('Unsupported Codex rollout record');
  if (ignoredEvents.has(p.type)) return ignored;
  if (p.type === 'task_started') return items(make('turn_start', 'Turn started'));
  if (p.type === 'task_complete') return items(make('turn_end', 'Turn ended'));
  if (p.type === 'turn_aborted') return items(make('turn_end', 'Turn interrupted', p.reason, { isError: true }));
  if (p.type !== 'item_completed') return unknown('Unsupported Codex activity event');
  const item = object(p.item);
  if (!item || typeof item.type !== 'string') return unknown('Malformed Codex completed item');
  // These duplicate response_item messages or expose reasoning/context. Never render them twice.
  if (['UserMessage', 'AgentMessage', 'Reasoning', 'ContextCompaction'].includes(item.type)) return ignored;
  const id = text(item.id);
  if (!id) return unknown('Codex completed tool has no call id');
  const callId = summaryLine(id);
  const pair = (name: string, input: unknown, output: unknown, isError?: boolean) => items(
    make('tool_call', `Call ${name}`, input, { tool: summaryLine(name), callId }),
    make('tool_result', `${name} result`, output, { tool: summaryLine(name), callId, ...(isError === undefined ? {} : { isError }) }),
  );
  if (['McpToolCall', 'CommandExecution', 'FileChange'].includes(item.type) && !['completed', 'failed', 'declined'].includes(String(item.status))) return unknown('Unsupported Codex completed-tool status');
  if (item.type === 'McpToolCall') {
    const server = text(item.server), tool = text(item.tool);
    if (!server || !tool || item.arguments === undefined || item.result === undefined && item.error === undefined) return unknown('Malformed Codex MCP item');
    const result = object(item.result);
    const failed = (item.status === 'failed' || item.status === 'declined') || item.error != null || result?.isError === true;
    return pair(`${server}.${tool}`, item.arguments, item.error ?? item.result, failed);
  }
  if (item.type === 'CommandExecution') {
    if (!Array.isArray(item.command) || !item.command.every(v => typeof v === 'string')) return unknown('Malformed Codex command item');
    const output = item.formatted_output ?? item.aggregated_output ?? { stdout: item.stdout, stderr: item.stderr };
    const failed = (item.status === 'failed' || item.status === 'declined') || typeof item.exit_code === 'number' && item.exit_code !== 0;
    return pair('command', { command: item.command, cwd: item.cwd }, output, failed);
  }
  if (item.type === 'FileChange') {
    if (!object(item.changes)) return unknown('Malformed Codex file-change item');
    return pair('file_change', item.changes, { status: item.status, stdout: item.stdout, stderr: item.stderr }, item.status === 'failed' || item.status === 'declined');
  }
  // Unqualified native items (extensions/subagents/etc.) make coverage partial, never vanish as "full".
  return unknown('Unsupported Codex native completed item');
}
