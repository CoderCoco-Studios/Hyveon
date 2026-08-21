# Worktrees

## Hooks enforce worktree isolation — this file covers what they can't decide for you

`PreToolUse`/`PostToolUse` hooks already enforce, no need to restate or double-check them by hand:

- Edits, writes, and `git add`/`commit` are denied outside a worktree (`guard-require-worktree.ts`).
- `EnterWorktree`'s `path` must resolve under `.claude/worktrees/`, same for a manual `git worktree add` (`guard-enter-worktree-path.ts`, `guard-git-worktree-add-path.ts`).
- Branching from `main` via `EnterWorktree` with `name` fast-forwards local `main` to `origin/main` first, or blocks with a clear reason if that's unsafe (`guard-enter-worktree-sync.ts`).
- `npm ci` runs automatically right after `EnterWorktree` finishes creating the worktree (`hook-npm-ci-on-worktree-enter.ts`) — `node_modules` isn't copied into a new worktree, so without this, cross-package `@hyveon/*` imports would silently resolve against a parent checkout's stale compiled output.

## What's left to judge yourself

1. **Reuse before creating.** Check `git worktree list` / `git branch --list` for a worktree already matching this task before calling `EnterWorktree` with `name` — hooks have no way to know whether that's the right call.
   - Match found → `EnterWorktree` with `path` pointing at it.
   - No match → `EnterWorktree` with `name`.
2. **Branch base for PR-stack groups.** The first group branches from `main` (covered above); every later group branches from the *previous group's branch*, not `main` — `EnterWorktree` can't target an arbitrary base branch, so hop 2+ needs the manual `git worktree add` + `EnterWorktree path` flow in `pr-stacking.md`. Fetch that base branch from `origin` first — the sync hook only covers the `main` case.

## If `npm ci` didn't run

The hook can fail, or get bypassed (a manual `git worktree add` outside `EnterWorktree`). Run
`npm ci` yourself before any lint/typecheck/test/build command. Symptom of a stale
`node_modules`: `tsc`/`app:test:integration` errors referencing types/fields that visibly exist
in the file you're reading (`app:lint`/`app:test`, source-transpiling Vitest, can look green
while this is broken). Diagnose with:

```bash
node -e "console.log(require('fs').realpathSync('node_modules/@hyveon/<pkg>'))"
```

If that resolves outside the worktree, `npm ci` and recheck.
