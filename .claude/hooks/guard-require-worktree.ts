#!/usr/bin/env bun
/**
 * PreToolUse guard (Bash `git add`/`git commit`, Edit, Write): enforces
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
import { readStdin, deny, allow, isRecord } from './lib/hook-io.js';

const GIT_ADD_COMMIT = /(^|[;&|]\s*)git\s+(add|commit)\b/;

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

// CI runners check out a fresh, isolated clone per run - the same
// guarantee a worktree gives locally - so the worktree rule doesn't
// apply there. Without this, every Write/Edit/git-commit in a
// claude-code-action step gets denied, since a plain checkout is
// never a linked worktree.
if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') allow();

const raw = await readStdin();
if (!raw.trim()) allow();

let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch {
  allow();
}

if (!isRecord(parsed)) allow();
const input = parsed as Record<string, unknown>;

const toolName = input.tool_name;
if (toolName === 'Bash') {
  const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  if (!GIT_ADD_COMMIT.test(command)) allow();
} else if (toolName === 'CreateWorktree') {
  deny('Blocked: Required to use the EnterWorktree tool instead');
} else if (toolName !== 'Edit' && toolName !== 'Write') {
  allow();
}

let gitDir: string;
let commonDir: string;
try {
  gitDir = git(['rev-parse', '--git-dir']);
  commonDir = git(['rev-parse', '--git-common-dir']);
} catch {
  // Not a git repo — nothing to enforce.
  allow();
}

const inWorktree = path.resolve(gitDir) !== path.resolve(commonDir);
if (inWorktree) allow();

deny(
  'Blocked: not in a worktree. .claude/rules/git.md and worktree.md ' +
    'require tracked-file changes to happen in a dedicated worktree — ' +
    'call EnterWorktree first, then retry this edit/commit there.',
);
