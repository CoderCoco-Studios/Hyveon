#!/usr/bin/env bun
/**
 * PreToolUse guard (Write|Edit): blocks writes to docs/superpowers/specs/**
 * or docs/superpowers/plans/**, per .claude/rules/spec-driven-development.md's
 * brainstorm -> opsx routing rule.
 *
 * This repo's OpenSpec schema (superpowers-bridge) redirects both paths —
 * superpowers:brainstorming's default output and superpowers:writing-plans'
 * default output — into openspec/changes/<name>/{brainstorm,plan}.md instead.
 * That redirection only fires when brainstorming/writing-plans are invoked
 * through /opsx:* commands; triggered narratively, the generic skills still
 * write to these paths directly, contradicting the routing rule. See
 * openspec/schemas/superpowers-bridge/README.md, "Entry & exit gates".
 */

import { readStdin, deny, allow, isRecord } from './lib/hook-io.js';

const GUARD_PATTERN = /(^|\/)docs\/superpowers\/(specs|plans)\//;

const DENY_REASON =
  'Blocked: .claude/rules/spec-driven-development.md forbids writing directly to ' +
  'docs/superpowers/specs/** or docs/superpowers/plans/**. Narrative brainstorming ' +
  'stays verbal-only; writing-plans output is redirected by the superpowers-bridge ' +
  'schema. Promote via /opsx:propose or /opsx:new so output lands in ' +
  'openspec/changes/<name>/brainstorm.md or plan.md instead. See ' +
  'openspec/schemas/superpowers-bridge/README.md, section "Entry & exit gates".';

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
