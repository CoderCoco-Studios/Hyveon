#!/usr/bin/env bun
/**
 * PreToolUse guard (Bash): blocks every `git worktree add` invoked directly
 * via Bash, per .claude/rules/worktree.md. Worktree creation must go through
 * the `EnterWorktree` tool — never the raw git subcommand, even when the
 * target path is under .claude/worktrees/.
 *
 * Without this, `EnterWorktree`'s own path check (which only validates the
 * `path` arg passed *to that tool*) can be bypassed by creating the worktree
 * directly via `git worktree add <path> ...` in Bash, then pointing
 * EnterWorktree at the resulting path — an already-existing worktree the
 * EnterWorktree hook has no reason to distrust.
 */

import { readStdin, deny, ask, allow, isRecord, type PreToolUseHookInput } from './lib/hook-io.js';

/**
 * Detects a direct `git worktree add` inside one shell "simple command" —
 * i.e. not crossing a `;`, `&&`, `||`, `|`, or newline into an unrelated
 * command. Tolerates Git global options ahead of the subcommand (`git -C
 * /repo worktree add ...`, `git --git-dir=/repo/.git worktree add ...`),
 * which a literal `git\s+worktree\s+add` match misses entirely.
 *
 * This is a heuristic, not a real shell parser — quoting tricks and command
 * substitution can still evade it. Given that, false positives (an unrelated
 * command denied) are the safe failure mode here, not false negatives.
 */
function isDirectWorktreeAdd(command: string): boolean {
  return command
    .split(/[;&|\n]+/)
    .some((segment) => /^\s*git\b/.test(segment) && /\bworktree\b/.test(segment) && /\badd\b/.test(segment));
}

const raw = await readStdin();
if (!raw.trim()) allow();

let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  ask(
    `guard-git-worktree-add-path couldn't parse its PreToolUse input as JSON (${message}) — ` +
      'unable to check whether this Bash command is a `git worktree add`. Confirm before proceeding.',
  );
}

if (!isRecord(parsed) || typeof parsed.tool_name !== 'string') {
  ask(
    'guard-git-worktree-add-path received PreToolUse input that parsed as JSON but isn\'t a valid ' +
      'hook payload (missing or non-string `tool_name`) — unable to check whether this Bash command ' +
      'is a `git worktree add`. Confirm before proceeding.',
  );
}
const input = parsed as PreToolUseHookInput;

if (input.tool_name !== 'Bash') allow();

if (!isRecord(input.tool_input) || typeof input.tool_input.command !== 'string') {
  ask(
    "guard-git-worktree-add-path received a Bash PreToolUse call whose `tool_input.command` isn't a " +
      'string — unable to check whether this Bash command is a `git worktree add`. Confirm before proceeding.',
  );
}
const command = (input.tool_input as { command: string }).command;

if (!isDirectWorktreeAdd(command)) allow();

deny(
  'Direct `git worktree add` is blocked — worktree creation must go through the ' +
    'EnterWorktree tool, not the raw git subcommand (per .claude/rules/worktree.md). ' +
    'Use EnterWorktree with `name` to create a worktree, or `path` to switch into one ' +
    'that already exists.',
);
