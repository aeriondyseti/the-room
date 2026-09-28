// MCP front-end (ROADMAP 2.4): a thin client of the room service. No store, queue, or wake logic here — every
// tool resolves the caller fresh, forwards one IPC request, and formats the answer for an agent to act on.
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { MessageWithDeliveries, ParticipantState } from '../contracts/domain.js';
import { RoomError, toErrorInfo } from '../contracts/errors.js';
import type { Caller, Method, Params, Result } from '../contracts/ipc.js';
import { formatMessages, guardedSendText, inboxPageText, withdrawText } from '../presentation/crossing.js';
import {deliveryDetail} from '../presentation/delivery.js';
import { VERSION } from '../version.js';
import type { IdentityResult } from './identity.js';

/** What the MCP server needs from a room connection (RoomClient satisfies it). */
export interface RoomLink {
  request<M extends Method>(method: M, params: Params<M>): Promise<Result<M>>;
  onDisconnect?(listener: (reason: Error) => void): () => void;
  close?(): void;
}

export interface RoomMcpOptions {
  connect: () => Promise<RoomLink>;
  /** Resolve the caller for one tool call from its request `_meta`. */
  identify: (meta: Record<string, unknown> | undefined) => Promise<IdentityResult>;
}

const READ_DEFAULT = 20;
const READ_MAX = 100;

export function createRoomMcpServer(options: RoomMcpOptions): McpServer {
  const server = new McpServer({ name: 'vibe-pairing-room', version: VERSION });
  // One shared connection attempt at a time: concurrent first calls await the same promise (no leaked sockets).
  let link: Promise<RoomLink> | null = null;

  const room = (): Promise<RoomLink> => {
    if (link) return link;
    const attempt = options.connect().then(
      (fresh) => {
        fresh.onDisconnect?.(() => {
          if (link === attempt) link = null;
        });
        return fresh;
      },
      (err: unknown) => {
        if (link === attempt) link = null;
        throw err;
      },
    );
    link = attempt;
    return attempt;
  };

  /** Close the room connection (used when the MCP host goes away). */
  (server as McpServer & { closeRoom?: () => void }).closeRoom = () => {
    void link?.then((l) => l.close?.()).catch(() => {});
    link = null;
  };

  const agentCaller = async (meta: Record<string, unknown> | undefined): Promise<{ caller: Caller; note?: string }> => {
    const who = await options.identify(meta);
    if (!who.ok) throw new RoomError(who.code, who.message);
    return { caller: { kind: 'agent', native: who.native, declaredName: null }, ...(who.note ? { note: who.note } : {}) };
  };

  server.registerTool(
    'room_send',
    {
      title: 'Send a room message',
      description:
        'Send a message to the room. It is delivered natively to each recipient (their session wakes up by itself) and ' +
        'the human sees every message. Address recipients explicitly: an agent name, several names, "human" for Kevin, ' +
        'or "all" (every other participant). When answering a message, pass its id (or #number) as reply_to so the sender ' +
        'sees it as answered.\n' +
        'Crossing guard: pass snapshot, the token from your latest room_inbox result or from the delivery you are ' +
        'answering. If anything addressed to you is not covered by it, the message is NOT sent: the result shows what ' +
        'you missed plus a fresh snapshot. Read it, revise if needed, and send again with that snapshot and ' +
        'revises_attempt_id. Keep your latest snapshot for the next send.\n' +
        'urgent (with a reason) sends without the check and ahead of the recipient\'s not-yet-delivered messages. Use it ' +
        'only for time-critical messages; it is audited and shown as URGENT. It never interrupts a turn already in progress.',
      inputSchema: {
        to: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe('Recipient name(s): "astra", "astra, claude", ["astra","claude"], "human", or "all". Omit only when reply_to is supplied; defaults to that message\'s sender.'),
        text: z.string({ error: 'Provide the message body as a string in the text field.' }).min(1, 'Provide a non-empty message in the text field.').describe('Message content (markdown/plain text). Put the message body in this text field.'),
        reply_to: z.string().optional().describe('Message id or #number you are replying to.'),
        snapshot: z.string().optional().describe('Your latest inbox snapshot token (from room_inbox, a not-sent result, or the delivery you are answering).'),
        urgent: z.boolean().optional().describe('Send without the snapshot check, ahead of queued ordinary messages. Requires reason.'),
        reason: z.string().optional().describe('Why this is urgent (required with urgent; shown to the recipient and the human).'),
        revises_attempt_id: z.string().optional().describe('The attempt id from a NOT SENT result that this message replaces.'),
        client_message_id: z
          .string()
          .optional()
          .describe('Optional idempotency key; reuse it when retrying the same message so it is never sent twice.'),
      },
      // Not idempotent unless the caller reuses client_message_id.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, extra) =>
      guard(async () => {
        const reason = args.reason?.trim() ?? '';
        if (args.urgent && !reason) throw new RoomError('bad_request', 'An urgent send needs a reason.', 'Add reason: why this cannot wait, or drop urgent and send with your snapshot.');
        if (!args.urgent && reason) throw new RoomError('bad_request', 'reason is only used with urgent: true.', 'Set urgent: true, or remove reason.');
        const { caller, note } = await agentCaller(extra._meta as Record<string, unknown> | undefined);
        const r = await room();
        const replyTo = args.reply_to ? await resolveMessageRef(r, args.reply_to) : null;
        let to: string[];
        if(args.to!==undefined)to=parseRecipients(args.to);
        else if(replyTo){
          const original=(await r.request('read',{messageId:replyTo})).items[0];
          if(!original)throw new RoomError('not_found','The message being replied to no longer exists.');
          to=[original.message.from.name];
        }else throw new RoomError('no_recipients','Provide to, or reply_to to address the original sender.');
        const outcome = await r.request('guarded_send', {
          caller,
          to,
          body: args.text,
          replyTo,
          clientMessageId: args.client_message_id ?? randomUUID(),
          ...(args.snapshot !== undefined ? { snapshot: args.snapshot } : {}),
          ...(args.urgent ? { urgent: { reason } } : {}),
          ...(args.revises_attempt_id !== undefined ? { revisesAttemptId: args.revises_attempt_id } : {}),
        });
        if (outcome.status === 'not_sent') {
          // Not a transport failure, but the send did not happen: flag it so the model cannot mistake it for success.
          return { isError: true, content: [{ type: 'text', text: guardedSendText(outcome) + (note ? `\nNote: ${note}` : '') }] };
        }
        const extraText = guardedSendText(outcome);
        return text(sendSummary(outcome.result, note) + (extraText ? `\n${extraText}` : ''));
      }),
  );

  server.registerTool(
    'room_inbox',
    {
      title: 'Review your inbox',
      description:
        'Messages addressed to you that your snapshot does not cover yet, oldest first, plus a new snapshot token that ' +
        'covers what it returned. Pass your latest snapshot to get only what is new; without one you get everything ' +
        'addressed to you. If the result says Incomplete, call again with the given cursor and snapshot. Use the final ' +
        'snapshot with room_send.',
      inputSchema: {
        snapshot: z.string().optional().describe('Your latest snapshot token; omit to review from the start.'),
        cursor: z.string().optional().describe('The cursor from an Incomplete result, to continue it.'),
        limit: z.number().int().min(1).max(READ_MAX).optional().describe(`Most items to return (max ${READ_MAX}); the room also caps by size.`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      guard(async () => {
        const { caller, note } = await agentCaller(extra._meta as Record<string, unknown> | undefined);
        const r = await room();
        const page = await r.request('inbox', {
          caller,
          ...(args.snapshot !== undefined ? { snapshot: args.snapshot } : {}),
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
        return text(inboxPageText(page) + (note ? `\nNote: ${note}` : ''));
      }),
  );

  server.registerTool(
    'room_withdraw',
    {
      title: 'Withdraw a message you sent',
      description:
        'Cancel a message you sent, for recipients whose session has not been handed it yet. Once a recipient\'s session ' +
        'has accepted it, it is too late: that recipient is reported as not withdrawn. The human sees messages as soon ' +
        'as they are sent, so a withdraw never hides it from them. The message stays in history, marked withdrawn.',
      inputSchema: {
        message_id: z.string().describe('The id or #number of your message.'),
        recipients: z.union([z.string(), z.array(z.string())]).optional().describe('Only these recipients (default: all original recipients).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args, extra) =>
      guard(async () => {
        const { caller, note } = await agentCaller(extra._meta as Record<string, unknown> | undefined);
        const r = await room();
        const messageId = await resolveMessageRef(r, args.message_id);
        const seqMatch = /^#?(\d+)$/.exec(args.message_id.trim());
        const outcome = await r.request('withdraw', {
          caller,
          messageId,
          ...(args.recipients !== undefined ? { recipients: parseRecipients(args.recipients) } : {}),
        });
        return text(withdrawText(outcome, seqMatch ? Number(seqMatch[1]) : undefined) + (note ? `\nNote: ${note}` : ''));
      }),
  );
  server.registerTool(
    'room_read',
    {
      title: 'Read room messages',
      description:
        'Read recent room messages (newest last), messages after a given #number, or one message in full by id/#number. ' +
        'This is history only: to review messages addressed to you before replying (including a long message a delivery ' +
        'only previewed), use room_inbox, which is what your snapshot covers.',
      inputSchema: {
        message_id: z.string().optional().describe('A message id or #number to fetch in full.'),
        after: z.number().int().nonnegative().optional().describe('Only messages after this #number.'),
        limit: z.number().int().min(1).max(READ_MAX).optional().describe(`How many (default ${READ_DEFAULT}, max ${READ_MAX}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      guard(async () => {
        const r = await room();
        if (args.message_id) {
          const id = await resolveMessageRef(r, args.message_id);
          const one = await r.request('read', { messageId: id, includeDeliveries: true });
          if (one.items.length === 0) throw new RoomError('not_found', `No message ${args.message_id}.`);
          return text(formatMessages(one.items, true));
        }
        const res = await r.request('read', {
          afterSeq: args.after ?? null,
          limit: args.limit ?? READ_DEFAULT,
          includeDeliveries: true,
        });
        if (res.items.length === 0) return text(args.after !== undefined ? `No messages after #${args.after}.` : 'The room has no messages yet.');
        const limit = args.limit ?? READ_DEFAULT;
        let more = '';
        if (res.hasMore) {
          // Cursor reads page forward (newer); latest reads have OLDER history before the first item.
          more =
            args.after !== undefined
              ? `\n(newer messages exist: room_read with after=${res.items.at(-1)!.message.seq})`
              : `\n(older messages exist: room_read with after=${Math.max(0, res.items[0]!.message.seq - 1 - limit)} limit=${limit})`;
        }
        return text(formatMessages(res.items, false) + more);
      }),
  );

  server.registerTool(
    'room_who',
    {
      title: 'List room participants',
      description: 'List the participants (agents and the human) with their harness, liveness, activity and queued deliveries.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const r = await room();
        const who = await r.request('who', {});
        return text(formatWho(who.participants, who.room.paused));
      }),
  );

  server.registerTool(
    'room_join',
    {
      title: 'Join the room',
      description:
        'Register this session in the room under a name (lowercase letters, digits, - or _). Run once per session. ' +
        'If your session changed (e.g. after /clear or a new thread) and your name is still bound to the old one, ' +
        'call again with rebind: true.',
      inputSchema: {
        name: z.string().describe('Your participant name, e.g. "claude" or "astra".'),
        rebind: z.boolean().optional().describe('Move an existing name to this session.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      guard(async () => {
        const who = await options.identify(extra._meta as Record<string, unknown> | undefined);
        if (!who.ok) throw new RoomError(who.code, who.message);
        const r = await room();
        let expectedPrevious: { harness: 'claude' | 'codex'; sessionId: string } | null = null;
        if (args.rebind) {
          const current = (await r.request('who', {})).participants.find((p) => p.name === args.name);
          if (current && current.sessionId !== who.native.sessionId) {
            // A rebind moves YOUR name to your new session; it must never take over someone else's live name.
            if (current.harness !== who.native.harness) {
              throw new RoomError('rebind_conflict', `"${args.name}" belongs to a ${current.harness} session; a ${who.native.harness} session can't take it over.`, 'Pick a different name.');
            }
            if (current.liveness === 'online') {
              throw new RoomError('rebind_conflict', `"${args.name}" is bound to a session that is still online.`, 'If that is really your old session, close it first; otherwise pick a different name.');
            }
            expectedPrevious = { harness: current.harness, sessionId: current.sessionId };
          }
        }
        const res = await r.request('join', { name: args.name, native: who.native, expectedPrevious });
        const verb = res.created ? 'Joined' : res.rebound ? 'Rebound' : 'Already joined';
        return text(`${verb} as "${res.registration.name}" (${res.registration.harness}). Others can now reach you with to: "${res.registration.name}".${who.note ? `\nNote: ${who.note}` : ''}`);
      }),
  );

  return server;
}

// ---- helpers ------------------------------------------------------------------------------------------------

async function guard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (err) {
    const info = toErrorInfo(err);
    return { isError: true, content: [{ type: 'text', text: `${info.code}: ${info.message}${info.hint ? `\nWhat to do: ${info.hint}` : ''}` }] };
  }
}

function text(s: string): CallToolResult {
  return { content: [{ type: 'text', text: s }] };
}

export function parseRecipients(to: string | string[]): string[] {
  const list = (Array.isArray(to) ? to : to.split(/[,\s]+/)).map((s) => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
  if (list.length === 0) throw new RoomError('no_recipients', 'No recipients given.');
  return list.includes('all') ? ['all'] : [...new Set(list)];
}

/** Accept a message id or `#N`/`N` (resolved through `read`). */
async function resolveMessageRef(r: RoomLink, ref: string): Promise<string> {
  const m = /^#?(\d+)$/.exec(ref.trim());
  if (!m) return ref.trim();
  const seq = Number(m[1]);
  const res = await r.request('read', { afterSeq: seq - 1, limit: 1 });
  const hit = res.items.find((i) => i.message.seq === seq);
  if (!hit) throw new RoomError('not_found', `No message #${seq}.`);
  return hit.message.id;
}

function sendSummary(result: MessageWithDeliveries & { deduplicated: boolean }, note: string | undefined): string {
  const { message, deliveries } = result;
  const states = deliveries.map((d) => `${d.recipient} ${deliveryDetail(d)}`);
  const lines = [
    result.deduplicated
      ? `Already sent as #${message.seq} (this retry was recognised; nothing was sent twice).`
      : `Sent #${message.seq} (id ${message.id}) to ${message.to.join(', ') || 'no agents'}.`,
  ];
  if (states.length) lines.push(`Delivery: ${states.join('; ')}.`);
  if (note) lines.push(`Note: ${note}`);
  return lines.join('\n');
}

function formatWho(participants: ParticipantState[], paused: boolean): string {
  const lines = participants.map((p) => {
    const status = p.liveness === 'online' ? p.activity : p.liveness.replace('_', ' ');
    return `- ${p.name} (${p.harness}): ${status}${p.pending ? `, ${p.pending} queued` : ''}`;
  });
  return [`Participants (${participants.length})${paused ? ' — the room is PAUSED; deliveries are held' : ''}:`, ...lines, '- human: Kevin (address as "human")'].join('\n');
}
