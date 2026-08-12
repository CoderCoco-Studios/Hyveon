#!/usr/bin/env node
/**
 * PreToolUse guard (EnterWorktree): denies `EnterWorktree` calls whose
 * `path` arg isn't under .claude/worktrees/, per .claude/rules/worktree.md.
 */

import { readStdin, deny, allow } from './lib/hook-io.js';

const raw = await readStdin();
if (!raw.trim()) allow();

let input;
try {
  input = JSON.parse(raw);
} catch {
  allow();
}

if (input.tool_name !== 'EnterWorktree') allow();
const path = (input.tool_input && input.tool_input.path) || '';
if (!path) allow();

if (!path.includes('.claude/worktrees')) {
  deny(
    `EnterWorktree path must be under .claude/worktrees/ (got: ${path}). ` +
      'Use name to create a new worktree, or point path at an existing one under .claude/worktrees/.',
  );
}
