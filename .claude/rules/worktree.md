# Worktrees

Hooks enforce isolation, `.claude/worktrees/` paths, `main` sync, and `npm ci` (`.claude/hooks/guard-require-worktree.ts`, `guard-enter-worktree-path.ts`, `guard-git-worktree-add-path.ts`, `guard-enter-worktree-sync.ts`, `hook-npm-ci-on-worktree-enter.ts`). Don't restate or re-check them.

Not enforceable by hooks — judge these yourself:

1. **Reuse before creating.** `git worktree list` / `git branch --list` first; match → `EnterWorktree path`, no match → `EnterWorktree name`.
2. **PR-stack branch base.** First group from `main` (hook-synced); later groups from the *previous group's branch* — `EnterWorktree` can't target it, so hop 2+ is a manual `git worktree add` (fetch that base first) + `EnterWorktree path`. See `pr-stacking.md`.

If `npm ci` didn't run (hook failed, or a worktree was added outside `EnterWorktree`): run it yourself before lint/typecheck/test/build.
