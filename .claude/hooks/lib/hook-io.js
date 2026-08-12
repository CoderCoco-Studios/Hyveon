/**
 * Shared stdin-read and permission-decision helpers for PreToolUse guard
 * hooks that read the tool-call JSON off stdin and answer with a
 * permission decision on stdout.
 */

export function readStdin() {
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

export function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

/**
 * Surfaces `reason` to Claude/the user and requires explicit confirmation
 * before the guarded tool call proceeds — for cases the guard can't
 * confidently allow or deny on its own (e.g. it couldn't parse or validate
 * its input), so the failure isn't silently swallowed.
 */
export function ask(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

/** Exits the hook script with no output, letting the guarded tool call proceed. */
export function allow() {
  process.exit(0);
}
