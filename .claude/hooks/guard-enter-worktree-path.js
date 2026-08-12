#!/usr/bin/env node
/**
 * PreToolUse guard (EnterWorktree): denies `EnterWorktree` calls whose
 * `path` arg isn't under .claude/worktrees/, per .claude/rules/worktree.md.
 */

import { readStdin, deny } from './lib/hook-io.js';

guard: {
  const raw = await readStdin();
  if (!raw.trim()) break guard;

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    break guard;
  }

  if (input.tool_name !== 'EnterWorktree') break guard;
  const path = (input.tool_input && input.tool_input.path) || '';
  if (!path) break guard;

  if (!path.includes('.claude/worktrees')) {
    deny(
      `EnterWorktree path must be under .claude/worktrees/ (got: ${path}). ` +
        'Use name to create a new worktree, or point path at an existing one under .claude/worktrees/.',
    );
  }
}
