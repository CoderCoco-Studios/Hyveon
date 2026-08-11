#!/usr/bin/env node
/**
 * PreToolUse guard (EnterWorktree): keeps local `main` in sync before a new
 * worktree branches from it, per .claude/rules/worktree.md step 3.
 *
 * Only acts when the session's cwd is currently on `main`. Blocks with a
 * clear reason if main has uncommitted changes or has local commits not on
 * origin/main (a fast-forward pull would be unsafe); otherwise fetches and
 * fast-forwards main to origin/main before letting EnterWorktree proceed.
 */

import { execFileSync } from 'node:child_process';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
}

function main() {
  let branch;
  try {
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    // Not a git repo / detached weirdness — not this guard's problem.
    return;
  }

  if (branch !== 'main') return;

  const status = git(['status', '--porcelain']);
  if (status) {
    deny(
      'EnterWorktree blocked: uncommitted changes on main. Commit, stash ' +
        '(`git stash -u`), or discard them before branching a new worktree ' +
        'off main.',
    );
    return;
  }

  try {
    git(['fetch', 'origin', 'main']);
  } catch (err) {
    deny(`EnterWorktree blocked: \`git fetch origin main\` failed: ${err.message}`);
    return;
  }

  const local = git(['rev-parse', 'main']);
  const remote = git(['rev-parse', 'origin/main']);
  if (local === remote) return;

  const base = git(['merge-base', 'main', 'origin/main']);
  if (local !== base) {
    deny(
      'EnterWorktree blocked: local main has commits not on origin/main ' +
        '(diverged). Resolve manually (push, rebase, or reset) before ' +
        'branching a new worktree off main.',
    );
    return;
  }

  try {
    git(['merge', '--ff-only', 'origin/main']);
  } catch (err) {
    deny(`EnterWorktree blocked: fast-forwarding main to origin/main failed: ${err.message}`);
    return;
  }

  process.stdout.write(
    JSON.stringify({ systemMessage: `main fast-forwarded ${local.slice(0, 7)} -> ${remote.slice(0, 7)}` }),
  );
}

main();
