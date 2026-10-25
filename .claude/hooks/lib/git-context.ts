/**
 * Helpers for telling a repo's main checkout apart from a linked worktree.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { runCmd } from './cmd.js';

/** Nearest existing ancestor directory of `target` (itself, if it is a directory that exists). */
function nearestExistingDir(target: string): string {
  let current = path.resolve(target);
  while (!existsSync(current) || !statSync(current).isDirectory()) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/**
 * Reports whether `target` (a file or directory, which need not exist yet) lies in a repo's main checkout.
 *
 * @remarks
 * Compares `--git-dir` with `--git-common-dir`; they differ only inside a linked worktree.
 *
 * @param target - Absolute path to classify.
 * @returns `true` for a main checkout; `false` for a linked worktree or a path outside any git repo.
 * @throws When git fails for any reason other than "not a git repository" (missing binary, timeout, unsafe ownership, corruption), so callers can fail closed.
 */
export function isMainCheckout(target: string): boolean {
  const res = runCmd('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], {
    cwd: nearestExistingDir(target),
  });
  if (!res.ok) {
    if (/not a git repository/i.test(res.stderr)) return false;
    throw new Error(`git rev-parse failed: ${res.stderr}`);
  }
  const [gitDir, commonDir] = res.stdout.split('\n');
  return gitDir !== undefined && gitDir === commonDir;
}
