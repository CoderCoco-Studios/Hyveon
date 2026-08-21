# Worktrees

Hooks enforce isolation, `.claude/worktrees/` paths, and `main` sync (`.claude/hooks/guard-require-worktree.ts`, `guard-enter-worktree-path.ts`, `guard-git-worktree-add-path.ts`, `guard-enter-worktree-sync.ts`). Don't restate or re-check those.

`hook-npm-ci-on-worktree-enter.ts` runs `npm ci` after `EnterWorktree` too, but it's a `PostToolUse` hook — it can only report via `additionalContext`, it cannot block. If it reports a failure (or you don't see its success message), run `npm ci` yourself before lint/typecheck/test/build.

Not enforceable by hooks — judge these yourself:

1. **Reuse before creating.** `git worktree list` / `git branch --list` first; match → `EnterWorktree path`, no match → `EnterWorktree name`.
2. **PR-stack branch base.** First group from `main` (hook-synced); later groups from the *previous group's branch* — `EnterWorktree` can't target it, so hop 2+ is a manual `git worktree add` (fetch that base first) + `EnterWorktree path`. See `pr-stacking.md`.

If `npm ci` didn't run (hook failed, or a worktree was added outside `EnterWorktree`): run it yourself before lint/typecheck/test/build. To check for the stale-symlink symptom first: `node -e "console.log(require('fs').realpathSync('node_modules/@hyveon/<pkg>'))"` from the worktree root — if it resolves outside the worktree, `npm install` and recheck.
