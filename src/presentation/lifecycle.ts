// Model- and human-facing text for the participant lifecycle (M8, docs/PARTICIPANT-LIFECYCLE-SPEC.md §3–4):
// rename and kick outcomes. Pure formatting over the contract shapes; MCP and CLI share it.
import type { KickOutcome, KickProposal, RenameOutcome } from '../contracts/lifecycle.js';

export type Surface = 'mcp' | 'cli';
const KICK = { mcp: 'roundtable_kick', cli: 'roundtable kick' } as const;
const JOIN = { mcp: 'roundtable_join', cli: 'roundtable join --as NAME' } as const;

/** The service short-circuits a rename to the same name: nothing was applied, and the text must say so. */
export function renameNoop(outcome: RenameOutcome): boolean {
  return outcome.oldName === outcome.registration.name;
}

/** A rename result. `self` is whether the caller renamed its own binding (the agent path). */
export function renameText(outcome: RenameOutcome, self: boolean): string {
  if (renameNoop(outcome)) return self ? `"${outcome.registration.name}" is already your name; nothing changed.` : `"${outcome.registration.name}" already has that name; nothing changed.`;
  const lines = [
    self
      ? `You are now "${outcome.registration.name}" (was "${outcome.oldName}"; same session). Others must address "${outcome.registration.name}" from now on; "${outcome.oldName}" no longer resolves.`
      : `Renamed "${outcome.oldName}" to "${outcome.registration.name}" (same session). Everyone must address "${outcome.registration.name}" from now on.`,
  ];
  lines.push(
    outcome.relabeled === 0
      ? 'No queued deliveries needed relabelling.'
      : `${outcome.relabeled} queued deliver${outcome.relabeled === 1 ? 'y' : 'ies'} relabelled to the new name (same session; nothing was resent). Earlier messages keep the old name as history.`,
  );
  lines.push(
    outcome.noticeId === null
      ? 'No room notice was posted.'
      : self
        ? 'A room notice was posted to the other agents and the human (queued for native delivery); you were not sent one, so your snapshot stays current.'
        : 'A room notice was posted to every agent (the renamed one included) and the human, queued for native delivery.',
  );
  return lines.join('\n');
}

function ttl(p: KickProposal): string {
  const ms = Date.parse(p.expiresAt) - Date.now();
  if (!Number.isFinite(ms)) return 'an unknown time';
  const m = Math.max(0, Math.round(ms / 60_000));
  return m === 0 ? 'less than a minute' : `about ${m} minute${m === 1 ? '' : 's'}`;
}

function roster(p: KickProposal): string {
  const voted = p.voters.filter((v) => v.votedAt !== null).map((v) => v.name);
  const waiting = p.voters.filter((v) => v.votedAt === null).map((v) => v.name);
  const out = [`Voters (fixed when it opened): ${p.voters.map((v) => v.name).join(', ') || 'none'}.`];
  out.push(`Voted: ${voted.join(', ') || 'nobody yet'}. Still needed: ${waiting.join(', ') || 'nobody'}.`);
  if (p.excluded.length) out.push(`Not voting (not qualified when it opened): ${p.excluded.map((e) => `${e.name} (${EXCLUSION[e.reason]})`).join(', ')}.`);
  return out.join('\n');
}

/** Per-reason wording: only unknown and stale carry the "not presumed offline" caveat; offline was observed. */
const EXCLUSION: Record<KickProposal['excluded'][number]['reason'], string> = {
  offline: 'observed offline',
  rebind_needed: 'rebind needed',
  unknown: 'status unknown, not presumed offline',
  stale: 'liveness stale, not presumed offline',
};

/** A kick result: an open proposal with this caller's vote disposition, or an executed removal. */
export function kickText(outcome: KickOutcome, surface: Surface = 'mcp'): string {
  if (outcome.status === 'executed') {
    const lines = [`Removed "${outcome.removed.name}" from the room (${outcome.vote === 'human' ? 'by the human' : 'by unanimous consent'}).`];
    if (outcome.proposal) lines.push(`Reason: ${outcome.proposal.reason}. Voters: ${outcome.proposal.voters.map((v) => v.name).join(', ')}.`);
    lines.push(
      outcome.cancelled === 0
        ? 'No queued deliveries had to be cancelled.'
        : `${outcome.cancelled} queued deliver${outcome.cancelled === 1 ? 'y' : 'ies'} to it cancelled, shown as withdrawn (kicked); nothing redirected.`,
    );
    lines.push(`Its session was not touched; it can rejoin with ${JOIN[surface]}, and its return appears in roundtable who and the TUI.${outcome.noticeId === null ? ' No room notice was posted.' : ' A room notice was posted.'}`);
    return lines.join('\n');
  }
  const p = outcome.proposal;
  const head = {
    recorded: `Your vote to remove "${p.target.name}" is recorded.`,
    already_recorded: `Your vote to remove "${p.target.name}" was already recorded; nothing changed.`,
    not_a_voter: `You are not a voter on this proposal (the voter list was fixed when it opened), so nothing changed.`,
    target: `You are the target of this proposal; you have no vote, and nothing changed. You can reply in the room.`,
  }[outcome.vote];
  const lines = [head, `Proposal to remove "${p.target.name}": ${p.reason}`, roster(p)];
  const needed = p.voters.filter((v) => v.votedAt === null).length;
  lines.push(
    needed === 0
      ? 'Every voter has agreed; the removal executes now.'
      : `It executes when every remaining voter calls ${KICK[surface]} for "${p.target.name}"; otherwise it expires in ${ttl(p)} with no effect.`,
  );
  return lines.join('\n');
}
