#!/usr/bin/env bun
/**
 * PostToolUse hook (EnterWorktree): runs `npm ci` in a freshly entered
 * worktree, per .claude/rules/worktree.md — a new worktree doesn't get its
 * own `node_modules`, so cross-package `@hyveon/*` imports silently resolve
 * against a parent checkout's stale compiled output until this runs.
 *
 * Detects "am I in a worktree" the same way guard-require-worktree.ts does:
 * `git rev-parse --git-dir` (worktree-specific) differs from
 * `--git-common-dir` (always the real .git) only inside a linked worktree.
 * Uses `tool_response.worktreePath` (EnterWorktreeOutput) rather than the
 * hook's `cwd`, since `cwd` isn't guaranteed synchronously fresh right after
 * the tool call that changed it.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { readStdin, isRecord } from './lib/hook-io.js';

const NPM_CI_TIMEOUT_MS = 5 * 60 * 1000;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const raw = await readStdin();
if (!raw.trim()) process.exit(0);

let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch {
  process.exit(0);
}

if (!isRecord(parsed) || parsed.tool_name !== 'EnterWorktree') process.exit(0);

const toolResponse = isRecord(parsed.tool_response) ? parsed.tool_response : {};
const cwd = typeof toolResponse.worktreePath === 'string' ? toolResponse.worktreePath : undefined;
if (!cwd) process.exit(0);

let gitDir: string;
let commonDir: string;
try {
  gitDir = git(['rev-parse', '--git-dir'], cwd);
  commonDir = git(['rev-parse', '--git-common-dir'], cwd);
} catch {
  process.exit(0);
}

const inWorktree = path.resolve(gitDir) !== path.resolve(commonDir);
if (!inWorktree) process.exit(0);

const nodeModules = path.join(cwd, 'node_modules');
const lockfile = path.join(cwd, 'package-lock.json');
try {
  if (existsSync(nodeModules) && existsSync(lockfile) && statSync(nodeModules).mtimeMs >= statSync(lockfile).mtimeMs) {
    process.exit(0);
  }
} catch {
  // Fall through and let npm ci run/fail normally.
}

try {
  execFileSync('npm', ['ci'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: NPM_CI_TIMEOUT_MS });
  process.stdout.write(JSON.stringify({ systemMessage: `npm ci completed in ${cwd}` }));
} catch (err) {
  const output = err instanceof Error && 'stderr' in err ? String((err as { stderr?: unknown }).stderr) : '';
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `npm ci failed in the new worktree (${cwd}): ${message}${output ? `\n${output.slice(-2000)}` : ''}. ` +
          'Run it manually before lint/typecheck/test/build in this worktree.',
      },
    }),
  );
}
