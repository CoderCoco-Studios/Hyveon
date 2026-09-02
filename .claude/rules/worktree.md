# Worktrees

Hooks enforce isolation, `.claude/worktrees/` paths, and `main` sync (`.claude/hooks/guard-require-worktree.ts`, `guard-enter-worktree-path.ts`, `guard-git-worktree-add-path.ts`, `guard-enter-worktree-sync.ts`). Don't restate or re-check those.

`hook-npm-ci-on-worktree-enter.ts` runs `npm ci` after `EnterWorktree` too, but it's a `PostToolUse` hook — it can only report via `additionalContext`, it cannot block. If it reports a failure (or you don't see its success message), run `npm ci` yourself before lint/typecheck/test/build.

Not enforceable by hooks — judge these yourself:

1. **Reuse before creating.** `git worktree list` / `git branch --list` first; match → `EnterWorktree path`, no match → `EnterWorktree name`.
2. **PR-stack branch base.** First group from `main` (hook-synced); later groups from the *previous group's branch* — `EnterWorktree` can't target it, so hop 2+ is a manual `git worktree add` (fetch that base first) + `EnterWorktree path`. See `pr-stacking.md`.
3. **Subagents can't create a worktree via `EnterWorktree name`.** A subagent (Agent tool) has a pinned cwd at launch — `EnterWorktree name` creating a new worktree mutates the *session's* cwd, which a pinned-cwd context refuses to do. `EnterWorktree path` (entering one that already exists) is fine from a subagent. So for parallel subagents each needing their own isolated branch:
   - Preferred: `Agent({ isolation: "worktree", ... })` — the harness creates/tears down the worktree per agent itself, bypassing `EnterWorktree` entirely, so the pinned-cwd restriction never triggers. If the agent needs a specific existing branch (not a fresh one off `main`), have its prompt run a plain `git fetch origin <branch> && git checkout <branch>` as its first step — checkout isn't worktree creation, so the guard hooks don't touch it.
   - Fallback: the orchestrating (non-subagent) session creates each worktree first (`EnterWorktree name`, or the PR-stack manual path above for an arbitrary base), then hands the path to the subagent, whose first tool call is `EnterWorktree path`.

If `npm ci` didn't run (hook failed, or a worktree was added outside `EnterWorktree`): run it yourself before lint/typecheck/test/build. To check for the stale-symlink symptom first: `node -e "console.log(require('fs').realpathSync('node_modules/@hyveon/<pkg>'))"` from the worktree root — if it resolves outside the worktree, `npm install` and recheck.
