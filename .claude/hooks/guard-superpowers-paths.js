#!/usr/bin/env node
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

const GUARD_PATTERN = /(^|\/)docs\/superpowers\/(specs|plans)\//;

const DENY_REASON =
  'Blocked: .claude/rules/spec-driven-development.md forbids writing directly to ' +
  'docs/superpowers/specs/** or docs/superpowers/plans/**. Narrative brainstorming ' +
  'stays verbal-only; writing-plans output is redirected by the superpowers-bridge ' +
  'schema. Promote via /opsx:propose or /opsx:new so output lands in ' +
  'openspec/changes/<name>/brainstorm.md or plan.md instead. See ' +
  'openspec/schemas/superpowers-bridge/README.md, section "Entry & exit gates".';

function readStdin() {
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

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    // Malformed hook input isn't this guard's problem to report — stay silent
    // and let the tool call proceed rather than blocking on a parse error.
    return;
  }

  const filePath = input && input.tool_input && input.tool_input.file_path;
  if (!filePath || !GUARD_PATTERN.test(filePath)) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: DENY_REASON,
      },
    }),
  );
}

main();
