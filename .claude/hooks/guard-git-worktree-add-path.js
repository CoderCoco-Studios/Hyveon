#!/usr/bin/env node
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

import { readStdin, deny } from './lib/hook-io.js';

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  if (input.tool_name !== 'Bash') return;
  const command = (input.tool_input && input.tool_input.command) || '';

  if (!/git\s+worktree\s+add\b/.test(command)) return;

  deny(
    'Direct `git worktree add` is blocked — worktree creation must go through the ' +
      'EnterWorktree tool, not the raw git subcommand (per .claude/rules/worktree.md). ' +
      'Use EnterWorktree with `name` to create a worktree, or `path` to switch into one ' +
      'that already exists.',
  );
}

main();
