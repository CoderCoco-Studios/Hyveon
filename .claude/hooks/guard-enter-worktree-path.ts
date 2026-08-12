#!/usr/bin/env bun
/**
 * PreToolUse guard (EnterWorktree): denies `EnterWorktree` calls whose
 * `path` arg isn't under .claude/worktrees/, per .claude/rules/worktree.md.
 */

import { readStdin, deny, ask, allow, type PreToolUseHookInput } from './lib/hook-io.js';

interface EnterWorktreeHookInput extends Omit<PreToolUseHookInput, 'tool_input'> {
  tool_input?: { path?: string; name?: string };
}

const raw = await readStdin();
if (!raw.trim()) allow();

let input: EnterWorktreeHookInput;
try {
  input = JSON.parse(raw);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  ask(
    `guard-enter-worktree-path couldn't parse its PreToolUse input as JSON (${message}) — ` +
      'unable to check the EnterWorktree path. Confirm before proceeding.',
  );
}

if (input.tool_name !== 'EnterWorktree') allow();
const path = input.tool_input?.path || '';
if (!path) allow();

if (!path.includes('.claude/worktrees')) {
  deny(
    `EnterWorktree path must be under .claude/worktrees/ (got: ${path}). ` +
      'Use name to create a new worktree, or point path at an existing one under .claude/worktrees/.',
  );
}
