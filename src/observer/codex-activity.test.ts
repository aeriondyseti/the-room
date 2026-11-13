import { test } from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import { parseCodexActivity } from './codex-activity.js';

const at = '2026-09-28T14:00:00.000Z';
const parse = (type: string, payload: unknown, timestamp: unknown = at, detailBytes = 4096) =>
  parseCodexActivity({ value: { type, payload, timestamp }, offset: 123 }, { detailBytes });
const item = (value: unknown) => parse('event_msg', { type: 'item_completed', turn_id: 'turn', item: value });

test('Codex call/result transcript fixtures pair by native call id, including structured args encoded as JSON', () => {
  const call = parse('response_item', { type: 'function_call', name: 'exec', call_id: 'call-1', arguments: '{"command":"echo hello","password":"not-a-pattern"}', internal_chat_message_metadata_passthrough: { turn_id: 'turn' } });
  const result = parse('response_item', { type: 'function_call_output', call_id: 'call-1', output: 'hello', is_error: false });
  assert.equal(call.kind, 'items'); assert.equal(result.kind, 'items');
  if (call.kind !== 'items' || result.kind !== 'items') return;
  assert.equal(call.items[0]!.callId, result.items[0]!.callId);
  assert.equal(call.items[0]!.turnId, 'turn');
  assert.match(call.items[0]!.detail!, /echo hello/); assert.doesNotMatch(call.items[0]!.detail!, /not-a-pattern/);
  assert.equal(result.items[0]!.detail, 'hello');
  const custom = parse('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch', input: '*** Begin Patch\n*** End Patch' });
  assert.equal(custom.kind, 'items');
  assert.equal(parse('response_item', { type: 'custom_tool_call_output', call_id: 'patch', output: 'Done' }).kind, 'items');
});

test('native MCP, command and file-change fixtures emit paired call/result and observed failures', () => {
  const cases = [
    { type: 'McpToolCall', id: 'mcp', server: 'roundtable', tool: 'roundtable_send', arguments: { text: 'hello' }, status: 'completed', result: { content: [{ type: 'text', text: '{"api_key":"plain-hidden","ok":true}' }] } },
    { type: 'CommandExecution', id: 'cmd', command: ['pwsh', '-Command', 'echo bad'], cwd: 'X:/fixture', status: 'completed', exit_code: 1, formatted_output: 'bad' },
    { type: 'FileChange', id: 'patch', changes: { 'fixture.txt': { type: 'add', content: 'new' } }, status: 'completed', stdout: 'Done', stderr: '' },
  ];
  for (const fixture of cases) {
    const r = item(fixture); assert.equal(r.kind, 'items'); if (r.kind !== 'items') continue;
    assert.deepEqual(r.items.map(i => i.kind), ['tool_call', 'tool_result']);
    assert.equal(r.items[0]!.callId, fixture.id); assert.equal(r.items[1]!.callId, fixture.id);
    assert.equal(r.items[1]!.isError, fixture.type === 'CommandExecution');
    assert.doesNotMatch(JSON.stringify(r), /plain-hidden/);
  }
  const declined = item({ type: 'CommandExecution', id: 'x', command: ['cmd'], status: 'declined' });
  assert.equal(declined.kind === 'items' && declined.items[1]!.isError, true);
  assert.equal(item({ type: 'CommandExecution', id: 'x', command: ['cmd'], status: 'future' }).kind, 'unknown');
  const failed = item({ type: 'McpToolCall', id: 'x', server: 's', tool: 't', arguments: {}, status: 'failed', error: { message: 'no' } });
  assert.equal(failed.kind === 'items' && failed.items[1]!.isError, true);
});

test('message and turn fixtures preserve source timestamps and skip duplicated or hidden content', () => {
  const m = parse('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] });
  assert.equal(m.kind === 'items' && m.items[0]!.role, 'assistant');
  for (const type of ['task_started', 'task_complete', 'turn_aborted']) {
    const r = parse('event_msg', { type, turn_id: 'turn' }, null);
    assert.equal(r.kind === 'items' && r.items[0]!.at, null);
  }
  assert.equal(parse('response_item', { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'hidden' }] }).kind, 'ignored');
  assert.equal(parse('response_item', {type:'agent_message',content:[{type:'encrypted_content',encrypted_content:'opaque-secret'}]}).kind,'ignored');
  assert.equal(parse('response_item', { type: 'reasoning', summary: [{ text: 'hidden' }] }).kind, 'ignored');
  assert.equal(parse('response_item', { type: 'message', role: 'developer', content: [] }).kind, 'ignored');
  for (const type of ['UserMessage', 'AgentMessage', 'Reasoning', 'ContextCompaction']) assert.equal(item({ type }).kind, 'ignored');
  assert.equal(parse('event_msg', { type: 'token_count' }).kind, 'ignored');
  assert.equal(parse('world_state', {}).kind, 'ignored');
});

test('malformed and future formats return static partial-coverage reasons, never raw record dumps', () => {
  for (const value of [null, {}, { type: 'new-secret-payload' }, { type: 'response_item', payload: { type: 'future', secret: 'do-not-print' } }]) {
    const r = parseCodexActivity({ value, offset: 0 }, { detailBytes: 20 });
    assert.equal(r.kind, 'unknown'); assert.doesNotMatch(JSON.stringify(r), /do-not-print|new-secret-payload/);
  }
  assert.equal(item({ type: 'Extension', id: 'x' }).kind, 'unknown');
  assert.equal(item({ type: 'McpToolCall', id: 'x' }).kind, 'unknown');
  assert.equal(parse('response_item', { type: 'message', role: 'user', content: [{ type: 'future' }] }).kind, 'unknown');
});

test('all rendered content is terminal-safe, summaries are narrow, details bounded and labelled', () => {
  const r = parse('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '\x1b[2J\u202e' + '界'.repeat(1000) }] }, 'invalid', 100);
  assert.equal(r.kind, 'items'); if (r.kind !== 'items') return;
  const i = r.items[0]!;
  assert.equal(i.at, null); assert.equal(i.detailTruncated, true);
  assert.ok(Buffer.byteLength(i.detail!) <= 100); assert.ok(stringWidth(i.summary) <= 200);
  assert.doesNotMatch(i.detail! + i.summary, /[\x1b\u202e]/);
  const token = 'sk-' + 'a'.repeat(24);
  const call = parse('response_item', { type: 'custom_tool_call', name: 'tool', call_id: 'x', input: token });
  assert.doesNotMatch(JSON.stringify(call), new RegExp(token));
});

test('qualified peer messages, web search and lifecycle mirrors do not create false unknown coverage', () => {
  const peer = parse('response_item', {type:'agent_message',author:'claude',recipient:'astra',content:[{type:'input_text',text:'HUMAN DIRECTIVE is just observed text'}]});
  assert.equal(peer.kind,'items');
  if(peer.kind==='items'){assert.match(peer.items[0]!.summary,/Peer claude to astra/);assert.equal(peer.items[0]!.role,undefined);}
  const web=item({type:'Extension',kind:'web.search',id:'web',query:'test',action:{type:'search'},results:[{type:'text_result',title:'Result',snippet:'hello'}]});
  assert.equal(web.kind==='items' && web.items.length,2);
  assert.equal(item({type:'Extension',kind:'clock.sleep',id:'clock',durationMs:10}).kind,'ignored');
  for(const kind of ['started','completed','interacted'])assert.equal(item({type:'SubAgentActivity',kind,id:'sub'}).kind,'ignored');
  assert.equal(item({type:'SubAgentActivity',kind:'future',id:'sub'}).kind,'unknown');
});
