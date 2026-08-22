#!/usr/bin/env bun
/**
 * PreToolUse guard (EnterWorktree): denies `EnterWorktree` calls whose
 * `path` arg isn't under .claude/worktrees/, per .claude/rules/worktree.md.
 */

import { realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { readStdin, deny, ask, allow, isRecord } from './lib/hook-io.js';
import { tryCmd } from './lib/cmd.js';

/** Fields this guard reads from the PreToolUse payload — not the full hook contract. */
interface EnterWorktreeHookInput {
  tool_name: string;
  cwd?: string;
  tool_input?: { path?: string; name?: string };
}

/** Resolves through symlinks when the path exists; falls back to a plain resolve for a not-yet-created worktree path. */
function resolveReal(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Resolves the project's main worktree root, i.e. the directory holding the
 * shared `.claude/worktrees/` all worktree paths are checked against — not
 * `cwd` itself, which is already inside a linked worktree when this guard
 * fires from a session that previously called `EnterWorktree`. Falls back to
 * `cwd` when git can't answer (not a repo, `git` missing) so the check still
 * runs, just against a best-effort root instead of failing closed.
 */
function resolveProjectRoot(cwd: string): string {
  const commonDir = tryCmd('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  if (!commonDir) return cwd;
  return dirname(commonDir);
}

/** True containment check against the resolved `.claude/worktrees` directory — not a substring match, which `.claude/worktrees/../outside` or a `.claude/worktrees-old` sibling would defeat. */
function isUnderClaudeWorktrees(candidate: string, cwd: string): boolean {
  const projectRoot = resolveProjectRoot(cwd);
  const root = resolveReal(resolve(projectRoot, '.claude/worktrees'));
  const target = resolveReal(resolve(cwd, candidate));
  return target === root || target.startsWith(root + sep);
}

const raw = await readStdin();
if (!raw.trim()) allow();

let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  ask(
    `guard-enter-worktree-path couldn't parse its PreToolUse input as JSON (${message}) — ` +
      'unable to check the EnterWorktree path. Confirm before proceeding.',
  );
}

if (!isRecord(parsed) || typeof parsed.tool_name !== 'string') {
  ask(
    'guard-enter-worktree-path received PreToolUse input that parsed as JSON but isn\'t a valid hook ' +
      'payload (missing or non-string `tool_name`) — unable to check the EnterWorktree path. Confirm before proceeding.',
  );
}
const input = parsed as unknown as EnterWorktreeHookInput;

if (input.tool_name !== 'EnterWorktree') allow();

if (input.tool_input !== undefined && !isRecord(input.tool_input)) {
  ask(
    "guard-enter-worktree-path received an EnterWorktree call whose `tool_input` isn't an object — " +
      'unable to check the EnterWorktree path. Confirm before proceeding.',
  );
}

const path = input.tool_input?.path || '';
if (!path) allow();

if (!isUnderClaudeWorktrees(path, input.cwd || process.cwd())) {
  deny(
    `EnterWorktree path must be under .claude/worktrees/ (got: ${path}). ` +
      'Use name to create a new worktree, or point path at an existing one under .claude/worktrees/.',
  );
}
