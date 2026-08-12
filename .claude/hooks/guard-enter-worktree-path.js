#!/usr/bin/env node
/**
 * PreToolUse guard (EnterWorktree): denies `EnterWorktree` calls whose
 * `path` arg isn't under .claude/worktrees/, per .claude/rules/worktree.md.
 */

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

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  if (input.tool_name !== 'EnterWorktree') return;
  const path = (input.tool_input && input.tool_input.path) || '';
  if (!path) return;

  if (!path.includes('.claude/worktrees')) {
    deny(
      `EnterWorktree path must be under .claude/worktrees/ (got: ${path}). ` +
        'Use name to create a new worktree, or point path at an existing one under .claude/worktrees/.',
    );
  }
}

main();
