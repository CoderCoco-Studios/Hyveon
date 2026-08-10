# PR Stacking

## Split large changes into a stack of small PRs, not one giant PR

Trigger: multi-phase migration, an OpenSpec change with independent capability areas, or >~5-6 files across unrelated concerns.

**Why:** validated 2x at scale (`migrate-iac-to-pulumi`: 8-PR stack; `add-one-click-aws-bootstrap`: 9-PR stack). A giant PR gets skimmed or over-scrutinized; small ones review reliably and let earlier findings inform later groups.

**How:**

1. Decompose along real dependencies (e.g. `tasks.md` groups), not arbitrary file counts. Order by dependency.
2. One worktree + branch per group. First group branches from `main`; each later group branches from the *previous group's branch* — see `worktree.md` (fetch/update that base first). `EnterWorktree` can't target an arbitrary branch, so use `git fetch origin <base-branch>` then `git worktree add -b <branch> .worktrees/<name> origin/<base-branch>` directly for hop 2+ — branching from the bare local `<base-branch>` skips the fetch and can silently drop commits pushed to that branch on GitHub.
3. `gh pr create --base <previous-branch>` for each PR — only the first bases on `main`.
4. Each PR independently passes the full pre-PR gate (lint, typecheck, test, +integration/e2e per CLAUDE.md) — **exit code 0, not "documented known failure."** A red CI check stays red no matter what the PR description says.
   - If an earlier PR necessarily breaks something only a later PR fixes: `test.skip()`/`test.fixme()` the specific tests (comment naming the fixing PR), or pull forward just enough of the later change to keep the file loadable. Verify via the actual exit code, not by eyeballing which failures "look expected" — then check the pushed PR's live CI run too, since a clean local run doesn't guarantee the same is true in CI.
   - Real incident (PR #430): 5 "anticipated" e2e failures still left CI red; the next stacked PR then broke Playwright's entire run via the same anti-pattern (a pulled-forward deletion crashing a test file's import).
5. Docs can land in one dedicated later PR in the stack only when the design says so explicitly (state the reason) — otherwise docs ship with the behavior change per CLAUDE.md.
6. Don't stack a normal bug fix or one-file change — this is for changes that actually decompose.
