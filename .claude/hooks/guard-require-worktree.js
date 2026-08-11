#!/usr/bin/env node
/**
 * PreToolUse guard (Bash `git add`/`git commit`, Edit): enforces
 * .claude/rules/worktree.md + .claude/rules/git.md — tracked-file changes
 * must happen inside a worktree entered via EnterWorktree, never directly
 * in the main checkout.
 *
 * Detects "main checkout" vs "worktree" by comparing `git rev-parse
 * --git-dir` (worktree-specific, e.g. .git/worktrees/<name>) against
 * `--git-common-dir` (always the real .git) — they differ only inside a
 * linked worktree.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const GIT_ADD_COMMIT = /(^|[;&|]\s*)git\s+(add|commit)\b/;

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const toolName = input && input.tool_name;
  if (toolName === 'Bash') {
    const command = (input.tool_input && input.tool_input.command) || '';
    if (!GIT_ADD_COMMIT.test(command)) return;
  } else if (toolName !== 'Edit') {
    return;
  }

  let gitDir;
  let commonDir;
  try {
    gitDir = git(['rev-parse', '--git-dir']);
    commonDir = git(['rev-parse', '--git-common-dir']);
  } catch {
    // Not a git repo — nothing to enforce.
    return;
  }

  const inWorktree = path.resolve(gitDir) !== path.resolve(commonDir);
  if (inWorktree) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Blocked: not in a worktree. .claude/rules/git.md and worktree.md ' +
          'require tracked-file changes to happen in a dedicated worktree — ' +
          'call EnterWorktree first, then retry this edit/commit there.',
      },
    }),
  );
}

main();
