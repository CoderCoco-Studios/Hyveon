---
name: gh-stack-prs
description: Use the `gh stack` CLI extension (github/gh-stack, already installed) to build and manage a stack of small, dependent PRs per .claude/rules/pr-stacking.md — decomposing a large change into reviewable groups, chaining each branch on the previous one, submitting PRs incrementally, and re-syncing the stack as earlier PRs merge. Reach for this whenever a task would otherwise become one giant PR: a multi-phase migration, an OpenSpec change whose tasks.md has multiple numbered groups, or any change touching more than ~5-6 files across unrelated concerns. Also use it to resume, sync, or clean up a stack that's already in flight, or to fold review feedback into a stacked branch without breaking the branches above it.
---

# Managing stacked PRs with `gh stack`

`.claude/rules/pr-stacking.md` requires large changes to ship as a stack of small,
individually-reviewable PRs rather than one giant diff. That rule was written before
this repo had `gh stack` (`github/gh-stack`) installed, so it describes the mechanics
by hand: one `EnterWorktree` call per group, each hop based on the previous branch.
`gh stack` automates exactly that chaining —
use its subcommands instead of hand-rolling the worktree-per-group dance. The
decomposition judgment calls in pr-stacking.md (how to split the work, when a PR is
small enough to stay solo, docs-in-a-later-PR) are unchanged; only the git/GitHub
mechanics below are new.

## One worktree for the whole stack, not one per group

This is the one place this skill deliberately overrides pr-stacking.md's literal
`git worktree add` instructions, and it's worth understanding why: git refuses to
check out a branch that's already checked out in another worktree of the same repo.
`gh stack sync` and `gh stack modify` cascade-rebase sibling branches in the stack by
checking each one out in turn — if group 2's branch is sitting checked out in its own
linked worktree while you run `gh stack sync` from group 1's worktree, the rebase
fails outright. `gh stack` is built around a single working tree where you switch
between a stack's branches with `gh stack checkout`/`gh stack add`, the same way you'd
use `git checkout` for any other branch — it is not a multi-worktree tool.

So: create **one** worktree for the entire stack (satisfies `~/.claude/rules/git.md`'s
"never edit on `main`" requirement), then let `gh stack` create and switch between the
group branches inside it. This also sidesteps the exact limitation pr-stacking.md
calls out about `EnterWorktree` ("can't express 'branch from a specific prior feature
branch'") — you only need that tool once, for the first hop off `main`; every
subsequent branch is `gh stack`'s job, not a new worktree.

Use `EnterWorktree` with a `name` (the base is just `main`) to create the one worktree
for the whole stack — a direct `git worktree add` is denied unconditionally by
`guard-git-worktree-add-path.ts` regardless of target path, so `EnterWorktree` is the
only path that actually runs. `EnterWorktree` checks out a real branch, not a detached
HEAD; `gh stack init` (next step) then creates the real group-1 branch on top of it,
so just leave the `EnterWorktree`-created branch alone once you're past `init`.

## Lifecycle

### 1. Decompose into groups

Follow pr-stacking.md: split along real dependency lines (an OpenSpec change's
`tasks.md` sections, or the natural phases of a migration), order groups so a group
that depends on another's code comes later, and name each group's branch the way this
repo already does — `<theme>-<n>-<slug>` (`pulumi-3-config-store`,
`bootstrap-4-bucket-encryption`). Write the ordered branch-name list down before
touching `gh stack` — `init` wants it up front.

### 2. Initialize the stack

```bash
gh stack init <group-1-branch> <group-2-branch> <group-3-branch> ...
```

Creates every group's branch in one shot, each based on the previous one, the first
based on `main`. You don't have to know the full list up front, though — `gh stack
init <group-1-branch>` alone is fine, and later groups are added with `gh stack add`
as you get to them (useful when a later group's scope only becomes clear after the
first PR gets review feedback).

### 3. Work one group at a time

You're now on `<group-1-branch>`. Make the group's changes, stage them, and commit
normally:

```bash
git add <files>
git commit -m "feat(infra): <group 1's actual change>"
```

(`gh stack add`'s `-A`/`-u` flags can stage-and-commit in one step too — see step 5 —
but plain `git add`/`git commit` works here since you're not also creating a branch.)

Run this repo's full pre-PR gate **before opening this group's PR** — pr-stacking.md
is explicit that a later group inheriting a broken earlier group compounds the
problem:

```bash
npm run app:lint
npm run app:typecheck
npm run app:test
# npm run app:test:integration   # if controllers/services/Pulumi orchestration changed
# npm run app:test:e2e           # if renderer/preload/IPC surface changed
```

### 4. Submit this group's PR

```bash
gh stack submit --auto
```

`--auto` skips `submit`'s interactive full-screen editor (there's no TTY to drive it
from an agent session) and uses an auto-generated title from the branch's commit
message — which is exactly why step 3's commit message should already be a valid
Conventional Commit subject (`<type>(<scope>): <imperative summary>`, matching
`^(feat|fix|refactor|docs|test|chore|perf|build|ci|style)(\([^)]+\))?: .+$` from
`CLAUDE.md`). New PRs land as drafts unless you pass `--open`; pass `--open` once the
PR is actually ready for review.

`submit`'s auto-generated title and empty body won't include this repo's other PR
conventions, so fix those up immediately after:

```bash
gh pr edit <PR#> --title "feat(infra): <group 1's actual change>" \
  --body "$(cat <<'EOF'
Closes #<issue>          # first line, only if this PR resolves an issue
<rest of the description>
EOF
)"
```

Only the branches that exist locally without a PR yet get created — if group 2's
branch doesn't exist yet (you haven't run `gh stack add` for it), `submit` simply has
nothing to do for it. This is what makes incremental submission work: submit group 1
alone, let it get reviewed while you're still deciding group 2's exact shape, and only
`gh stack add` group 2 once that's settled — the same "review findings from an earlier
group inform later ones" benefit pr-stacking.md calls out for the Pulumi and bootstrap
stacks, without having to fake it by delaying `git push`.

### 5. Add the next group and repeat

```bash
gh stack add <group-2-branch> -A -m "feat(infra): <group 2's actual change>"
```

`-A` (or `-u` to stage tracked-file changes only) is not optional here unless you've
already run `git add` yourself — confirmed by testing: `gh stack add <branch> -m msg`
with nothing staged fails outright with `nothing to commit; stage changes first or use
-A/-u`, it does not silently create an empty branch.

Puts you on a new branch based on the current top of the stack. Repeat steps 3-4 for
each group. `gh stack view` (or `--short`/`--json`) shows the whole stack's branches
and each one's PR status (`✓` merged, `◎` queued, `○` open, `⚠` needs rebase) whenever
you need to reorient — including after a context compaction or a new session, where
`gh stack checkout` (no args) opens an interactive picker across every stack you have
locally or on GitHub.

### 6. Sync as earlier PRs merge

Once group 1's PR is squash-merged into `main`, group 2's branch is based on a commit
`main` no longer has an ancestor path to in the simple sense — `gh stack sync` is what
reconciles that:

```bash
gh stack sync --prune
```

This fetches, fast-forwards local `main`, cascade-rebases every remaining stack branch
onto its (now-updated) parent, pushes everything atomically
(`--force-with-lease --atomic` — safe, not a plain force-push), and syncs each PR's
base branch and stack linkage on GitHub. `--prune` deletes local branches whose PRs
are already merged, keeping the stack's local view matching reality. Run this after
every merge in the stack, and re-run the pre-PR gate on the branch you're actively
working before opening its PR — a rebase changes the commits under it even if the code
looks the same.

### 7. Fold in review feedback

For an ordinary review comment fix: `gh stack checkout <branch>`, commit the fix, then
`gh stack sync` — this rebases every branch above it onto the fix and force-pushes the
whole stack, so dependent PRs pick up the change automatically.

For a structural change (a group needs splitting, merging into its neighbor, or
reordering): `gh stack modify` opens an interactive TUI (drop/fold/insert/reorder/rename
branches, applied together with Ctrl+S — `--abort`/`--continue` handle conflict
recovery mid-session). This one genuinely needs a human at the keyboard; if you're
driving non-interactively, propose the restructuring to the user rather than guessing
at the TUI. After `modify`, run `gh stack submit` to push the restructured branches and
update PRs on GitHub.

### 8. Clean up

Once every group's PR is merged, `gh stack sync --prune` removes the now-merged local
branches, and the stack itself disappears once nothing is left. To abandon a stack
before that (scope changed, starting over): `gh stack unstack` from within the stack
(or `gh stack unstack <stack-number>` from anywhere) removes it locally and on GitHub —
add `--local` to only drop local tracking and leave GitHub alone. Finish with the usual
worktree teardown (`ExitWorktree`, or `git worktree remove` if you used a plain
`git worktree add`).

## Command reference

| Command | Does |
|---|---|
| `gh stack init [branches...] [-b base]` | Create/adopt a multi-layer stack; each branch bases on the previous, first on `main` (or `-b`). |
| `gh stack add [branch] [-A\|-u] [-m msg]` | Add a new branch on top of the current stack; `-A`/`-u` stage changes, `-m` commits. |
| `gh stack checkout [n\|pr\|url\|branch]` | Switch to a stack; no args = interactive picker across local + GitHub stacks. |
| `gh stack view [--short\|--json]` | Show branches + PR status for the current stack. |
| `gh stack submit [--auto] [--open]` | Push branches, create/update PRs, create/update the GitHub stack object. |
| `gh stack sync [--prune]` | Fetch, cascade-rebase, push atomically, sync PR state; `--prune` deletes merged branches. |
| `gh stack modify [--abort\|--continue]` | Interactive TUI to drop/fold/insert/reorder/rename branches in the stack. |
| `gh stack unstack [n] [--local]` | Remove a stack locally and on GitHub (alias: `delete`). |

## Gotchas

- **Don't run `gh stack sync`/`modify` while a sibling branch is checked out in its own
  linked worktree** — see "One worktree for the whole stack" above. If you find one
  already set up that way (e.g. an old worktree per pr-stacking.md's literal manual
  instructions), consolidate onto a single worktree first.
- **`gh stack submit --auto` needs a Conventional-Commit-shaped commit message already
  in place** — it doesn't know this repo's title regex or `Closes #N` convention, so
  always follow up with `gh pr edit` per step 4.
- **A rebase from `sync` changes commit SHAs** — CI reruns are expected, and any PR
  description referencing "commit `abc1234`" needs updating too.
- **`gh stack modify` is interactive-only.** Don't attempt to script around it; ask the
  user to run it, or restructure by hand with `git rebase`/`git branch` if no one's
  available to drive the TUI.
- Small, self-contained changes still don't need any of this — pr-stacking.md's
  exception for a typical bug fix or one-file change applies exactly as written.
- **`gh stack add` on a branch that has zero commits of its own doesn't create a new
  layer** — it commits onto the branch you're already on instead, with a warning
  (`Branch <name> has no prior commits — adding your commit here instead of creating a
  new branch`). This can't happen if you follow step 3-then-5 in order (group N always
  has at least one commit before you `add` group N+1), but running `add` twice in a row
  out of habit won't do what you expect.
