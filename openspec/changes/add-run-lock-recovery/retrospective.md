# Retrospective: add-run-lock-recovery

> Written: 2026-08-10 (after verify passed)
> Commit range: `29d4fda1..475cfb60`
> Worktree: `.claude/worktrees/add-run-lock-recovery` (branch `worktree-add-run-lock-recovery`)

---

## 0. Evidence

- **Commit range**: `29d4fda1..475cfb60` (15 commits)
- **Diff size**: +1119 / -47 lines across 18 files
- **Tasks done**: 28/28 (`grep -cE '^\s*- \[x\]' tasks.md`)
- **Active hours**: ~1 (single continuous session, ~22:31–23:45 EDT)
- **Subagent dispatches**: 21 (9 implementers + 2 fix-round implementers + 9 task reviewers + 1 final whole-branch reviewer + 1 final-review fix wave + 1 final-review scoped re-review — counted individually: 9 task implementers, 2 fix-loop implementers (Tasks 2, 8), 9 task reviewers, 2 scoped re-reviews (Tasks 2, 8), 1 final reviewer, 1 final fix wave, 1 final scoped re-review = 25 dispatches total)
- **New external dependencies**: none
- **Bugs encountered during this cycle**: 3 — (1) `mintLockClearConfirmationToken`'s `store.getRunLock()` call missing try/catch, violating the repo's no-raw-SDK-error invariant, caught by Task 2's review; (2) e2e mock for `iac.runs.lock.clear` not verifying the received `confirmationToken`, caught by Task 8's review; (3) `IacPlanAck.runLock` field added to `desktop-main`'s controller type (Task 5) but not mirrored into the preload's separate `IacPlanAck` type, caught and self-fixed by Task 7's implementer before it could reach review as a build break
- **OpenSpec validate state at archive**: pass (`openspec validate add-run-lock-recovery` → "Change 'add-run-lock-recovery' is valid")
- **Test coverage signal**: vitest 3018/3018 unit tests (168 files), Playwright integration 42 passed/1 skipped, Playwright e2e 94/94

Commit chain (chronological):

```
29d4fda1 test(web): add Tier-2 integration coverage for Pulumi orchestration (#485)   [base]
ffdcf9cd feat(desktop-main): add RunLockClearNotConfirmedError
fa7f4476 feat(desktop-main): add RunService.mintLockClearConfirmationToken
fb6414cb fix(desktop-main): catch getRunLock failure in mintLockClearConfirmationToken
65a5af55 feat(desktop-main): add RunService.clearLock confirmation-gated release
5f572d19 feat(desktop-main): add iac.runs.lock.clear IPC channels
9c5ae2f5 feat(desktop-main): attach held RunLock to plan/apply/destroy acks
409f9e9f feat(desktop-preload): expose iac.runs.lock mint/clear bridge
e0bec635 feat(web): add Clear lock and retry action to BusyBanner
7589c52a test(e2e): cover run-lock clear-and-retry flow
8e1b6870 test(e2e): assert confirmation token on run-lock clear mock
cf5ac48d docs: document run-lock clear-and-retry recovery
7e4b83fc chore(openspec): mark add-run-lock-recovery tasks complete
1e9755f1 fix: address final review findings for run-lock recovery
475cfb60 docs(openspec): add verify report for add-run-lock-recovery
```

---

## 1. Wins

- [evidence: `fb6414cb`, Task 2 review] Task-scoped review caught a real, non-hypothetical invariant violation (raw SDK error escaping uncaught) that traced directly to the plan's own sample code omitting a try/catch — the controller stopped and asked the human which should govern (plan text vs. binding project rule) rather than silently picking one, per the skill's explicit "plan conflicts are the human's decision" rule.
- [evidence: `1e9755f1`, final review] The final whole-branch review — dispatched separately from all 9 task-scoped reviews, on a more capable model — caught a real gap that no individual task review could see: two plan checkboxes (5.4's failing-clear test, 1.6's table-unconfigured `clearLock` test) were marked `[x]` but the tests were never written. This is exactly the class of defect the schema's two-tier review (task-scoped + final) is designed to catch, and it worked as designed.
- [evidence: Task 7 report] An implementer self-caught and self-fixed a cross-task gap (Task 5's `IacPlanAck.runLock` field wasn't mirrored to the preload's separate type) mid-task, before it could surface as a build break in a later task — flagged prominently in its own report rather than silently patched, giving the controller a clean audit trail.
- [evidence: final review report] Independent adversarial verification of the core security property (token-to-lock binding preventing cross-run lock release) traced all the way to `AwsRunRecordStore.releaseRunLock()`'s conditional `DeleteItem` (`ConditionExpression: 'runId = :runId'`) as the actual last line of defense against a cross-process TOCTOU race — confirming defense-in-depth beyond just the in-process token check the plan described.
- [evidence: 9/9 task reviews] Every "stale" IDE diagnostic surfaced mid-session (missing exports, type mismatches) was cross-checked against a real `tsc -b`/`npm run app:test` run before being acted on, and in every case turned out to be editor-cache staleness or a pre-existing test-file-only issue (test files are excluded from `tsc -b` per `tsconfig.json`) rather than a real regression — avoided wasted fix cycles on phantom problems.

## 2. Misses

- 🟡 [painful | evidence: Task 2, Task 8 reviews] Two of nine tasks needed a fix round despite the plan providing complete sample code for both — in both cases the plan's own given code had a defect (missing try/catch; a mock that didn't validate its own input) that the task reviewer, not the implementer, caught. Complete sample code in a plan is not a substitute for review.
- 🟡 [painful | evidence: final review] Two plan checkboxes were checked without their required test actually existing (task 5.4's failing-clear case, task 1.6's table-unconfigured case) — this happened inside task implementers' own self-review, not caught until the final whole-branch review. The individual task reviewers verified the tests that *were* written against the brief's code sample, but neither cross-checked the tasks.md checkbox text's *full* enumerated list against what the diff actually covered — a systematic near-miss worth naming for future cycles.
- 📌 [nit | evidence: session-wide] Stale IDE diagnostics fired after nearly every subagent dispatch throughout the session (9+ occurrences), all false positives from editor-cache lag. Not a defect in the work, but each one cost a manual `tsc -b`/`git show --stat` round-trip to rule out — a cheap but repeated tax.

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| 1.3/1.4 (mint/assert) | Plan's Step 3 sample code omitted a try/catch around `store.getRunLock()` in both methods; implementation adds it | Task 2 review flagged the omission as a binding-invariant violation; human explicitly chose to fix over following the plan verbatim (see `[[feedback-final-review-not-redundant]]`-adjacent judgment: plan text isn't self-grading) |
| 6.3 (mock seam) | Brief's suggested `preload.test.ts` search anchor (`iac.lock.clear.mintToken`) didn't exist in the real file; implementer substituted the closest real analog (`iac.destroy.mintToken` pattern) | Verified via `git show` on the base commit that the brief's premise about file contents was simply wrong, not a shortcut — task reviewer independently confirmed |
| 8.2 (e2e spec) | Brief's placeholder API (`ipc.mockOnce`, `confirmDialogConfirmButton()`) didn't exist; implementer used the real `window.hyveon.__test.mock()` seam and the actual `'Clear lock'` accessible name | Same category as above — brief's illustrative code was approximate, not literal, for this file |
| 5.4 / 1.6 (test enumeration) | Two specified test cases (failing-clear UI path, table-unconfigured `clearLock`) were checked off without being written; added in the final-review fix wave (`1e9755f1`) | Caught by final whole-branch review, not any task-scoped review — see §2 |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✓ (prior cycle — brainstorm.md pre-existed) |
| superpowers:writing-plans                        | ✓ (prior cycle — plan.md pre-existed, fully detailed) |
| superpowers:using-git-worktrees                  | ✓ (via `EnterWorktree` native tool) |
| superpowers:subagent-driven-development           | ✓ |
| (transitive) superpowers:test-driven-development | ✓ (every task's implementer wrote failing tests first per their brief) |
| (transitive) superpowers:requesting-code-review  | ✓ (9 task reviews + 1 final whole-branch review, both fix loops scoped-re-reviewed) |
| superpowers:finishing-a-development-branch       | pending (next step after this retrospective) |

> **Default expectation**: all ✓. No skills were skipped this cycle.

### Deliberately Skipped Skills

(none — all applicable skills were used)

## 5. Surprises

- The plan's Step-3/Step-1 sample code, though extensive and mostly copy-pasteable, was wrong in three separate places about this codebase's actual current state (missing try/catch per the logging invariant; a `preload.test.ts` test pattern that doesn't exist; an e2e mock API that doesn't exist) — a reminder that even a very detailed plan should be treated as a strong draft for the implementer to verify against the real repo, not a literal transcript, especially for glue code (test harnesses, mock seams) that the plan author couldn't directly execute while writing it.
- IDE/LSP diagnostics fired as "new" after nearly every single subagent commit throughout the session, always as stale-cache false positives (confirmed by real `tsc -b` runs). This was consistent enough across 9+ occurrences to treat as a structural quirk of this environment rather than a per-task anomaly — worth remembering for future sessions in this repo so the same verification dance doesn't need to be rediscovered.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **A detailed implementation plan's sample code can still be wrong about invariants (missing try/catch) or about the target file's actual current contents (test harness APIs) — task review must verify against the real repo, not treat plan-given code as ground truth.** → **Promote to memory** (type: feedback)
  > **Why**: Two of nine tasks in this cycle needed a fix round specifically because the plan's own given code omitted a required try/catch or invented a test API that didn't exist in the real file — in both cases the task reviewer, not the plan author, caught it.
  > **How to apply**: When reviewing a subagent-driven-development task whose brief embeds full sample code, still verify the sample against the repo's binding invariants (CLAUDE.md / `.claude/rules/*.md`) and against the actual target file's current contents before trusting it as correct.

- [ ] 🟡 **A final whole-branch review can catch checkbox/test-coverage mismatches that no individual task review can see, because task reviews are scoped to one task's diff and can't cross-check the full enumerated test list in tasks.md against what was actually written across all tasks.** → **Promote to memory** (type: feedback)
  > **Why**: Two plan-specified test cases (task 5.4's failing-clear path, task 1.6's table-unconfigured path) were marked `[x]` and passed their own task review, but the actual test code was missing — only surfaced by the final whole-branch review dispatched after all 9 tasks completed.
  > **How to apply**: When a task's brief enumerates multiple specific test scenarios, before marking that task complete, count that the number of new `it(...)` blocks in the diff matches the number of enumerated scenarios — don't rely solely on "tests pass" as proof all scenarios were written.

- [ ] 📌 **IDE/LSP diagnostics reported after subagent tool calls in this repo/environment are frequently stale-cache false positives, not real regressions — always verify with a real `tsc -b`/`npm run app:typecheck` run before treating one as a finding.** → **One-off** (record only, do not promote — likely an environment/tooling quirk rather than a durable cross-repo pattern worth a standing memory rule)
  > **Why**: Occurred 9+ times in this single session, always resolving to false positives on independent verification (either genuinely stale, or real-but-pre-existing test-file-only issues excluded from the actual build gate).
