// Claude Code delivery adapter (task 2.2): the only path the dispatcher uses to reach a Claude session.
import { createHash } from 'node:crypto';
import type { DeliveryAdapter, LivenessProbe, SubmitRequest, SubmitResult } from '../../contracts/adapter.js';
import type { Activity, TargetSnapshot } from '../../contracts/domain.js';
import type { RoomConfig } from '../../core/config.js';
import { lookupSession, readPeerToken, type ClaudeRegistryDeps, type ClaudeSessionRecord } from './registry.js';
import { sendToPipe, type PipeSendOptions, type PipeSendOutcome } from './pipe.js';

export interface ClaudeAdapterOptions {
  registry: ClaudeRegistryDeps;
  maxEnvelopeChars: number;
  timeoutMs: number;
  settleMs: number;
  /** Sender label the receiving model sees. */
  from: string;
  /** Injectable for tests; defaults to the real pipe client. */
  send?: (opts: PipeSendOptions) => Promise<PipeSendOutcome>;
}

export function claudeAdapterOptionsFrom(config: RoomConfig, registry: ClaudeRegistryDeps): ClaudeAdapterOptions {
  return {
    registry,
    maxEnvelopeChars: config.claudeMaxEnvelopeChars,
    timeoutMs: config.adapterTimeoutMs,
    settleMs: config.claudeSubmitSettleMs,
    from: 'agent-roundtable',
  };
}

export class ClaudeAdapter implements DeliveryAdapter {
  readonly harness = 'claude' as const;
  readonly maxEnvelopeChars: number;
  private readonly send: (opts: PipeSendOptions) => Promise<PipeSendOutcome>;

  constructor(private readonly options: ClaudeAdapterOptions) {
    this.maxEnvelopeChars = options.maxEnvelopeChars;
    this.send = options.send ?? sendToPipe;
  }

  async submit(request: SubmitRequest): Promise<SubmitResult> {
    if (request.target.harness !== 'claude') {
      return { status: 'failed', error: { code: 'bad_request', message: `Claude adapter cannot deliver to a ${request.target.harness} target` } };
    }
    if (request.envelope.length > this.maxEnvelopeChars) {
      // The core must apply the reference fallback before calling us; refuse rather than truncate (invariant 9).
      return {
        status: 'failed',
        error: { code: 'message_too_large', message: `envelope is ${request.envelope.length} chars; Claude limit is ${this.maxEnvelopeChars}` },
      };
    }
    const lookup = await lookupSession(request.target.sessionId, this.options.registry);
    if (lookup.status === 'absent') return { status: 'unavailable', reason: 'offline', detail: lookup.detail };
    if (lookup.status === 'stale') return { status: 'unavailable', reason: 'rebind_needed', detail: lookup.detail };
    if (lookup.status === 'error') {
      return { status: 'failed', error: { code: 'internal', message: lookup.detail, hint: 'Check access to the Claude config directory, then retry.' } };
    }
    // An unverified start time still proceeds: the pipe name belongs to that session, so a reused pid cannot
    // serve it — the worst case is a connect failure (`failed`), never delivery to the wrong session.
    const { record } = lookup;
    const token = await readPeerToken(record, this.options.registry);
    if (token === null) {
      return {
        status: 'failed',
        error: {
          code: 'internal',
          message: `Claude session ${record.sessionId} publishes no messaging key`,
          hint: 'The session may be starting up or shutting down; retry once it is running.',
        },
      };
    }
    const outcome = await this.send({
      pipePath: record.messagingSocketPath,
      token,
      msgId: stableMsgId(request.messageId, request.recipient),
      content: request.envelope,
      from: this.options.from,
      priority: 'next',
      timeoutMs: this.options.timeoutMs,
      settleMs: this.options.settleMs,
    });
    switch (outcome.kind) {
      case 'written':
        return { status: 'submitted', evidence: { kind: 'claude-pipe-write', pid: record.pid } };
      case 'failed':
        return { status: 'failed', error: { code: 'internal', message: `Claude pipe delivery failed: ${outcome.reason}` } };
      case 'uncertain':
        return {
          status: 'uncertain',
          error: {
            code: 'internal',
            message: `Claude pipe delivery uncertain: ${outcome.reason}`,
            hint: 'The message may already have been delivered. Check the recipient before retrying.',
          },
        };
    }
  }

  async probe(target: TargetSnapshot): Promise<LivenessProbe> {
    const lookup = await lookupSession(target.sessionId, this.options.registry);
    if (lookup.status === 'absent') return { liveness: 'offline', activity: 'unknown', detail: lookup.detail };
    if (lookup.status === 'stale') return { liveness: 'rebind_needed', activity: 'unknown', detail: lookup.detail };
    if (lookup.status === 'error') return { liveness: 'unknown', activity: 'unknown', detail: lookup.detail };
    if (!lookup.verified) return { liveness: 'unknown', activity: activityOf(lookup.record), detail: 'process start time could not be verified' };
    return { liveness: 'online', activity: activityOf(lookup.record) };
  }
}

/** Deterministic UUID-shaped id per (room message, recipient): a re-sent delivery carries the same msg_id. */
export function stableMsgId(messageId: string, recipient: string): string {
  const h = createHash('sha256').update(`vibe-pairing\0${messageId}\0${recipient}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

/** Map Claude's registry status to our Activity; anything unrecognized stays `unknown` (invariant 3). */
export function activityOf(record: Pick<ClaudeSessionRecord, 'status' | 'waitingFor'>): Activity {
  if (record.status === 'waiting' && record.waitingFor !== null && /permission/i.test(record.waitingFor)) return 'waiting_permission';
  if (record.status === 'busy') return 'busy';
  if (record.status === 'idle') return 'idle';
  // Observed live (Claude Code 2.1.283, 2026-09-28): a background-job session writes "shell" between turns — it is
  // back at its prompt, i.e. idle. It stayed "busy" through every tool call and flipped to "shell" only at turn end.
  if (record.status === 'shell') return 'idle';
  return 'unknown';
}
