# Worktrees

## Every change starts in a worktree, branched from an up-to-date base

1. New feature/fix → worktree branched from `main`.
2. PR-stack group → worktree branched from the *previous group's branch*, not `main` (see `pr-stacking.md`).
3. Before branching, make sure the base is current:
   - Branching from `main` via `EnterWorktree` with `name` → fresh only when the session's `worktree.baseRef` setting is `fresh` (the default; `head` branches from local HEAD instead) and the local `origin/main` tracking ref is up to date. `git fetch origin main` first if in doubt.
   - Any other base (a manual `git worktree add`, or a prior stack branch) — must already exist on `origin` (push it first if it doesn't) → `git fetch origin <base-branch>` first, then branch from `origin/<base-branch>`.
4. Immediately after entering: `npm ci` from the worktree root, before any lint/typecheck/test/build command. This now runs automatically — a `PostToolUse` hook on `EnterWorktree` (`.claude/hooks/hook-npm-ci-on-worktree-enter.ts`) runs `npm ci` in the new worktree as soon as it's created. Treat this step as a fallback for when the hook fails or isn't active (e.g. a manual `git worktree add`), not as something to skip trusting the hook silently succeeded — check its output.

**Why step 4:** `node_modules` isn't copied into a new worktree. Node's resolution then walks up to the *parent checkout's* `node_modules`, silently typechecking your edited source against a **different worktree's stale compiled output** for any `@hyveon/*` cross-package import. Symptom: `tsc`/`app:test:integration` errors referencing types/fields that visibly exist in the file you're reading. `app:lint`/`app:test` (source-transpiling Vitest) can look green while this is broken.

**If you hit that symptom:** `node -e "console.log(require('fs').realpathSync('node_modules/@hyveon/<pkg>'))"` from the worktree root — if it resolves outside the worktree, `npm ci` and recheck.

Applies everywhere in this repo: ad hoc worktrees, PR-stack groups, anything opened via `EnterWorktree`.
