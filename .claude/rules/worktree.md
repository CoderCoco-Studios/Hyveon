# Worktrees

## Every change starts in a worktree, branched from an up-to-date base

1. New feature/fix → worktree branched from `main`.
2. PR-stack group → worktree branched from the *previous group's branch*, not `main` (see `pr-stacking.md`).
3. Before branching, make sure the base is current:
   - Branching from `main` via `EnterWorktree` with `name` → already fresh (fetches `origin/main` by default).
   - Any other base (a manual `git worktree add`, or a prior stack branch) → `git fetch origin <base-branch>` first, then branch from `origin/<base-branch>`.
4. Immediately after entering: `npm install` from the worktree root, before any lint/typecheck/test/build command.

**Why step 4:** `node_modules` isn't copied into a new worktree. Node's resolution then walks up to the *parent checkout's* `node_modules`, silently typechecking your edited source against a **different worktree's stale compiled output** for any `@hyveon/*` cross-package import. Symptom: `tsc`/`app:test:integration` errors referencing types/fields that visibly exist in the file you're reading. `app:lint`/`app:test` (source-transpiling Vitest) can look green while this is broken.

**If you hit that symptom:** `node -e "console.log(require('fs').realpathSync('node_modules/@hyveon/<pkg>'))"` from the worktree root — if it resolves outside the worktree, `npm install` and recheck.

Applies everywhere in this repo: ad hoc worktrees, PR-stack groups, anything opened via `EnterWorktree`.
