/**
 * Helpers for telling a repo's main checkout apart from a linked worktree.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { tryCmd } from './cmd.js';

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
 */
export function isMainCheckout(target: string): boolean {
  const out = tryCmd('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], {
    cwd: nearestExistingDir(target),
  });
  if (out === null) return false;
  const [gitDir, commonDir] = out.split('\n');
  return gitDir !== undefined && gitDir === commonDir;
}
