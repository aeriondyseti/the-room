// Delivery detail overlay (ROADMAP 3.3): everything the room knows about one message's per-recipient delivery —
// state, target session, reply link, and every attempt with its evidence or error. Honest by construction:
// it only renders fields the service reported.
import React from 'react';
import { Box, Text } from 'ink';
import type { Delivery, DeliveryAttempt, MessageWithDeliveries, SubmitEvidence } from '../contracts/domain.js';
import { colorFor, deliveryMark, displayName, formatTime, sanitize, wrapText } from './format.js';

export interface DetailProps {
  item: MessageWithDeliveries;
  humanName: string;
  seqById: ReadonlyMap<string, number>;
  width: number;
}

export function DeliveryDetail({ item, humanName, seqById, width }: DetailProps) {
  const { message } = item;
  const preview = wrapText(message.body, Math.max(10, width - 4)).slice(0, 3);
  const more = wrapText(message.body, Math.max(10, width - 4)).length > 3;
  const retryable = item.deliveries.filter((d) => d.state === 'failed' || d.state === 'uncertain');
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text wrap="truncate">
        <Text bold>Message #{message.seq}</Text>
        <Text dimColor> · {formatTime(message.createdAt)} · from </Text>
        <Text color={colorFor(message.from.name)} bold>{sanitize(displayName(message.from.name, humanName))}</Text>
        <Text dimColor> ({message.from.identity.mode})</Text>
      </Text>
      {preview.map((l, i) => (
        <Text key={i} dimColor wrap="truncate">  {l}{i === preview.length - 1 && more ? ' …' : ''}</Text>
      ))}
      <Text> </Text>
      {item.deliveries.length === 0 ? (
        <Text dimColor>No agent deliveries (a log-only message).</Text>
      ) : (
        item.deliveries.map((d) => <DeliveryBlock key={d.recipient} d={d} humanName={humanName} seqById={seqById} />)
      )}
      <Text> </Text>
      {retryable.length > 0 && (
        <Text color="cyan" wrap="truncate">
          {retryable.map((d) => `/retry #${message.seq} @${d.recipient}`).join('  ·  ')} to re-send
          {retryable.some((d) => d.state === 'uncertain') ? ' (uncertain ones may already have arrived)' : ''}
        </Text>
      )}
      <Text dimColor>Esc to close</Text>
    </Box>
  );
}

function DeliveryBlock({ d, humanName, seqById }: { d: Delivery; humanName: string; seqById: ReadonlyMap<string, number> }) {
  const mark = deliveryMark(d);
  const replied = d.repliedBy ? seqById.get(d.repliedBy) : undefined;
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text wrap="truncate">
        <Text color={mark.color}>{mark.glyph} </Text>
        <Text color={colorFor(d.recipient)} bold>{sanitize(displayName(d.recipient, humanName))}</Text>
        <Text color={mark.color}> {mark.label}</Text>
        <Text dimColor>  → {d.target.harness} {shortId(d.target.sessionId)}</Text>
        {d.repliedBy && <Text dimColor>  ↩ replied in {replied !== undefined ? `#${replied}` : 'a later message'}</Text>}
      </Text>
      {d.held && <Text color="yellow">    held while the room is paused</Text>}
      {d.waiting === 'offline' && <Text color="yellow">    waiting — the agent's session isn't running</Text>}
      {d.waiting === 'rebind_needed' && <Text color="yellow">    waiting — the agent needs to re-join (its session changed)</Text>}
      {d.referenced && <Text dimColor>    sent as a preview + `room read` reference (too long for this harness)</Text>}
      {d.attempts.length === 0 ? (
        <Text dimColor>    no attempts yet</Text>
      ) : (
        d.attempts.map((a) => <AttemptLine key={a.n} a={a} />)
      )}
    </Box>
  );
}

function AttemptLine({ a }: { a: DeliveryAttempt }) {
  const color = a.outcome === 'submitted' ? 'cyan' : a.outcome === 'failed' ? 'red' : a.outcome === 'uncertain' ? 'magenta' : 'gray';
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        <Text dimColor>    attempt {a.n} · {formatTime(a.startedAt)} </Text>
        <Text color={color}>{a.outcome === 'in_flight' ? 'in flight' : a.outcome}</Text>
        {a.evidence && <Text dimColor>  ({evidenceText(a.evidence)})</Text>}
      </Text>
      {a.error && (
        <Text color={color} wrap="truncate">
          {'      '}
          {sanitize(a.error.message)}
          {a.error.hint ? <Text dimColor> — {sanitize(a.error.hint)}</Text> : null}
        </Text>
      )}
    </Box>
  );
}

export function evidenceText(e: SubmitEvidence): string {
  return e.kind === 'codex-queue' ? `codex queue${e.nativeId ? ` ${shortId(e.nativeId)}` : ''}` : `pipe write to pid ${e.pid}`;
}

function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…` : id;
}
