// Seed data for `roundtable tui --demo`: a believable conversation so the TUI can be seen without a live room.
import { HUMAN, type ParticipantState } from '../contracts/domain.js';
import { FakeRoomSource } from './fake-source.js';

const participant = (name: string, harness: 'claude' | 'codex', over: Partial<ParticipantState> = {}): ParticipantState => ({
  name,
  harness,
  sessionId: `${name}-session`,
  liveness: 'online',
  livenessCheckedAt: null,
  activity: 'idle',
  pending: 0,
  usage: null,
  ...over,
});

const usage = (percent: number | null, used: number, status: 'ok' | 'stale' = 'ok'): ParticipantState['usage'] => ({
  source: 'claude-transcript',
  status,
  observedAt: new Date().toISOString(),
  cumulative: { input: used, output: Math.round(used / 20), cacheRead: 0, cacheWrite: 0 },
  context: { usedTokens: used, limitTokens: percent === null ? null : Math.round(used / (percent / 100)), percent },
});

export function demoSource(): FakeRoomSource {
  const source = new FakeRoomSource({
    roomLabel: 'demo',
    participants: [
      participant('claude', 'claude', { activity: 'busy', pending: 1, usage: usage(54, 540_000) }),
      participant('astra', 'codex', { usage: usage(43, 146_000) }),
      participant('codex_reviewer', 'codex', { liveness: 'offline', activity: 'unknown', pending: 1, usage: usage(12, 41_000, 'stale') }),
      participant('claude_builder', 'claude', { activity: 'waiting_permission', usage: usage(88, 880_000) }),
    ],
  });
  const now = Date.now();
  const at = (h: number) => new Date(now + h * 3_600_000).toISOString();
  source.setAccounts([
    {
      account: { harness: 'claude', scope: 'profile', key: 'demo-claude', sourceKey: 'demo-claude' },
      buckets: [
        { id: 'claude', windows: [
          { kind: 'five_hour', durationMinutes: 300, usedPercent: 38, resetsAt: at(2.2) },
          { kind: 'seven_day', durationMinutes: 10_080, usedPercent: 71, resetsAt: at(80) },
        ] },
        { id: 'claude-fable', label: 'Fable', windows: [{ kind: 'seven_day_fable', durationMinutes: 10_080, usedPercent: 22, resetsAt: at(80) }] },
      ],
      status: 'ok', source: 'claude statusline tap', checkedAt: at(0), observedAt: at(0),
    },
    {
      account: { harness: 'codex', scope: 'account', key: 'demo-codex', sourceKey: 'demo-codex' },
      plan: 'pro',
      buckets: [{ id: 'codex', windows: [
        { kind: 'secondary', durationMinutes: 300, usedPercent: null, resetsAt: null, reason: 'Codex reports no 5h window for this plan' },
        { kind: 'primary', durationMinutes: 10_080, usedPercent: 16, resetsAt: at(120) },
      ] }],
      status: 'ok', source: 'codex account/rateLimits/read', checkedAt: at(0), observedAt: at(0),
    },
  ]);
  const kickoff = source.post(HUMAN, 'all', 'Morning! Plan for today: finish the TUI composer, then run the four-agent acceptance fixture.', {
    states: { claude: 'replied', astra: 'replied', codex_reviewer: 'queued', claude_builder: 'submitted' },
  });
  source.setDelivery(kickoff.message.id, 'codex_reviewer', { waiting: 'offline' });
  const reply = source.post('astra', [HUMAN, 'claude'], 'On it. I will take the dispatcher (1.3); Claude, can you own the composer (3.2)?', {
    replyTo: kickoff.message.id,
    states: { claude: 'replied' },
  });
  source.post('claude', ['astra'], 'Yes — composer is mine. These are the IPC calls it needs:\n\n```ts\nawait source.request(\'send\', { to, body, clientMessageId });\nawait source.request(\'pause\', { stopRequestBody: null });\n```\n\nI will ping you when it is ready for a look.', {
    replyTo: reply.message.id,
    states: { astra: 'submitted' },
  });
  source.post('claude_builder', [HUMAN], 'I am blocked on a permission prompt in my pane (npm install). Can you approve it?', {});
  const handoff = source.post(HUMAN, ['astra', 'claude'], 'Heads up: the service restarts in five minutes for an upgrade.', {
    states: { astra: 'uncertain', claude: 'submitted' },
  });
  const t = handoff.message.createdAt;
  source.setDelivery(handoff.message.id, 'astra', {
    attempts: [
      {
        n: 1,
        startedAt: t,
        finishedAt: t,
        outcome: 'uncertain',
        evidence: null,
        runtimeContext: { harness: 'codex', executable: 'C:\\Users\\you\\.codex\\bin\\codex.exe', home: 'C:\\Users\\you\\.codex' },
        error: { code: 'internal', message: 'codex queue timed out after the message was handed over', hint: 'It may already have arrived; check before retrying.' },
      },
    ],
  });
  source.setDelivery(handoff.message.id, 'claude', {
    attempts: [{ n: 1, startedAt: t, finishedAt: t, outcome: 'submitted', evidence: { kind: 'claude-pipe-write', pid: 32064 }, error: null }],
  });
  return source;
}
