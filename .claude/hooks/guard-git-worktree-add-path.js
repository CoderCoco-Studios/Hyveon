#!/usr/bin/env node
/**
 * PreToolUse guard (Bash): blocks `git worktree add` commands whose target
 * path isn't under .claude/worktrees/, per .claude/rules/worktree.md.
 *
 * Without this, `EnterWorktree`'s own path check (which only validates the
 * `path` arg passed *to that tool*) can be bypassed by creating the worktree
 * directly via `git worktree add <path> ...` in Bash, then pointing
 * EnterWorktree at the resulting path — an already-existing worktree the
 * EnterWorktree hook has no reason to distrust.
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

  if (input.tool_name !== 'Bash') return;
  const command = (input.tool_input && input.tool_input.command) || '';

  const match = command.match(/git\s+worktree\s+add\s+(?:-\S+\s+)*(\S+)/);
  if (!match) return;

  let targetPath = match[1];
  if (targetPath === '-b' || targetPath === '--force' || targetPath === '-f') return;
  targetPath = targetPath.replace(/^["']|["']$/g, '');

  if (!targetPath.includes('.claude/worktrees')) {
    deny(
      `git worktree add path must be under .claude/worktrees/ (got: ${targetPath}). ` +
        'Use EnterWorktree with name to create a worktree, or if a manual `git worktree add` ' +
        'is required (branching from a non-main base per .claude/rules/worktree.md), target ' +
        'a path under .claude/worktrees/.',
    );
  }
}

main();
