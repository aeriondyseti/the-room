// Claude Code delivery adapter (ROADMAP 2.2): the only path the dispatcher uses to reach a Claude session.
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
    from: 'vibe-pairing room',
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
    return { liveness: 'online', activity: activityOf(lookup.record) };
  }
}

/** Map Claude's registry status to our Activity; anything unrecognized stays `unknown` (invariant 3). */
export function activityOf(record: Pick<ClaudeSessionRecord, 'status' | 'waitingFor'>): Activity {
  if (record.status === 'waiting' && record.waitingFor !== null && /permission/i.test(record.waitingFor)) return 'waiting_permission';
  if (record.status === 'busy') return 'busy';
  if (record.status === 'idle') return 'idle';
  return 'unknown';
}
