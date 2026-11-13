import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeActivityParser, toolName } from './claude-activity.js';

const parse = (value: unknown, detailBytes = 4096) => claudeActivityParser.parse({ value, offset: 0 }, { detailBytes });
const T = '2026-09-28T10:00:00.000Z';

test('tool_use becomes a tool_call with callId and an MCP-friendly name; thinking is never exposed', () => {
  const r = parse({ type: 'assistant', timestamp: T, message: { content: [
    { type: 'thinking', thinking: 'secret plan' },
    { type: 'tool_use', id: 'toolu_1', name: 'mcp__roundtable__roundtable_send', input: { to: ['astra'], text: 'hi' } },
  ] } });
  assert.equal(r.kind, 'items');
  if (r.kind !== 'items') return;
  assert.equal(r.items.length, 1, 'thinking produced nothing');
  const [call] = r.items;
  assert.deepEqual({ kind: call!.kind, tool: call!.tool, callId: call!.callId, at: call!.at }, { kind: 'tool_call', tool: 'roundtable.roundtable_send', callId: 'toolu_1', at: T });
  assert.doesNotMatch(JSON.stringify(r), /secret plan/);
  assert.equal(toolName('Bash'), 'Bash');
});

test('tool_result pairs by tool_use_id, carries is_error, and handles string or block content', () => {
  const r = parse({ type: 'user', timestamp: T, message: { content: [
    { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: [{ type: 'text', text: 'permission denied' }] },
    { type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' },
  ] } });
  assert.equal(r.kind, 'items');
  if (r.kind !== 'items') return;
  assert.deepEqual(r.items.map((i) => [i.kind, i.callId, i.isError ?? false, i.summary]), [
    ['tool_result', 'toolu_1', true, 'error: permission denied'],
    ['tool_result', 'toolu_2', false, 'ok'],
  ]);
});

test('housekeeping, sidechain and unknown types are classified honestly; missing timestamps stay null', () => {
  for (const t of ['queue-operation', 'attachment', 'custom-title', 'cost-state', 'last-prompt']) assert.deepEqual(parse({ type: t }), { kind: 'ignored' });
  assert.deepEqual(parse({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sub' }] } }), { kind: 'ignored' });
  assert.equal(parse({ type: 'brand-new-thing' }).kind, 'unknown');
  assert.equal(parse('nope').kind, 'unknown');
  const r = parse({ type: 'user', message: { content: 'hello' } });
  assert.equal(r.kind === 'items' && r.items[0]!.at, null, 'no fabricated timestamp');
  const end = parse({ type: 'system', subtype: 'turn_duration', timestamp: T });
  assert.equal(end.kind === 'items' && end.items[0]!.kind, 'turn_end');
});

test('terminal controls are neutralised, sensitive fields and token shapes redacted, details capped and labelled', () => {
  const r = parse({ type: 'assistant', timestamp: T, message: { content: [
    { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'echo \u001b[2Jhi', api_key: 'sk-live-abcdefghijklmnopqrstuvwxyz', note: 'x'.repeat(10_000) } },
  ] } }, 256);
  assert.equal(r.kind, 'items');
  if (r.kind !== 'items') return;
  const [call] = r.items;
  const all = JSON.stringify(call);
  assert.doesNotMatch(all, /\u001b/, 'no raw ESC reaches the TUI (JSON args escape it as text)');
  const out = parse({ type: 'user', timestamp: T, message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'done\u001b[2J‮evil' }] } });
  assert.equal(out.kind, 'items');
  if (out.kind === 'items') {
    assert.doesNotMatch(out.items[0]!.summary + (out.items[0]!.detail ?? ''), /[\u001b‮]/, 'raw ESC / bidi in plain text are neutralised');
    assert.match(out.items[0]!.summary, /␛\[2J/);
  }
  assert.doesNotMatch(all, /abcdefghijklmnopqrstuvwxyz/, 'sensitive field value redacted');
  assert.equal(call!.detailTruncated, true);
  assert.ok(Buffer.byteLength(call!.detail ?? '') <= 256);
  assert.ok(call!.summary.length <= 200);
});
