import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GitInfo, WorkspaceInfo } from '../contracts/workspace.js';
import type { ParticipantState } from '../contracts/domain.js';
import { lineText, relativeTime } from './format.js';
import { gitLabel, participantChip, shortModel, workspaceDetail } from './topbar.js';

const git = (over: Partial<GitInfo> = {}): GitInfo => ({ status: 'ok', root: 'X:/repo', worktree: null, branch: 'sprint/6.7', detached: false, head: 'a1b2c3d4e5f6',
  dirty: 3, staged: 2, modified: 2, untracked: 1, ahead: 1, behind: 0, checkedAt: '2026-09-28T16:00:00Z', ...over });
const ws = (over: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({ model: 'claude-opus-5-5', cwd: 'X:/repo/.claude/worktrees/sprint-6.7', cwdSource: 'claude-transcript', git: git(), observedAt: '2026-09-28T16:00:00Z', ...over });
const agent = (over: Partial<ParticipantState> = {}): ParticipantState => ({ name: 'claude', harness: 'claude', sessionId: 's', liveness: 'online', livenessCheckedAt: null, activity: 'busy', pending: 0, usage: null, ...over });

test('chip adds model and branch*dirty (unique count, never the overlapping sum); unknown parts are omitted', () => {
  assert.match(lineText(participantChip(agent({ workspace: ws() }), { stale: false, mono: false })), /● claude busy ctx n\/a · opus-5-5 · sprint\/6\.7\*3$/);
  assert.equal(gitLabel(git({ dirty: 0 })), 'sprint/6.7', 'clean: no star');
  assert.equal(gitLabel(git({ detached: true, branch: null, dirty: 0 })), '@a1b2c3d4e5f6');
  assert.equal(gitLabel(git({ detached: true, branch: null })), '@a1b2c3d4e5f6*3');
  assert.equal(gitLabel(git({ status: 'not_a_repo' })), 'no git');
  assert.equal(gitLabel(git({ status: 'unavailable' })), 'git ?');
  assert.equal(gitLabel(null), null);
  assert.equal(shortModel('gpt-6-astra'), 'gpt-6-astra');
  assert.doesNotMatch(lineText(participantChip(agent(), { stale: false, mono: false })), /·/, 'no workspace → nothing added');
});

test('/who detail says the cwd and its source, worktree, branch and counts in words; unknowns are stated', () => {
  const d0 = ws().observedAt ?? '';
  const d = workspaceDetail(ws({ git: git({ worktree: 'X:/repo/.claude/worktrees/sprint-6.7' }) }));
  assert.equal(d, 'cwd X:/repo/.claude/worktrees/sprint-6.7 (claude-transcript) · worktree X:/repo/.claude/worktrees/sprint-6.7 · branch sprint/6.7 · 2 staged, 2 modified, 1 untracked · ↑1 ↓0 · observed ' + relativeTime(d0));
  assert.equal(workspaceDetail(null), 'workspace not observed');
  assert.match(workspaceDetail(ws({ cwd: null, git: null })), /^cwd unknown · git not sampled · observed /);
  assert.match(workspaceDetail(ws({ git: git({ status: 'unavailable', reason: 'timed out' }) })), /git unavailable \(timed out\)/);
  assert.match(workspaceDetail(ws({ observedAt: null })), /not observed yet$/);
  assert.match(workspaceDetail(ws({ observedAt: '2026-09-28T16:05:00Z' })), /git checked .* · observed /, 'a kept (older) git sample says its own age');
  assert.match(workspaceDetail(ws({ git: git({ ahead: null, behind: null }) })), /untracked · observed /, 'no upstream: no ahead/behind');
});
