/**
 * Shared branch/remote sync-status helpers for the SessionStart, Stop, and
 * pre-push guard hooks that keep a working branch from drifting out of
 * date with its base branch or its own remote counterpart.
 */

import { execFileSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 5000;

type CmdOptions = {
  cwd: string;
  timeoutMs?: number;
};

/** Runs `bin args` under `options.cwd`, returning trimmed stdout; throws on a non-zero exit or timeout. */
function cmd(bin: string, args: string[], options: CmdOptions): string {
  return execFileSync(bin, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
  }).trim();
}

/** Same as {@link cmd}, but returns null instead of throwing on failure (non-zero exit, timeout, missing binary). */
function tryCmd(bin: string, args: string[], options: CmdOptions): string | null {
  try {
    return cmd(bin, args, options);
  } catch {
    return null;
  }
}

/** Runs a git command in `cwd`, returning null instead of throwing on failure. */
function tryGit(args: string[], cwd: string): string | null {
  return tryCmd('git', args, { cwd });
}

/** Runs a `gh` command in `cwd`, returning null instead of throwing on failure (missing binary, unauthenticated, rate-limited, no matching PR). */
function tryGh(args: string[], cwd: string): string | null {
  return tryCmd('gh', args, { cwd });
}

/** Returns the current branch name, or null if detached/not a git repo. */
export function getCurrentBranch(cwd: string): string | null {
  const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!branch || branch === 'HEAD') return null;
  return branch;
}

/** Returns the repo's default branch (origin/HEAD), falling back to `main`. */
export function getDefaultBranch(cwd: string): string {
  const ref = tryGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd);
  if (ref) return ref.replace(/^refs\/remotes\/origin\//, '');
  return 'main';
}

/**
 * The open PR's base ref for `branch`, resolved via `gh`.
 *
 * Returns null — rather than guessing the repo default branch — whenever `gh` can't
 * resolve a PR: no PR opened yet (e.g. a not-yet-pushed hop in a PR stack, whose real
 * base is a prior stack branch, not `main`), `gh` missing/unauthenticated, or rate-limited.
 * Guessing wrong here is worse than skipping the check: it would misreport a stacked
 * branch as drifted against `main`. Never throws.
 */
export function getBaseBranch(branch: string, cwd: string): string | null {
  return tryGh(['pr', 'view', branch, '--json', 'baseRefName', '-q', '.baseRefName'], cwd);
}

/** Returns the branch's push/pull upstream (e.g. `origin/foo`), or null if unset. */
export function getUpstream(cwd: string): string | null {
  return tryGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd);
}

/** Counts commits in `range` (a git revision range, e.g. `HEAD..origin/main`); 0 on failure. */
function countCommits(range: string, cwd: string): number {
  const out = tryGit(['rev-list', '--count', range], cwd);
  return out ? Number.parseInt(out, 10) || 0 : 0;
}

/** Drift between HEAD and its base branch / its own remote upstream. */
export type BranchSyncStatus = {
  branch: string;
  base: string;
  /** Commits on origin/<base> not yet in HEAD. */
  behindBase: number;
  upstream: string | null;
  /**
   * Commits on upstream not yet in HEAD, meaningful only when `aheadRemote` is 0.
   * A non-zero `aheadRemote` alongside this means the branch has diverged (e.g. a
   * rebase rewrote its commits) rather than fallen behind — that's a `--force-with-lease`
   * push, not drift, and git's own lease check already guards it safely.
   */
  behindRemote: number;
  /** Commits in HEAD not yet pushed to upstream. */
  aheadRemote: number;
};

/**
 * Fetches `origin/<base>` (and the current upstream, if set) and reports how
 * far HEAD has drifted from each. Returns null when there's nothing
 * meaningful to compare — not a git repo, detached HEAD, no origin remote,
 * HEAD already on the base branch, no confidently-resolved base (see
 * {@link getBaseBranch}), or a fetch failed (stale data is worse than no data).
 */
export function checkBranchSync(cwd: string): BranchSyncStatus | null {
  const branch = getCurrentBranch(cwd);
  if (!branch) return null;

  if (!tryGit(['remote', 'get-url', 'origin'], cwd)) return null;

  const base = getBaseBranch(branch, cwd);
  if (!base || branch === base) return null;

  if (tryGit(['fetch', '--quiet', 'origin', base], cwd) === null) return null;
  if (!tryGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`], cwd)) return null;

  const upstream = getUpstream(cwd);
  if (upstream) {
    const upstreamRemote = upstream.split('/')[0];
    if (tryGit(['fetch', '--quiet', upstreamRemote], cwd) === null) return null;
  }

  return {
    branch,
    base,
    behindBase: countCommits(`HEAD..origin/${base}`, cwd),
    upstream,
    behindRemote: upstream ? countCommits(`HEAD..${upstream}`, cwd) : 0,
    aheadRemote: upstream ? countCommits(`${upstream}..HEAD`, cwd) : 0,
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
  if (status.behindRemote > 0 && status.aheadRemote === 0) {
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
