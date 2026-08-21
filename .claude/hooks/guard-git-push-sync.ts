#!/usr/bin/env bun
/**
 * PreToolUse guard (Bash `git push`): refuses a push when the branch is
 * behind its base branch or its own remote upstream, per the "rebase
 * before pushing" workflow in this session's git-sync hooks.
 *
 * Rationale: pushing stale history, discovering the drift afterward, then
 * rebasing and pushing again produces two pushes for one logical update —
 * each one can retrigger CI/AI PR reviews (CodeRabbit, Copilot). Catching
 * the drift before the first push avoids that churn.
 */

import { deny, allow, readStdin, isRecord } from './lib/hook-io.js';
import { checkBranchSync, describeDrift } from './lib/git-sync.js';

const GIT_PUSH = /(^|[;&|]\s*)git\s+push\b/m;

const raw = await readStdin();
if (!raw.trim()) allow();

let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch {
  allow();
}
if (!isRecord(parsed)) allow();
const input = parsed as Record<string, unknown>;

if (input.tool_name !== 'Bash') allow();
const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
const command = typeof toolInput.command === 'string' ? toolInput.command : '';
if (!GIT_PUSH.test(command)) allow();

const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
const status = checkBranchSync(cwd);
if (!status) allow();

const message = describeDrift(status);
if (!message) allow();

deny(`Push blocked: ${message}`);
