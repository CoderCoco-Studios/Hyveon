/**
 * Shared subprocess-exec helpers for hooks that shell out to `git`, `gh`, or
 * other CLIs and need a consistent cwd + timeout across call sites.
 */

import { execFileSync } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 5000;

/** Options for {@link cmd} and {@link tryCmd}. */
export type CmdOptions = {
  cwd: string;
  timeoutMs?: number;
};

/** Runs `bin args` under `options.cwd`, returning trimmed stdout; throws on a non-zero exit or timeout. */
export function cmd(bin: string, args: string[], options: CmdOptions): string {
  return execFileSync(bin, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }).trim();
}

/** Same as {@link cmd}, but returns null instead of throwing on failure (non-zero exit, timeout, missing binary). */
export function tryCmd(bin: string, args: string[], options: CmdOptions): string | null {
  try {
    return cmd(bin, args, options);
  } catch {
    return null;
  }
}
