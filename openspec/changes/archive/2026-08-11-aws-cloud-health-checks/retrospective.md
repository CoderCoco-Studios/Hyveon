# Retrospective: aws-cloud-health-checks

> Written: 2026-08-11 (after verify passed)
> Commit range: `e63ad3bd..27517ef3`
> Worktree: `.claude/worktrees/feat+aws-cloud-health-checks`

---

## 0. Evidence

- **Commit range**: `e63ad3bd..27517ef3` (15 commits: 13 implementation/fix + 1 verify.md + 1 checkbox-sync already counted in the 13)
- **Diff size**: +1044 / -76 lines across 23 files (implementation range `e63ad3bd..1863b449`)
- **Tasks done**: 20/20 (`tasks.md`); 39/39 step-level checkboxes (`plan.md`)
- **Active hours**: ~1 (single continuous session, 17:48–18:45 EDT)
- **Subagent dispatches**: 22 (8 implementers, 7 task reviewers, 1 lint-fix implementer + 1 lint-fix reviewer, 1 fix-round resume, 1 fix-round re-review, 1 final whole-branch reviewer, 1 final-fix-wave implementer, 1 final-fix-wave re-review) — Explore agent for AWS-import-pattern research not counted (research, not implementation)
- **New external dependencies**: none
- **Bugs encountered during this cycle**: 5 — (1) log-severity mismatch in `CloudHealthService` (brief's own sample code), (2) missing `ConfigModule` import in `WizardModule` (brief's snippet omitted it), (3) two real ESLint errors (restricted AWS SDK import, missing JSDoc) that `app:typecheck` alone did not catch, (4) `iam:GetRole` never granted on the ECS SLR path (design gap, not just implementation gap), (5) `IamCheckService`'s `SimulatePrincipalPolicy` call had no `ContextEntries`, which would have false-denied the new conditioned action for every account
- **OpenSpec validate state at archive**: not yet archived; `openspec validate --all --json` at verify time: 32/32 valid, 0 issues
- **Test coverage signal**: Vitest 3043/3043 passing across 171 files (baseline before this change: 3024/3024 across 168 files — net +19 tests, +3 files)

Commit chain (chronological):

```
e63ad3bd (merge-base with main)
9f666356 feat(shared): add HyveonServiceLinkedRoles IAM statement for ECS SLR
c0ecb1f6 feat(desktop-main): add CloudHealthService with ECS service-linked-role check
44ea6513 fix(desktop-main): use logger.error for unexpected CloudHealthService check failures
9bab3d6d feat(desktop-main): add CloudHealthController IPC surface
b7235654 feat(desktop-preload): add cloudHealth IPC bridge
3d7f066b feat(web): add cloudHealth API passthrough
12681629 fix(app): satisfy lint for CloudHealthService/Controller
1304a8f0 feat(web): add Cloud Health checklist to Settings page
bd9c2f6e docs(app): document the Cloud Health checklist
539b5b36 chore(openspec): mark aws-cloud-health-checks tasks/plan complete
e26903ab fix(shared): grant iam:GetRole on the ECS service-linked-role path
76440eae fix(desktop-main): supply IAM simulation context for AWSServiceName-conditioned actions
1863b449 fix(web): surface an inline error when the Cloud Health IPC call itself fails
27517ef3 docs(openspec): add verification report for aws-cloud-health-checks
```

---

## 1. Wins

- [evidence: 8 task-level reviews, all "Approved" with zero or Minor-only findings] The plan's task briefs were detailed enough (exact code, exact test files) that 6 of 8 implementer dispatches needed zero fix rounds — only Task 2 needed one round (log-severity fix).
- [evidence: `9bab3d6d`, task-3 report] Implementers caught and correctly fixed two real gaps in the brief's own sample code without being told to: the missing `ConfigModule` import (a real Nest DI failure the brief's snippet would have shipped) and a `react-hooks/set-state-in-effect` lint violation in `CloudHealthSection` (`1304a8f0`) — both independently verified by task reviewers against the actual codebase, not just trusted from the implementer's claim.
- [evidence: final whole-branch review, Fable 5, `539b5b36..1863b449`] The final whole-branch review caught a genuine Critical defect (`iam:GetRole` never granted) and a genuine Important cross-service regression (`IamCheckService`'s simulate call would false-deny the new action for every account) that no single task-level review could have found — Task 1 (IAM policy) never looked at `CloudHealthService.ts`'s actual `GetRoleCommand` call, and neither Task 1 nor Task 2 looked at `IamCheckService.ts` at all. This is exactly the failure mode the whole-branch review step exists to catch.
- [evidence: `openspec instructions verify`'s front-door leak detector, §6 of verify.md] Zero leakage into `docs/superpowers/specs/` — the one file found there predates this cycle by three months.
- [evidence: 171 test files / 3043 tests, 0 lint errors, 0 typecheck errors at final gate] Full three-command verification gate (`app:lint`, `app:typecheck`, `app:test`) passed clean on the first attempt after the fix wave, with no further rounds needed.

## 2. Misses

- 🟡 [painful | evidence: post-Task-5 discovery that `app:lint` had 4 real errors accumulated across Tasks 2 and 3] Per-task dispatches for Tasks 1–5 only required `npm run app:typecheck` plus the task's own test file, deferring `npm run app:lint` to "the end of the plan" as a simplification of plan.md's Global Constraints (which actually mandate lint, typecheck, and test after *every* task). This let two real ESLint errors (a restricted-import violation and two missing-JSDoc errors) accumulate silently across two already-"approved" tasks before being caught by a manual `npm run app:lint` I ran between Tasks 5 and 6 — not part of the SDD loop itself, an ad hoc check. Cost: one extra fix-and-review cycle (`12681629`) that would have been caught immediately if Task 2's or Task 3's dispatch had included lint.
- 🟡 [painful | evidence: design.md §D4, verify.md §4 Drift warning] `design.md`'s D4 decision only describes the `iam:CreateServiceLinkedRole` grant — it never mentions that the health check itself needs `iam:GetRole` on the same resource. This is a genuine planning-phase gap (predates implementation), not an implementation shortfall: the design session apparently didn't trace through what `checkEcsServiceLinkedRole()` would actually need to call before it could report `ok`/`missing`, only what `fixEcsServiceLinkedRole()` needs.
- 📌 [nit | evidence: `iamPolicy.ts` TSDoc, fixed in `e26903ab`] Task 1's own brief introduced a "the four statements" TSDoc comment that was already wrong the moment Task 1 landed a 5th statement — a small self-inconsistency in the brief's own generated prose, caught by task review as Minor and left deferred until the final fix wave folded it in.

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| Task 3 (module registration) | Added `ConfigModule` to `WizardModule`'s `imports`, not present in the brief's snippet | `CloudHealthService` (Task 2) injects `ConfigService`, which only `ConfigModule` provides/exports; the brief's `wizard.module.ts` snippet was stale relative to Task 2's actual constructor. Verified by task reviewer as a real, correctly-scoped DI-gap fix. |
| Task 6 (component) | Restructured the `useEffect`/refresh logic in `CloudHealthSection` away from the brief's literal sample code | The brief's snippet triggered a real `react-hooks/set-state-in-effect` ESLint violation (independently corroborated against 14 other files in the same package using the identical workaround pattern, including the very file this component mounts into). Functionally equivalent, verified by task reviewer. |
| (post-Task-8, pre-archive) | Added a new `HyveonServiceLinkedRoleRead` statement (unconditioned `iam:GetRole` grant) not in plan.md at all | Final whole-branch review found the design/plan never granted the permission the health check itself needs to run — a planning gap, not a task-execution deviation. Required a new IAM statement (not an extension of the existing conditioned one, since `GetRoleCommand` doesn't carry the `iam:AWSServiceName` context key). |
| (post-Task-8, pre-archive) | Added `SIMULATE_CONTEXT_ENTRIES` to `IamCheckService.ts` — a file plan.md never scoped for this change at all | Final whole-branch review found that adding a condition-gated action to `HYVEON_DEPLOY_ALL_ACTIONS` (Task 1) would silently break the existing first-run wizard's blocking permission check for every account, since AWS's policy simulator evaluates unset condition context keys as non-matching. This is a cross-capability regression-prevention fix to `cloud-bootstrap`, triggered by `aws-cloud-health`'s own Task 1 change, not scoped in the original plan. |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✓ (prior cycle — `brainstorm.md` predates this apply session) |
| superpowers:writing-plans                        | ✓ (prior cycle — `plan.md` predates this apply session) |
| superpowers:using-git-worktrees                  | ✓ |
| superpowers:subagent-driven-development          | ✓ |
| (transitive) superpowers:test-driven-development | ✓ (every implementer wrote/ran the failing test before implementing, per each task's report) |
| (transitive) superpowers:requesting-code-review  | ✓ (per-task review after every task + final whole-branch review) |
| superpowers:finishing-a-development-branch       | pending — invoked immediately after this retrospective, per the schema's step ordering |

No skills were skipped this cycle.

### Deliberately Skipped Skills

(none — table above is all ✓, `finishing-a-development-branch` is next, not skipped)

## 5. Surprises

- Assumed `npm run app:typecheck` was a sufficient interim gate between `app:lint` for early tasks, since ESLint and `tsc` usually catch overlapping classes of errors in this codebase. Wrong: `@typescript-eslint/no-restricted-imports` (a project-specific architectural boundary rule) and `jsdoc/require-jsdoc` are both ESLint-only checks with no typecheck equivalent — `tsc` reported clean on code that `eslint` rejected outright.
- Assumed (from design.md's own framing, "confirmed safe during research — this action is scopable by both resource path and the `iam:AWSServiceName` condition key") that the IAM-policy design work was complete once the `CreateServiceLinkedRole` grant was added. The design's own research apparently didn't extend to tracing what the *check* half of check/fix would need, only the *fix* half.
- Assumed the codebase's `@typescript-eslint/no-restricted-imports` rule would require a real architectural rework (moving IAM calls into `@hyveon/cloud-aws`) when first encountered. It turned out to be a well-established, documented per-file allowlist pattern (`IamCheckService.ts`, `GuidedIamService.ts` already exempted) — a 10-minute mechanical fix, not a design problem. Worth remembering: an ESLint "architecture boundary" error in this repo is often an allowlist gap, not proof the code is in the wrong layer.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **When per-task dispatches in an SDD loop simplify a plan's "run lint/typecheck/test after every task" Global Constraint down to "typecheck + one test file, lint deferred to the end," real lint-only errors (restricted-import rules, JSDoc-required rules) can silently accumulate across multiple already-"approved" tasks before being caught.** → **Promote to memory** (type: feedback)
  > **Why**: In this cycle, deferring `app:lint` to the final gate let a restricted-AWS-SDK-import violation and two missing-JSDoc errors ship through two clean-looking task reviews (Tasks 2 and 3) before a manual out-of-band lint check caught them between Tasks 5 and 6 — costing one extra fix-and-review cycle that per-task lint would have caught immediately, one task earlier, with a smaller diff to review.
  > **How to apply**: When dispatching SDD implementers task-by-task in this repo (or any repo with project-specific ESLint architecture rules like restricted-imports or required-JSDoc), include `npm run app:lint` in every task's own done-criteria, not just the final Task-N verification gate — even when the plan's own Global Constraints already say so, since that instruction is easy to silently narrow "for speed" without noticing the cost.

- [ ] 🟡 **A design doc's IAM/permission decision that only traces the "fix" half of a check/fix pair (what remediation needs) without separately tracing the "check" half (what the read/detection call needs) ships a feature whose own health check is permanently broken under the exact canonical policy the change updates.** → **Promote to memory** (type: feedback)
  > **Why**: `design.md` §D4 for this change specified only `iam:CreateServiceLinkedRole` (needed by `fixEcsServiceLinkedRole()`) and never mentioned `iam:GetRole` (needed by `checkEcsServiceLinkedRole()`, called first, every time, including immediately after a successful fix) — an omission invisible to every task-level review (Task 1 built the policy without reading Task 2's not-yet-written service code; Task 2 built the service without revisiting Task 1's policy) and only caught by the final whole-branch review reading both together.
  > **How to apply**: When reviewing or writing a design.md for any feature with a check()/fix() or read/write pair against a permission boundary (IAM, RBAC, capability tokens), explicitly enumerate the API calls each half makes and cross-check both against the proposed grant — not just the one that maps most obviously to "the fix."

- [ ] 📌 **In this repo, an ESLint "architecture boundary" error (e.g. `@typescript-eslint/no-restricted-imports` for AWS SDK clients outside `packages/cloud-aws`/`packages/lambda`) is very likely a per-file allowlist gap, not proof the new code belongs in a different package.** → **Promote to project CLAUDE.md** (`docs/docs/architecture.md` or a `.claude/rules/` note near the AWS SDK boundary, if this pattern recurs in a future change)
  > **Why**: Hitting this error mid-cycle initially looked like it might require moving `CloudHealthService`'s AWS calls into `@hyveon/cloud-aws` — a real design-level rework — until research showed the established pattern is a per-file `ignores` entry (already used by `IamCheckService.ts`, `GuidedIamService.ts`, `BootstrapService.ts`, `SchedulerService.ts`) with a justifying comment, since no cloud-agnostic IAM interface exists yet in `@hyveon/shared/cloud.js`.
  > **How to apply**: Not promoted this cycle (one occurrence, resolved quickly) — carrying forward as an unchecked candidate. Promote to a durable doc if a second change hits the same false alarm.
