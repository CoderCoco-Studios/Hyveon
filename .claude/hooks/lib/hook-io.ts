/**
 * Shared stdin-read and permission-decision helpers for PreToolUse guard
 * hooks that read the tool-call JSON off stdin and answer with a
 * permission decision on stdout.
 */

import type { PreToolUseHookInput, PreToolUseHookSpecificOutput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

export type { PreToolUseHookInput };

/** Narrows `value` to a non-null object, e.g. after `JSON.parse` of untrusted input. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Reads the guarded tool call's JSON payload off stdin to completion, as a raw string. */
export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function respond(permissionDecision: PreToolUseHookSpecificOutput['permissionDecision'], reason: string): never {
  const output: SyncHookJSONOutput = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
      permissionDecisionReason: reason,
      additionalContext: reason,
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

/** Refuses the guarded tool call. Exits with code 0 (not non-zero) — refusal is signalled via the `deny` payload, not the process exit code. */
export function deny(reason: string): never {
  return respond('deny', reason);
}

/**
 * Surfaces `reason` to Claude/the user and requires explicit confirmation
 * before the guarded tool call proceeds — for cases the guard can't
 * confidently allow or deny on its own (e.g. it couldn't parse or validate
 * its input), so the failure isn't silently swallowed.
 */
export function ask(reason: string): never {
  return respond('ask', reason);
}

/** Exits the hook script with no output, letting the guarded tool call proceed. */
export function allow(): never {
  process.exit(0);
}
