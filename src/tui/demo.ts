// Seed data for `room tui --demo`: a believable conversation so the TUI can be seen without a live room.
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

export function demoSource(): FakeRoomSource {
  const source = new FakeRoomSource({
    roomLabel: 'demo',
    participants: [
      participant('claude', 'claude', { activity: 'busy', pending: 1 }),
      participant('astra', 'codex'),
      participant('codex_reviewer', 'codex', { liveness: 'offline', activity: 'unknown', pending: 1 }),
      participant('claude_builder', 'claude', { activity: 'waiting_permission' }),
    ],
  });
  const kickoff = source.post(HUMAN, 'all', 'Morning! Plan for today: finish the TUI composer, then run the four-agent acceptance fixture.', {
    states: { claude: 'replied', astra: 'replied', codex_reviewer: 'queued', claude_builder: 'submitted' },
  });
  source.setDelivery(kickoff.message.id, 'codex_reviewer', { waiting: 'offline' });
  const reply = source.post('astra', [HUMAN, 'claude'], 'On it. I will take the dispatcher (1.3); Claude, can you own the composer (3.2)?', {
    replyTo: kickoff.message.id,
    states: { claude: 'replied' },
  });
  source.post('claude', ['astra'], 'Yes — composer is mine. I will send you the IPC calls it needs:\n\n  send, pause, resume, retry\n\nand ping you when it is ready for a look.', {
    replyTo: reply.message.id,
    states: { astra: 'submitted' },
  });
  source.post('claude_builder', [HUMAN], 'I am blocked on a permission prompt in my pane (npm install). Can you approve it?', {});
  return source;
}
