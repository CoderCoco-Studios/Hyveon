#!/usr/bin/env bun
/**
 * SessionStart + Stop hook: surfaces branch/remote drift so Claude rebases
 * onto the base branch (linear history, per .claude/rules/worktree.md)
 * instead of letting it accumulate silently.
 *
 * Non-blocking by design — reports via `additionalContext` on both events
 * rather than denying anything. On SessionStart this orients Claude at the
 * top of a session; on Stop it's delivered as feedback that keeps the
 * conversation going so Claude can act on it before actually stopping (see
 * StopHookSpecificOutput in \@anthropic-ai/claude-agent-sdk). Once Claude
 * rebases, the next check reports no drift and the turn ends normally.
 */

import type { SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { checkBranchSync, describeDrift } from './lib/git-sync.js';
import { readStdin, isRecord } from './lib/hook-io.js';

async function main(): Promise<void> {
  const raw = await readStdin();
  let hookEventName: 'SessionStart' | 'Stop' = 'SessionStart';
  if (raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && parsed.hook_event_name === 'Stop') hookEventName = 'Stop';
    } catch {
      // Malformed/absent input — default to SessionStart framing.
    }
  }

  const status = checkBranchSync();
  if (!status) return;

  const message = describeDrift(status);
  if (!message) return;

  const output: SyncHookJSONOutput = {
    hookSpecificOutput:
      hookEventName === 'Stop'
        ? { hookEventName: 'Stop', additionalContext: message }
        : { hookEventName: 'SessionStart', additionalContext: message },
  };
  process.stdout.write(JSON.stringify(output));
}

await main();
