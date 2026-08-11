# Retrospective: add-per-game-cost-tags

> Written: 2026-08-10 (after verify passed)
> Commit range: `29d4fda1..d96d20ce`
> Worktree: `/home/chris/GitHub/Hyveon/.claude/worktrees/add-per-game-cost-tags`

---

## 0. Evidence

- **Commit range**: `29d4fda1..d96d20ce` (8 commits)
- **Diff size**: +133 / -22 lines across 13 files
- **Tasks done**: 14/14 (`grep -cE '^\s*- \[x\]' tasks.md`)
- **Active hours**: ~1.5 (single session, apply through pre-archive)
- **Subagent dispatches**: 12 (5 implementer, 5 task reviewer, 1 final reviewer, 1 fix-wave implementer + re-review counted separately below) — precisely: 5 task implementers (Tasks 1,2,3,4,5; Task 6 run directly, no subagent), 5 task reviewers, 1 final whole-branch reviewer (opus), 1 fix-wave implementer, 1 scoped re-reviewer = 12 total
- **New external dependencies**: none
- **Bugs encountered during this cycle**: 1 — missing `ecs:TagResource` IAM grant on the followup Lambda's role, which would have broken the Discord `/start` path once `propagateTags` shipped (caught by the final whole-branch review, not by any task-level review, not by the full test suite — it's an IAM permission gap invisible to unit tests that mock the AWS SDK)
- **OpenSpec validate state at archive**: not yet run (archive step follows this retrospective)
- **Test coverage signal**: 168 test files / 2992 tests passing (full `npm run app:test` run, twice — once after Task 6, once after the fix wave)

Commit chain (chronological):

```
2fd998b1 feat(infra): tag per-game ECS task definitions and log groups with Game
e9955a1b feat(infra): tag per-game EFS-seeder Lambda and log group with Game
cf0d3a30 feat(cloud-aws,lambda-followup): propagate task-definition tags to running ECS tasks
3f1eedd8 docs(infra): document per-game Game cost allocation tag and activation step
65ec890c docs(openspec): mark add-per-game-cost-tags tasks complete
7fce84c3 fix(infra): grant ecs:TagResource to followup Lambda for tag propagation
da172079 test(infra): assert Game tag absence on shared Lambdas; docs: credit both RunTask sites
d96d20ce docs(openspec): add verify report for add-per-game-cost-tags
```

---

## 1. Wins

- [evidence: `plan.md` Tasks 1,2,4] The plan's exact-code-included format made every task-level implementer dispatch nearly zero-ambiguity — 5 implementer dispatches, 0 `NEEDS_CONTEXT`/`BLOCKED` reports, 0 fix-loop rounds at the task level.
- [evidence: `plan.md` Task 3] Task 3 (regression check for shared-resource non-tagging) was correctly scoped as verification-only with no commit — this kept the change's diff exactly matching the design's D2 scope, no accidental extra edits.
- [evidence: final review, `7fce84c3`] The final whole-branch review caught a real production-breaking gap (missing `ecs:TagResource` IAM grant) that every task-level review and the full test suite missed, because it required reasoning about IAM/AWS API semantics across two files (`iam.ts` + `handler.ts`) that no single task touched together. This is exactly the class of bug the schema's "task review ≠ final review" separation exists to catch.
- [evidence: `da172079`] The fix wave bundled 3 findings (1 Important, 2 Minor) into one dispatch + one scoped re-review, rather than three separate loops — matches the skill's "ONE fix dispatch" guidance and kept the fix-wave cost proportional to the findings.

## 2. Misses

- 🟡 [painful | evidence: final review report] The final review surfaced a 4th finding — the per-game FileBrowser ECS task (`FileManagerService.launch`) not carrying a `Game` tag — that arguably falls within the design's stated Goal ("every resource whose cost is independently metered per game") but wasn't enumerated in the plan's Global Constraints or the design's Non-Goals. This was a genuine design gap discovered late (at final review, not brainstorm/design time), and required a scope judgment call under time pressure rather than a clean design decision.
- 📌 [nit | evidence: task-1/2/4 implementer reports] Two of the five task implementers (Tasks 1, 2) ran on the cheapest model tier and both completed cleanly with zero review findings — confirms the model-tier guidance ("plan contains the complete code → cheapest tier") was well-calibrated for this plan's mechanical tasks.

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| (post-plan, final review) | Added `ecs:TagResource` IAM grant + test to `iam.ts`/`iam.test.ts` — not in the original plan/tasks.md at all | Final whole-branch review found `propagateTags` (Task 4) is inert without this IAM grant on the followup Lambda's role; the desktop app path was unaffected since its operator policy already grants `ecs:*` |
| 4.1 (docs) | Docs section named only `AwsCloudProvider.startWorkload` initially; expanded to name both `RunTask` call sites | Final review noted the followup Lambda's `runStart` path is equally load-bearing and was omitted from the doc's propagation explanation |
| 3.2 (regression check) | `lambdas.test.ts` originally asserted exact tags for only the followup Lambda among the four project-wide Lambdas; extended to interactions/watchdog/dns-updater | Final review found the task's own claim ("shared resources asserted Game-free") was only partially true — 3 of 4 project-wide Lambdas had no tag assertion at all |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | n/a (pre-dates this apply session; done in an earlier cycle per `brainstorm.md`) |
| superpowers:writing-plans                        | n/a (plan.md pre-existed this apply session) |
| superpowers:using-git-worktrees                  | ✓ |
| superpowers:subagent-driven-development          | ✓ |
| (transitive) superpowers:test-driven-development | ✓ |
| (transitive) superpowers:requesting-code-review  | ✓ |
| superpowers:finishing-a-development-branch       | (pending — runs after this retrospective + archive, per schema step 6) |

### Deliberately Skipped Skills

None. `brainstorming` and `writing-plans` were not skipped within this cycle — they were completed in a prior cycle (this apply session picked up an already-planned change with `plan.md` at `status: done`). No skill in the apply-phase flow was bypassed.

## 5. Surprises

- The assumption that "task-level review + full test suite = sufficient" turned out wrong for this change: the IAM permission gap was invisible to both, since `iam.test.ts` and `handler.test.ts` are separate suites that never assert consistency between what a Lambda's policy grants and what its own `RunTaskCommand` calls require. Only a reviewer reading both files together (the final whole-branch review, on the most capable model) caught it.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **When adding a new field to an SDK command input in Lambda code (e.g. `propagateTags` on `RunTaskCommand`), check whether the Lambda's IAM policy grants the additional permission that field requires — task-level review of the SDK call site alone won't catch a missing sibling grant in `iam.ts`.** → **Promote to memory** (type: feedback)
  > **Why**: This change's `propagateTags: 'TASK_DEFINITION'` addition (Task 4) silently required `ecs:TagResource` on the caller's IAM role; the gap survived 2 task reviews and a full 2992-test suite run, and was only caught by the final whole-branch review reading `iam.ts` and `handler.ts` together.
  > **How to apply**: Whenever a Hyveon change adds an AWS SDK command field that changes what the call *does* (not just an input shape — e.g. requesting tag propagation, enabling a new IAM-gated action), cross-check the calling Lambda/service's IAM policy in `app/packages/infra/src/iam.ts` for the matching permission before considering the task done.

- [ ] 📌 **A plan's Global Constraints resource list can omit a resource that's in scope by the design's stated Goal wording but wasn't enumerated (here: the per-game FileBrowser ECS task).** → **One-off** (record only, do not promote)
  > **Why**: Single occurrence so far; not yet a repeated pattern worth a schema/skill change. Tracked here so a second occurrence with the same shape becomes a §6 promote-in-place candidate for tightening the `writing-plans`/`brainstorming` skill's Global Constraints enumeration step.
