#!/usr/bin/env bun
/**
 * PreToolUse guard (EnterWorktree, Bash `git worktree add`): denies creating
 * a worktree directly and tells the agent to go through Pane instead. The
 * deny reason is fed back to the agent, so it doubles as just-in-time guidance.
 */

import { getInput, deny, allow, isRecord } from './lib/hook-io.js';
import { PANE_GUIDANCE } from './lib/pane-guidance.js';

const WORKTREE_ADD = /(^|[;&|]\s*)git\b[^;&|]*?\bworktree\s+add\b/;

const input = await getInput(
  (v): v is { tool_name: string; tool_input?: unknown } => isRecord(v) && typeof v.tool_name === 'string',
);

if (input.tool_name === 'EnterWorktree') deny(PANE_GUIDANCE);

if (input.tool_name === 'Bash' && isRecord(input.tool_input)) {
  const command = input.tool_input.command;
  if (typeof command === 'string' && WORKTREE_ADD.test(command)) deny(PANE_GUIDANCE);
}

allow();
