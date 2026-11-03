#!/usr/bin/env bun
/**
 * PreToolUse guard (Write|Edit): blocks writes to docs/superpowers/specs/**
 * or docs/superpowers/plans/**, per .claude/rules/lid-routing.md.
 *
 * superpowers:brainstorming and superpowers:writing-plans default to those
 * paths. In this repo design intent lives in the LID design tree
 * (docs/high-level-design.md and docs/intent/), so brainstorming stays
 * verbal until it converges and then starts the arrow at the HLD or LLD.
 */

import { readStdin, deny, allow, isRecord } from './lib/hook-io.js';

const GUARD_PATTERN = /(^|\/)docs\/superpowers\/(specs|plans)\//;

const DENY_REASON =
  'Blocked: .claude/rules/lid-routing.md forbids writing directly to ' +
  'docs/superpowers/specs/** or docs/superpowers/plans/**. Narrative brainstorming ' +
  'stays verbal-only; once it converges, record the design in the LID tree ' +
  '(docs/high-level-design.md or docs/intent/<node>/) through the linked-intent-dev skill.';

const raw = await readStdin();
if (!raw.trim()) allow();

let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch {
  // Malformed hook input isn't this guard's problem to report — stay silent
  // and let the tool call proceed rather than blocking on a parse error.
  allow();
}

const filePath =
  isRecord(parsed) && isRecord(parsed.tool_input) && typeof parsed.tool_input.file_path === 'string'
    ? parsed.tool_input.file_path
    : undefined;

if (!filePath || !GUARD_PATTERN.test(filePath)) allow();

deny(DENY_REASON);
