---
name: stacked-pr-rebase
description: Fix a stacked PR that GitHub reports as CONFLICTING against main because an earlier part of the stack already squash-merged — merge main in, resolve conflicts by treating main as authoritative, clean up doc comments, fix lint, and verify. Use whenever a PR in a multi-part stack (part N of an 8-part migration, "stacked on #N-1", etc.) shows DIRTY/CONFLICTING mergeability with all CI checks red.
---

# Fixing a stacked PR after an earlier part squash-merged

## The problem this solves

When a long chain of stacked branches (`feature-1`, `feature-2`, ... each PR'd and
squash-merged into `main` in order) is still in flight, a later branch (`feature-N`) was
usually forked from an *earlier* branch's tip before that branch was rebased and
squash-merged. Once part N-1 merges, `main` gets a brand-new commit whose **tree is
identical** to part N-1's branch tip, but whose **history is unrelated** (squash merges
don't preserve the original commits). GitHub then reports part N's PR as
`CONFLICTING`/`DIRTY` even though the actual file content mostly agrees — the conflict is
a history-shape problem, not really a content problem.

Symptoms that confirm this is the right skill:
- `gh pr view <N> --json mergeable,mergeStateStatus` → `"CONFLICTING"` / `"DIRTY"`.
- All CI checks (build, test, integration, e2e) are red on the PR.
- The PR description says "stacked on #<N-1>" or similar, and #<N-1> shows as merged.

## Step 1 — Confirm the diagnosis before touching anything

```bash
git fetch origin main <prior-part-branch> <this-branch>
git merge-base <prior-part-branch> origin/main      # should equal the commit before prior-part merged
git diff <prior-part-branch> origin/main            # should be EMPTY (identical tree)
```

If the diff is empty, the squash-merge preserved the tree exactly and this is the expected
history-shape conflict. If it is *not* empty, something else changed on `main` since — stop
and investigate that diff first, this skill's shortcuts don't apply cleanly.

Also check for a stale local branch left over from a previous attempt at this exact fix:
`git branch --list <this-branch> -v` — if it exists and its `ahead/behind` counts vs.
`origin/<this-branch>` look odd, don't reuse it blindly. Rename it aside
(`git branch -m <this-branch> <this-branch>-stale-local-attempt`) rather than deleting it,
then create the branch fresh from `origin/<this-branch>`.

## Step 2 — Merge, don't replay commits

It's tempting to reach for `git rebase --onto origin/main <prior-part-branch> <this-branch>`
to replay only "this branch's own" commits onto the new main. **In practice this produces
spurious conflicts anyway** — if `<this-branch>` was forked before the stack was rebased
into strict linear order, its "unique" commits (by `git rev-list <prior-part-branch>..<this-branch>`)
can include old, once-independent copies of work that a *different* squash-merged commit
in main's history already superseded. Rebasing replays those old commits one at a time and
hits add/add conflicts on content that's actually already resolved at the tip.

A plain merge is more robust because git's three-way merge auto-resolves any file whose
final content is byte-identical on both sides, regardless of how differently the two
histories got there — so start with:

```bash
git worktree add .worktrees/<this-branch> -b <this-branch> origin/<this-branch>
cd .worktrees/<this-branch>
git merge --no-commit --no-ff origin/main
```

This leaves only the *genuinely* conflicting files — usually a few dozen, not hundreds.

## Step 3 — Resolve conflicts with main as authoritative

For each conflicted file, the default resolution is: **take `origin/main`'s version** — it's
already been through review (CodeRabbit rounds, human review) and is the shipped code — and
only layer in content from `<this-branch>` that main doesn't already have. Concretely, for
each conflict:

1. `git diff origin/main...<this-branch> -- <file>` to see what this branch actually meant to
   change here.
2. Check whether main's current version already covers that intent (just maybe under a
   renamed symbol/route/IPC channel from an intervening part). If yes: take main's version
   wholesale.
3. If this branch adds something genuinely new (e.g. this part's actual deliverable — a new
   test harness, a new UI flow, a doc rewrite) and main has no equivalent: keep this branch's
   version, translated onto main's current naming/module structure.
4. Watch for silent auto-merges (no conflict marker, but content wrongly combined) — e.g. a
   `test.describe.skip(...)` placeholder from main ("this test suite is replaced by part N")
   merging cleanly alongside part N's actual replacement implementation, leaving valid tests
   stuck skipped. Grep for `.skip(` / `.only(` near anything touched by the merge and check it
   still makes sense post-merge.

This conflict-resolution pass is inherently one sequential operation in one worktree (you
can't parallelize resolving a single merge) — do it directly or delegate the whole pass to
one subagent with full context on what each side's changes were for. Don't push yet.

## Step 4 — Verify build wiring before anything else

Rebuilding after a merge this size often surfaces build-wiring breakage independent of the
conflicts themselves (package cross-references, vitest aliases, tsconfig project refs). Run,
in order, fixing anything red before moving on:

```
npm install
npm run app:build
npm run app:build:lambdas   # if Lambdas are in scope
npm run app:typecheck
npm run app:test
npm run app:test:integration
```

Only commit the merge once this is green.

## Step 5 — Clean up doc comments (parallel, worktree-per-agent)

Long-lived stacked branches accumulate comments referencing task numbers, phase numbers, and
"considered and rejected" narration — banned by this repo's `CLAUDE.md` ("Code & test
conventions": comments document current behavior, not history). Find them:

```bash
git grep -nE "task [0-9]+\.[0-9]+|Phase [0-9]+|considered and rejected|found during review|see (design|proposal)\.md|review round" -- '<paths-touched-by-the-PR>'
```

If the hit count is large and spans independent workspaces (e.g. `desktop-main` and `web`
rarely share files), split cleanup across parallel subagents — each gets its own
`git worktree add .worktrees/<branch>-cleanup-<n> <branch>` off the *merged, verified* branch,
scoped to a non-overlapping directory so there's nothing to merge-conflict on:

```bash
git worktree add .worktrees/<branch>-cleanup-desktop-main -b <branch>-cleanup-desktop-main <branch>
git worktree add .worktrees/<branch>-cleanup-web -b <branch>-cleanup-web <branch>
```

Each agent: strip the banned patterns, keep TSDoc that documents current behavior, verify
`app:typecheck` + `app:test` stay green in its own worktree, commit (don't push). Then
cherry-pick each agent's commit onto the main branch worktree in sequence — disjoint file
scopes mean no conflicts — and remove the scratch worktrees.

## Step 6 — Lint and final verification

```
npm run app:lint:fix
npm run app:lint          # must be clean
npm run app:typecheck
npm run app:test
npm run app:test:integration
npm run app:test:e2e      # if the renderer/preload/IPC surface was touched
```

## Step 7 — Push and confirm

The merge-based approach in Step 2 does **not** rewrite history, so a plain
`git push origin <this-branch>` is enough — no force-push needed. (If you used
`rebase --onto` instead, expect to need `git push --force-with-lease`, and confirm with the
user first per this repo's git rules — a force-push rewrites a branch other people/CI may
have already fetched.)

Confirm the fix:

```bash
gh pr view <N> --json mergeable,mergeStateStatus
```

Should read `MERGEABLE`. Check the CI run picks up and goes green.

## Notes for the next part in the stack

This same shape recurs for every remaining part of a stack (part N+1 will hit the identical
problem once part N merges) — re-run this skill rather than re-deriving the diagnosis by
hand each time.
