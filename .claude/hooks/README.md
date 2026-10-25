# hooks

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run 
```

This project was created using `bun init` in bun v1.3.13. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Hooks

Registered in `.claude/settings.json`. Run the tests with `bun test`.

| Hook | Event | Purpose |
|------|-------|---------|
| `guard-main-checkout.ts` | PreToolUse `Edit\|Write\|NotebookEdit\|Bash` | Deny edits and `git add/commit/merge/rebase/reset` on a repo's main checkout |
| `guard-redirect-to-pane.ts` | PreToolUse `EnterWorktree`, `Bash` | Deny `EnterWorktree` and `git worktree add`; point the agent at Pane |
| `guard-git-push-sync.ts` | PreToolUse `Bash` | Block pushes when the branch is behind its base |
| `guard-superpowers-paths.ts` | PreToolUse `Write\|Edit` | Keep brainstorm/plan output out of `docs/superpowers/` |
| `notify-branch-sync-drift.ts` | SessionStart, Stop | Report branch/base drift as context |

Shared helpers live in `lib/` (`hook-io`, `cmd`, `git-sync`, `git-context`, `pane-guidance`).
