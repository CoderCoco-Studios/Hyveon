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

/** Result of {@link runCmd}. */
export type CmdResult = { ok: true; stdout: string } | { ok: false; stderr: string };

/** Same as {@link cmd}, but never throws; a failure carries the captured stderr, or the error message when there is none (timeout, missing binary). */
export function runCmd(bin: string, args: string[], options: CmdOptions): CmdResult {
  try {
    return { ok: true, stdout: cmd(bin, args, options) };
  } catch (err) {
    const e = err as { stderr?: unknown; message?: unknown };
    const stderr = typeof e.stderr === 'string' && e.stderr ? e.stderr : String(e.message ?? err);
    return { ok: false, stderr: stderr.trim() };
  }
}

/** Same as {@link cmd}, but returns null instead of throwing on failure (non-zero exit, timeout, missing binary). */
export function tryCmd(bin: string, args: string[], options: CmdOptions): string | null {
  try {
    return cmd(bin, args, options);
  } catch {
    return null;
  }
}
