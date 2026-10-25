#!/usr/bin/env bun
/**
 * PreToolUse guard (Edit, Write, NotebookEdit, Bash): tracked-file changes
 * must never land on a repo's main checkout (.claude/rules/worktree.md).
 *
 * Judges the edit target's own repo, not the session cwd, so a worktree
 * session can't edit the main checkout and Pane worktrees nested under the
 * main toplevel aren't falsely denied. Bash is limited to `git
 * add|commit|merge|rebase|reset`, resolved against `cwd` and any `git -C`.
 */

import path from 'node:path';
import { getInput, deny, allow, isRecord } from './lib/hook-io.js';
import { isMainCheckout } from './lib/git-context.js';
import { PANE_GUIDANCE } from './lib/pane-guidance.js';

const GIT_MUTATION = /(?:^|[;&|]\s*)git\s+((?:-C\s+\S+\s+)*)(?:add|commit|merge|rebase|reset)\b/g;

// CI runners use a fresh isolated clone per run, the guarantee a worktree gives locally.
if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') allow();

const input = await getInput(
  (v): v is { tool_name: string; tool_input?: unknown; cwd?: unknown } =>
    isRecord(v) && typeof v.tool_name === 'string',
);

const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();

function block(what: string): never {
  return deny(`Blocked: ${what} targets the main checkout. Tracked-file changes must happen in a worktree. ${PANE_GUIDANCE}`);
}

if (input.tool_name === 'Bash') {
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  for (const match of command.matchAll(GIT_MUTATION)) {
    let dir = cwd;
    for (const c of (match[1] ?? '').matchAll(/-C\s+(\S+)/g)) dir = path.resolve(dir, c[1]!);
    if (isMainCheckout(dir)) block('this git command');
  }
} else if (['Edit', 'Write', 'NotebookEdit'].includes(input.tool_name)) {
  const target = toolInput.file_path ?? toolInput.notebook_path;
  if (typeof target === 'string' && target && isMainCheckout(path.resolve(cwd, target))) block('this edit');
}

allow();
