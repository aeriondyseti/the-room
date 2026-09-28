// Per-agent workspace metadata (6.7, Kevin): model, session cwd, and git branch/worktree/status for the top bar and
// /who. Presentation only: never feeds delivery, identity or bindings. Split agreed with Astra (room, 2026-09-28):
// Astra implements the read-only WorkspaceProvider (both harnesses + cached git sampling); Claude owns this contract,
// the monitor integration and rendering. Unknown is null — never 0, '' or a guess.

export interface GitInfo {
  /** 'ok' = read; 'not_a_repo' = the cwd isn't inside a git work tree; 'unavailable' = git failed/timed out. */
  status: 'ok' | 'not_a_repo' | 'unavailable';
  reason?: string;
  /** Top of the work tree containing the cwd. */
  root: string | null;
  /** Set when that work tree is a LINKED worktree (its path); null for the main checkout. */
  worktree: string | null;
  /** Branch name, or null when detached (see `detached`). */
  branch: string | null;
  detached: boolean;
  /** Short HEAD commit. */
  head: string | null;
  /** Unique changed entries (a file both staged and modified counts once); null when not read. Drives "*N". */
  dirty: number | null;
  /** Porcelain counts (may overlap: a file can be both staged and modified); null when not read. */
  staged: number | null;
  modified: number | null;
  untracked: number | null;
  /** Relative to the upstream; null when there is no upstream. */
  ahead: number | null;
  behind: number | null;
  /** When git was last sampled (cached per cwd, so agents sharing a worktree share one probe). */
  checkedAt: string | null;
}

export interface WorkspaceInfo {
  /** Model the session is using, as last observed (e.g. "claude-opus-5-5", "gpt-6-luna"); null when unknown. */
  model: string | null;
  /** The SESSION's working directory as the harness records it (not a shell command's temporary directory). */
  cwd: string | null;
  /** Where `cwd` came from, so it's labelled honestly in /who (e.g. 'claude-registry', 'codex-thread'). */
  cwdSource: string | null;
  git: GitInfo | null;
  /** When this snapshot was taken. */
  observedAt: string | null;
}

/**
 * Read-only source of workspace metadata. Implementations never write anything, never start or configure a harness,
 * bound every probe (time and output), cache git per cwd, and never throw: failures come back as nulls/`unavailable`
 * with a reason.
 */
export interface WorkspaceProvider {
  observe(target: { participant: string; harness: 'claude' | 'codex'; sessionId: string }): Promise<WorkspaceInfo>;
}
