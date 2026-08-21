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

/** Git global options that consume the following token as their value (`-C <path>`, not `-C<path>`). */
const GLOBAL_OPTIONS_WITH_SEPARATE_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--exec-path',
  '--config-env',
]);

/**
 * Detects a direct `git worktree add` inside one shell "simple command" —
 * i.e. not crossing a `;`, `&&`, `||`, `|`, or newline into an unrelated
 * command. Tokenizes on whitespace, walks past Git global options ahead of
 * the subcommand (`git -C /repo worktree add ...`, `git
 * --git-dir=/repo/.git worktree add ...`), then requires `worktree` and
 * `add` to be exactly the subcommand and its immediate next positional
 * token — not just present anywhere in the segment. A looser
 * word-presence check would also deny unrelated commands like `git
 * worktree list --format=add` or `git config worktree.useRelativePaths add`.
 *
 * This is a heuristic, not a real shell parser — it doesn't handle quoted
 * arguments containing whitespace, and quoting tricks or command
 * substitution can still evade it.
 */
function isDirectWorktreeAdd(command: string): boolean {
  return command.split(/[;&|\n]+/).some((segment) => {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens[0] !== 'git') return false;

    let i = 1;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      const isSelfContained = tokens[i].includes('=') || !GLOBAL_OPTIONS_WITH_SEPARATE_VALUE.has(tokens[i]);
      i += isSelfContained ? 1 : 2;
    }

    return tokens[i] === 'worktree' && tokens[i + 1] === 'add';
  });
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
    'Do NOT ask the user to run this command themselves — call the EnterWorktree tool ' +
    'now instead: `EnterWorktree({ name: "..." })` creates a new worktree+branch from ' +
    'main (or HEAD, depending on worktree.baseRef) if none exists yet, or ' +
    '`EnterWorktree({ path: "..." })` switches into one that already exists. ' +
    'For these supported cases, retry with EnterWorktree — do not fall back to Bash. If it ' +
    'reports an error, surface that error to the user instead of blindly retrying. ' +
    'The ONLY time asking the user to run `git worktree add` manually is correct is the ' +
    'documented pr-stacking hop-2+ exception in .claude/rules/pr-stacking.md, where the new ' +
    'branch must base off a previous stacked branch (not main/HEAD) — EnterWorktree cannot ' +
    'target an arbitrary base ref, so that specific case needs the user to run ' +
    '`git fetch origin <base>` + `git worktree add -b <branch> .claude/worktrees/<name> ' +
    'origin/<base>` and then EnterWorktree with `path` pointing at the result.',
);
