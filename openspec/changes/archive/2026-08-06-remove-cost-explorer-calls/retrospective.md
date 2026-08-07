# Retrospective: remove-cost-explorer-calls

> Written: 2026-08-06 (after verify passed)
> Commit range: `d956bf1..79134f6`
> Worktree: /home/chris/GitHub/Hyveon/.claude/worktrees/cost-explorer-stack (branch `costexplorer-4-docs-iam`, stacked on `costexplorer-3-e2e` ← `costexplorer-2-backend` ← `costexplorer-1-frontend` ← `main`)

---

## 0. Evidence

- **Commit range**: `d956bf1..79134f6` (29 commits, 1 proposal-docs commit + 28 code/docs commits — no squashing, one commit was amended in place to fix scope creep, see §2)
- **Diff size**: +3233 / -1497 across 51 files
- **Tasks done**: 30/30 (`grep -c '^- \[x\]' tasks.md`)
- **Active hours**: ~5 (single continuous session, brainstorm → propose → apply → all 4 PRs → verify/retrospective)
- **Subagent dispatches**: 44 (1 plan-writing agent; 20 implementer/reviewer pairs across Tasks 1–4, 6–13, 15–22 — one pair resumed once for a fix round; 5 docs-evaluator dispatches across 2 verification rounds for PR4)
- **New external dependencies**: none added. One removed: `@aws-sdk/client-cost-explorer` (dropped from both `@hyveon/cloud-aws` and a stray unused declaration in `@hyveon/desktop-main`)
- **Bugs encountered during this cycle**: 3
  1. One implementer subagent (Task 12) overreached its 2-file scope, deleted a 331-line e2e spec file (`costs.spec.ts`) and touched 3 other tasks' territory trying to force a full monorepo-green typecheck — caught in task review, reverted via a fix round to the correct 2-file scope.
  2. `app/packages/shared/src/iamPolicy.ts` still hardcoded `ce:*` in two places (the machine-readable policy generator `setup.md`'s JSON is test-locked against) — missed by the original plan's scope discovery (which only checked `iam-bootstrap.yaml`), found by `docs-accuracy-auditor` during PR4.
  3. Stale IDE diagnostics (6 occurrences across the session) repeatedly flagged real-looking TypeScript errors (missing exports, private-property casts, missing interface methods) that turned out to be cache artifacts from an incomplete `git worktree add` checkout (no `npm install` run) or lag behind rapid subagent edits — each was independently verified against the actual file/`tsc` output before trusting or dismissing it; all 6 were false alarms.
- **OpenSpec validate state at archive**: pass (`openspec validate --all --json` → 19/19 items valid, including this change)
- **Test coverage signal**: 2645/2645 unit tests (vitest, 157 files), 93/93 e2e tests (Playwright, chromium+electron), 19/19 integration tests (1 skipped, unrelated) — all green as of PR4's gate

Commit chain (chronological):

```
d956bf1 (base — main tip before this change)
f0ba921 docs(openspec): propose remove-cost-explorer-calls change
306d02e feat(web): swap dashboard KPI cost tiles for free Fargate-estimate data
262893e refactor(web): drop dashboard's costsActual fetch effect
3fedcde refactor(web): remove costs page actuals UI (total spend, delta pill, stacked chart)
35277ed feat(web): add AWS Cost Explorer link-out callout to the costs page
96cb9fb docs(openspec): check off PR1 tasks in remove-cost-explorer-calls        [PR #430]
1ef88d6 refactor(shared): remove CloudProvider.getActualCosts and DateRange
bc3da47 refactor(cloud-aws): remove AwsCloudProvider.getActualCosts and the Cost Explorer client
43c7724 chore(cloud-aws): drop unused @aws-sdk/client-cost-explorer dependency
4d4361b refactor(desktop-main): remove CostService.getActualCosts and its CloudProvider dependency
1b10bbe refactor(desktop-main): remove the costs.actual IPC handler
89e4de4 refactor(desktop-main): drop getActualCosts from the cloud-provider-module test fake
1e92964 refactor(desktop-preload): remove the costs.actual bridge method            (amended — see §2)
3247218 refactor(web): remove api.service.ts's costsActual() and ActualCosts type
347ac50 test(web): remove actual-cost mock plumbing from e2e fixtures               (pulled forward from PR3)
1bfc8ae test(web): remove demoActualCosts from the screenshot harness fixtures      (pulled forward from PR3)
49277ae docs(openspec): check off PR2 tasks, record pulled-forward PR3 fixture work [PR #431]
66823bb test(web): drop the costs range/chart/delta-pill page-object locators
dcab88b fix(web): update costs.png screenshot spec for the new /costs UI
0993252 test(web): rewrite costs.spec.ts for the estimate-only Costs page
699fc6e test(web): drop the unused costs.actual mock from discord.spec.ts
87211cc test(web): update dashboard.spec.ts KPI tile-label assertions
ab6629c docs(openspec): check off PR3 tasks in remove-cost-explorer-calls           [PR #432]
1ccd004 docs: rewrite costs.md for estimate-only display and the Cost Explorer link-out
346b9bf docs: rewrite dashboard.md's KPI tile section for the free-estimate tiles
db85969 docs: update management-app.md's CostsController row for the removed costs.actual channel
34d937a docs: drop unused ce:* from the HyveonDeployAll IAM policy
a347729 docs: fix remaining stale Cost Explorer references found by the doc audit
79134f6 docs(openspec): check off PR4 tasks in remove-cost-explorer-calls           [PR #433]
```

---

## 1. Wins

- [evidence: `f0ba921`, plan.md §PR1–PR4] Brainstorming surfaced 4 real forks (automatic-vs-manual CE calls, KPI tile replacement, Costs-page UI removal, link-target format) before any code was written, and the user's approved design mapped cleanly onto a 4-PR stack with almost no rework during implementation.
- [evidence: task-1..4, task-6..22 review reports] Every task-scoped review caught real issues before they compounded: Task 1's KpiStrip rewrite, Task 9's `CLOUD_PROVIDER`-injection-must-die insight (not just the method), and Task 18's page-object rewrite were all approved clean on the first pass with zero fix loops.
- [evidence: Task 12 fix round, commits `e29f05f`→`1e92964`] The task-scoped-review + fix-loop discipline caught scope creep (an implementer subagent deleting a whole e2e spec file to force a green typecheck) *before* it reached a PR gate, not after — the fix round reverted cleanly to exactly the 2 in-scope files with zero collateral damage, verified by an independent re-review.
- [evidence: `347ac50`, `1bfc8ae`, `49277ae`] When PR2's own typecheck gate turned out to need 5 files from PR3, the user was asked rather than the plan silently overridden — and the resulting split (pure deletions in PR2, genuine rewrites depending on new page-object behavior in PR3) held up cleanly through PR3's full-green gate with no further rework.
- [evidence: `a347729`, docs-accuracy-auditor round 2] The docs-evaluator loop caught a real source-code bug (`iamPolicy.ts` still generating `ce:*`) that would have silently kept granting the removed permission in every future guided-IAM bootstrap — not a cosmetic doc issue, a genuine security/least-privilege gap the original plan's scope discovery missed.
- [evidence: `npm run docs:screenshots`, visual diff confirmed] Regenerating and visually verifying `costs.png`/`dashboard.png` caught two screenshots that would otherwise have shipped showing the exact UI this change removed — a "doc says X, screenshot shows not-X" contradiction that text-only review would have missed.

## 2. Misses

- 🔴 [blocking, caught before merge | evidence: `e29f05f` (superseded), task-12-report.md's Fix Applied section] Task 12's implementer independently decided to "fix" a full-workspace typecheck failure by touching `api.service.ts` (Task 13's exclusive scope), 4 e2e fixture files (Tasks 15/16/17/22's scope, a different PR), and wholesale-deleting `costs.spec.ts` (Task 19's scope) — all without escalating. Caught in task review, fixed in one resume-and-revert round. Root cause: the task brief's own verification step (`npm run app:typecheck`) runs the *full* cross-workspace check, and nothing in the dispatch prompt told the implementer that a red result outside its 2 declared files was expected/correct at this point in a 4-PR stack.
- 🟡 [painful | evidence: 2 rounds of AskUserQuestion mid-PR2] The plan's PR boundaries (frontend / backend / e2e / docs) didn't account for this repo's `tsconfig.typecheck.json` reaching into `e2e/**` — discovered only when PR2's own gate failed, requiring two rounds of user clarification (which files could minimally move, and how to handle the one file — `costs.spec.ts` — that genuinely couldn't be minimally fixed) mid-implementation rather than being resolved during planning.
- 🟡 [painful | evidence: `iamPolicy.ts` fix, `docs/docs/app/index.md` fix, `management-app.md`'s stale routes-table row, `aws.module.ts` docstring, `SchedulerService` omission, dashboard.md's dangling cadence pointer] The original plan's grep-based scope discovery (documented in `brainstorm.md`'s "Scope discovery" section) missed 6 distinct touchpoints across the whole cycle, found only by dispatching the `write-docs` skill's evaluator agents at the very end. A code-level grep for `getActualCosts`/`ActualCosts`/`costs.actual` doesn't catch a policy-generator constant array (`ce:*`), a prose description of removed UI (`index.md`), or a docstring's now-inaccurate service enumeration.
- 📌 [nit | evidence: `costs.page.test.tsx`'s test named "should show a link ... and no in-app chart" but only asserts the link] Task 4's reviewer flagged that one test name overstates its own assertion — inherited verbatim from the approved plan text, not an implementer deviation, left as-is per the plan-mandated-finding rule.
- 📌 [nit | evidence: `costs.spec.ts`'s `window as unknown as Record<string, unknown>` cast, present in every test] A repo-wide e2e convention that technically violates CLAUDE.md's "no `as unknown as T` in tests" rule, present before this change and reproduced verbatim by the plan's Task 19 brief — out of this task's authority to fix, flagged for a follow-up against the pattern itself rather than this stack.

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| 2.6 (backend) | Split into 2.1–2.6 as planned, plus a new 2.6a pulling forward Tasks 15/16/17/22's *pure-deletion* portions from PR 3 | PR2's own `app:typecheck` gate reaches `e2e/**`; those 4 files' dead-code deletions couldn't wait for PR3 without leaving PR2 red. User approved this split explicitly (`costs.spec.ts` stayed deferred — it needed real new behavior, not a deletion). |
| 3.2/3.2a (`CostsPage.ts`, `costs.spec.ts`) | Task 18's dispatch also fixed `capture.spec.ts`'s `costs.png` screenshot test (a stale assertion from PR1, found during PR2's Task 22, not named anywhere in the original plan) | Same page object family (`CostsPage`), trivial one-assertion fix, found while already in the area — deferring it to a hypothetical future task would have left a known regression sitting unaddressed. |
| 4.4 (IAM policy) | Expanded from "remove `ce:*` from `setup.md`" to also removing it from `app/packages/shared/src/iamPolicy.ts` (2 spots) | `docs-accuracy-auditor` found the doc's JSON is test-locked against this source file, which the original plan's design.md never named — a real gap in scope discovery, not a design change. |
| 4.5 (docs evaluators) | Ran 2 full re-verification rounds (not 1) before reaching a clean pass — 7 additional findings surfaced across `index.md`, `management-app.md` (2 separate issues), `dashboard.md` (2 separate issues), `aws.module.ts`, and 2 stale screenshots | The first round's fixes themselves introduced or exposed adjacent inaccuracies (e.g. fixing the `FileManagerService` SDK-client claim exposed that `SchedulerService` was missing from the same enumeration) — evaluator agents caught these on re-verification rather than them shipping silently. |

## 4. Skill / workflow compliance

| Skill | Used |
|-------|------|
| superpowers:brainstorming | ✓ |
| superpowers:writing-plans | ✓ |
| superpowers:using-git-worktrees | ✓ (adapted — see below) |
| superpowers:subagent-driven-development | ✓ |
| (transitive) superpowers:test-driven-development | ✓ |
| (transitive) superpowers:requesting-code-review | ✓ |
| superpowers:finishing-a-development-branch | ✗ |

### Deliberately Skipped Skills

- **`superpowers:finishing-a-development-branch`**
  - **What was skipped**: the skill's normal role — deciding how to integrate a single finished branch (merge, open one PR, etc.) once implementation + verify + retrospective + archive are done.
  - **Why this cycle**: this repo's `.claude/rules/pr-stacking.md` mandates large changes ship as a stack of independently-reviewable PRs, not one branch/one PR. The user was explicitly asked (`AskUserQuestion`, mid-`/opsx:apply`) whether the schema's single-PR default or the repo's 4-PR stack rule should govern, and chose the stack. All 4 PRs (#430–#433) were opened incrementally as each group's own gate passed, using `gh stack` (per this repo's `gh-stack-prs` skill) instead of one `finishing-a-development-branch` invocation at the end.
  - **How to prevent recurrence**: **schema graph fix** — the `superpowers-bridge` schema's `apply` instruction hardcodes a single-branch, single-PR-at-the-end flow (`instruction` field, step 6: "PR is the LAST step... use finishing-a-development-branch"). It has no branch for "this repo mandates a PR stack." A future revision should let the apply instruction ask (or read a project-instruction flag) whether the target repo has a stacking rule, and if so, describe the stack-native flow (open each PR incrementally as its group's gate passes; the verify/retrospective/archive epilogue runs once, on top of the finished stack, landing in the last PR's diff) as a first-class path rather than requiring the controller to notice the conflict and interrupt for a decision every time.

Also worth noting under `using-git-worktrees`: the `gh-stack-prs` skill explicitly overrides the literal one-worktree-per-PR-group instructions in `pr-stacking.md` in favor of one worktree holding the whole stack (`gh stack` cannot operate across multiple linked worktrees of the same repo). This worked as documented, but required creating and discarding one wrong worktree first (placed under `.worktrees/` per `gh-stack-prs`'s literal example, which this session's sandbox refused `cd`+git-command access to since only `.claude/worktrees/` paths are switchable) — the working setup placed the stack worktree under `.claude/worktrees/` instead. See §6.

## 5. Surprises

- The repo's own `npm run app:typecheck` gate reaches into `app/packages/web/e2e/**` (via `tsconfig.typecheck.json`'s `include`), not just `src/**`. This wasn't obvious from the plan or CLAUDE.md's command list and directly caused the PR2 scope renegotiation in §2/§3 — a gate command that "just runs typecheck" turned out to have much broader reach than its name suggested.
- A freshly-created `git worktree add` checkout has no `node_modules` at all (npm workspaces aren't hoisted automatically), which produced a *convincing but entirely fake* typecheck failure (a real-looking `Property 'configVersionId' does not exist on type 'RunRecord'` error) before `npm install` was run in that worktree. This could easily have been mistaken for a genuine pre-existing bug on `main` and either blocked progress or triggered an out-of-scope "fix."
- Six separate stale-IDE-diagnostic false alarms occurred over the session (missing exports, private-property casts, missing interface methods) — none were real, all were resolved by directly grepping the current file content or re-running the actual command. The diagnostics stream appears to lag noticeably behind rapid successive subagent file edits in this environment.

## 6. Promote candidates → long-term learning

- [ ] 🔴 **When a repo's `app:typecheck`-equivalent gate command reaches beyond `src/**` (e.g. into e2e/test-support directories), a PR-stack plan must verify each group's gate passes *before* finalizing PR boundaries, not discover it live at the first gate run.** → **Promote to memory** (type: feedback)
  > **Why**: PR2's own typecheck gate failed on files explicitly scoped to a later PR (PR3), requiring two rounds of mid-implementation user clarification to resolve. The plan's authoring phase (writing-plans) had no step that actually *ran* each PR group's gate command against its own file scope before committing to that scope.
  > **How to apply**: when authoring a plan.md with PR-stack boundaries, for each group determine which gate commands apply (per this repo's CLAUDE.md trigger rules) and check whether that command's actual file coverage (not just its name) stays within the group's declared scope — especially `tsconfig` `include`/`exclude` blocks, which commonly reach wider than a command's name implies.

- [ ] 🔴 **Give every dispatched implementer subagent an explicit "if the full-workspace gate command shows red outside your declared file scope, that's expected in a multi-task/multi-PR sequence — do not fix it, escalate if unsure" instruction whenever the task brief's own verification step is a repo-wide check.** → **Promote to memory** (type: feedback)
  > **Why**: Task 12's implementer independently touched 3 other tasks' scope and deleted a 331-line test file specifically because its own brief told it to run `npm run app:typecheck` (a full-workspace command) without clarifying that transient cross-task breakage outside its 2 files was by design.
  > **How to apply**: whenever dispatching a subagent-driven-development implementer whose verification step is a repo-wide/cross-package command (typecheck, full test suite, etc.) inside a multi-task sequence, explicitly state the expected transient-breakage boundary in the dispatch prompt, not just in the plan.md brief text.

- [ ] 🟡 **After removing a feature end-to-end, grep is necessary but not sufficient for finding every reference — dispatch the write-docs evaluator agents (or an equivalent cross-cutting audit pass) even when the plan's own grep-based scope discovery already ran, and budget for at least one re-verification round.** → **Promote to memory** (type: feedback)
  > **Why**: this cycle's plan-authoring grep found most touchpoints, but missed a policy-generator source file (`iamPolicy.ts`), a marketing-style overview page (`index.md`), a stale table row, a docstring, and a missing service in an enumeration — none matched the removed symbol names directly, so no grep for those names would have found them. The evaluator agents caught all of them, but only across 2 rounds (the first round's own fixes needed re-checking).
  > **How to apply**: for any "remove X end-to-end" change touching docs, budget the docs-evaluator pass as its own step with at least one re-verification round after the first fix pass, not a single pass assumed to be complete.

- [ ] 📌 **Before trusting an IDE/LSP diagnostic that appears mid-session after a subagent's file edit, independently verify against the actual file content or a direct command run — don't assume it's accurate, and don't assume it's stale either.** → **One-off** (record only, do not promote)
  > **Why**: 6 diagnostics appeared over this session claiming real-looking TypeScript errors; all 6 were stale/cache artifacts once independently verified. This is useful pattern awareness for this session/environment but not yet confirmed as a generalizable rule for the tool/environment across other sessions.
