/**
 * Shared branch/remote sync-status helpers for the SessionStart, Stop, and
 * pre-push guard hooks that keep a working branch from drifting out of
 * date with its base branch or its own remote counterpart.
 */

import { execFileSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 5000;

function git(args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
  }).trim();
}

function tryGit(args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function tryGh(args: string[]): string | null {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
  } catch {
    return null;
  }
}

/** Returns the current branch name, or null if detached/not a git repo. */
export function getCurrentBranch(): string | null {
  const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || branch === 'HEAD') return null;
  return branch;
}

/** Returns the repo's default branch (origin/HEAD), falling back to `main`. */
export function getDefaultBranch(): string {
  const ref = tryGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (ref) return ref.replace(/^refs\/remotes\/origin\//, '');
  return 'main';
}

/**
 * Best-effort base branch for `branch`: the open PR's base ref if `gh`
 * resolves one, otherwise the repo default branch. Never throws.
 */
export function getBaseBranch(branch: string): string {
  const prBase = tryGh(['pr', 'view', branch, '--json', 'baseRefName', '-q', '.baseRefName']);
  if (prBase) return prBase;
  return getDefaultBranch();
}

/** Returns the branch's push/pull upstream (e.g. `origin/foo`), or null if unset. */
export function getUpstream(): string | null {
  return tryGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
}

function countCommits(range: string): number {
  const out = tryGit(['rev-list', '--count', range]);
  return out ? Number.parseInt(out, 10) || 0 : 0;
}

/** Drift between HEAD and its base branch / its own remote upstream. */
export type BranchSyncStatus = {
  branch: string;
  base: string;
  /** Commits on origin/<base> not yet in HEAD. */
  behindBase: number;
  /** Commits in HEAD not yet on origin/<base>. */
  aheadBase: number;
  upstream: string | null;
  /** Commits on upstream not yet in HEAD (someone/something else pushed). */
  behindRemote: number;
  /** Commits in HEAD not yet pushed to upstream. */
  aheadRemote: number;
};

/**
 * Fetches `origin/<base>` (and the current upstream, if set) and reports how
 * far HEAD has drifted from each. Returns null when there's nothing
 * meaningful to compare — not a git repo, detached HEAD, no origin remote,
 * or HEAD already on the base branch itself.
 */
export function checkBranchSync(): BranchSyncStatus | null {
  const branch = getCurrentBranch();
  if (!branch) return null;

  if (!tryGit(['remote', 'get-url', 'origin'])) return null;

  const base = getBaseBranch(branch);
  if (branch === base) return null;

  if (tryGit(['fetch', '--quiet', 'origin', base]) === null) return null;
  if (!tryGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`])) return null;

  const upstream = getUpstream();
  if (upstream) tryGit(['fetch', '--quiet', 'origin']);

  return {
    branch,
    base,
    behindBase: countCommits(`HEAD..origin/${base}`),
    aheadBase: countCommits(`origin/${base}..HEAD`),
    upstream,
    behindRemote: upstream ? countCommits(`HEAD..${upstream}`) : 0,
    aheadRemote: upstream ? countCommits(`${upstream}..HEAD`) : 0,
  };
}

/** Human-readable summary for hook `additionalContext`/deny messages, or null if fully in sync. */
export function describeDrift(status: BranchSyncStatus): string | null {
  const parts: string[] = [];
  if (status.behindBase > 0) {
    parts.push(
      `${status.behindBase} commit(s) behind origin/${status.base} (base branch has moved on)`,
    );
  }
  if (status.behindRemote > 0) {
    parts.push(`${status.behindRemote} commit(s) behind ${status.upstream} (its own remote)`);
  }
  if (parts.length === 0) return null;

  return (
    `Branch \`${status.branch}\` is out of sync: ${parts.join('; ')}. ` +
    `Finish the current task, then bring it up to date with a rebase (not merge) to keep ` +
    `history linear: \`git fetch origin ${status.base} && git rebase origin/${status.base}\`` +
    (status.upstream ? ` (and \`git fetch origin && git rebase ${status.upstream}\` if that's also behind)` : '') +
    '.'
  );
}
