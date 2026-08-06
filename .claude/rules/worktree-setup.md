# Worktree Setup

## Always run `npm install` immediately after creating a worktree, before any build/typecheck/test command

`git worktree add` (and the `EnterWorktree` tool) creates a working tree with
every tracked file, but `node_modules/` is gitignored and is never copied or
symlinked into the new worktree. Run `npm install` from the worktree root as
the very first command after entering it — before `npm run app:lint`,
`npm run app:typecheck`, `npm run app:test`, or any other build/test command
touches the tree.

**Why:** without its own `node_modules`, a worktree isn't missing packages
outright — Node's module resolution silently walks up parent directories and
finds the *original checkout's* `node_modules` instead, since the worktree
usually lives under `<repo>/.claude/worktrees/<name>` or `<repo>/.worktrees/<name>`,
both descendants of the original checkout. npm workspace packages
(`@hyveon/*`) resolved that way point at the **original checkout's** copies
of `app/packages/*`, not the worktree's — so `tsc`'s project-reference builds
silently typecheck a worktree's edited source against a *different worktree's
stale compiled `dist/` output* for any cross-package import. This produces
confusing, hard-to-attribute errors (e.g. "Property 'x' does not exist on
type 'Y'" for a field that visibly exists in the source you're looking at)
that have nothing to do with the change actually being reviewed, and can
silently pass or fail depending on unrelated, unrecorded state in a sibling
checkout. `npm run app:lint` and `npm run app:test` (Vitest transpiles
workspace TypeScript from source directly and mostly sidesteps this) can look
fully green while `npm run app:typecheck`/`npm run app:test:integration`
(both `tsc`-build-based) fail or pass for the wrong reason.

**How to apply:**

- After `EnterWorktree` or `git worktree add`, run `npm install` from the
  worktree root before touching any other npm script.
- If a build/typecheck error inside a worktree references a type or field
  that is clearly present in the file you're reading, suspect this before
  debugging the code: check whether `node_modules/@hyveon/<pkg>` inside the
  worktree resolves to a path under the worktree itself
  (`readlink -f node_modules/@hyveon/<pkg>`) rather than to a different
  checkout — if it resolves elsewhere (or the worktree's `node_modules` is
  missing/empty), run `npm install` and re-check before assuming the source
  is wrong.
- This applies to every worktree-based workflow in this repo — ad hoc
  worktrees, PR-stacking groups (see `.claude/rules/pr-stacking.md`), and any
  change opened via `EnterWorktree`.
