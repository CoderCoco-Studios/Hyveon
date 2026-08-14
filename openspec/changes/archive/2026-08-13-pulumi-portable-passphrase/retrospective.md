# Retrospective: pulumi-portable-passphrase

> Written: 2026-08-13 (after verify passed)
> Commit range: `c8c6d027..d7ea6c6d`
> Worktree: `.claude/worktrees/pulumi-portable-passphrase` (branch `worktree-pulumi-portable-passphrase`)

---

## 0. Evidence

- **Commit range**: `c8c6d027..d7ea6c6d` (10 commits)
- **Diff size**: +1032 / -705 lines across 15 files (`app/packages/desktop-main/src/**`, `app/eslint.config.js`, `docs/docs/components/infra.md`, `docs/docs/app/first-run-wizard.md`, `openspec/changes/pulumi-portable-passphrase/tasks.md`)
- **Tasks done**: 23/24 (`grep -cE '^\s*- \[x\]' tasks.md` → 23; item 6.5, real-AWS second-credential-set verification, explicitly deferred to the operator per plan.md's own scope boundary)
- **Active hours**: ~1.7 wall-clock hours (background-subagent-parallelized; most elapsed time was waiting on dispatched subagents, not synchronous human-facing work)
- **Subagent dispatches**: 21 (4 for Task 1 incl. 2 fix rounds; 4 for Task 2 incl. 1 fix round; 2 for Task 3; 2 for Task 4; 6 for Task 5 docs — 2 writers + 3 evaluators + 1 accuracy re-check; 0 for Task 6, run directly; 1 final whole-branch review; 1 final fix wave; 1 final scoped re-review)
- **New external dependencies**: none. `execa` was considered for Task 3's CLI invocation and explicitly rejected in favor of `node:child_process.spawn` (no new dependency needed). `aws-sdk-client-mock` was adopted more heavily in test code but was already an existing dependency.
- **Bugs encountered during this cycle** (introduced-then-caught-by-review, not pre-existing codebase bugs): 7
  1. Task 1: `as unknown as STSClient` cast in tests violated the repo's no-cast rule (task review finding)
  2. Task 1 fix round 1's own remedy (`vi.spyOn` on a real `STSClient`) had genuine TypeScript type errors invisible to `npm run app:typecheck` (controller-caught via IDE diagnostics, not review)
  3. Task 2: `resolveAwsAccountId`'s STS call escaped `getOrCreateStack`'s try/catch uncaught, violating `.claude/rules/logging.md` (task review finding, ruled plan-defect)
  4. Task 2: a test-file-only cast (`FakeWorkspace as Record<string, unknown>`) broke after `listStacks` was removed from the fixture (task review finding)
  5. Task 2: TSDoc tag ordering violation (Minor, task review finding)
  6. Final whole-branch review: `SafeStorageService.decrypt` silently returns raw ciphertext on keychain-unavailable rather than throwing — the migration call site only checked passphrase *presence*, not keychain *availability*, producing a misleading CLI error instead of an actionable one (Important finding)
  7. Docs: one wrong factual claim ("Starting Over has no stored passphrase to preserve," ignoring the pre-migration window) plus two imprecise claims (phase-table timing attribution, old passphrase's actual storage location) — accuracy-auditor finding
- **OpenSpec validate state at archive**: pass (33/33 items valid, 0 issues on this change's own spec/change entries)
- **Test coverage signal**: vitest — 3132/3132 unit tests passing (full workspace), 96/96 in the two most-touched files (`PulumiWorkspaceService.test.ts` + `ElectronStoreService.test.ts`) after the final fix wave; 42 passed/1 pre-existing skip on the integration suite

Commit chain (chronological):

```
c8c6d027 feat(infra): propose portable Pulumi secrets passphrase (#510)   [merge-base]
c2266122 wip(infra): add deriveStackPassphrase and resolveAwsAccountId (Task 1/6)
d88d980c fix(infra): remove unnecessary type cast from STS client test stubs (Task 1 fix round 1)
ff4df306 fix(infra): use aws-sdk-client-mock for STS mocking in resolveAwsAccountId tests (Task 1 fix round 2)
964c26a6 feat(infra): derive the Pulumi secrets passphrase from the AWS account instead of storing it
5067f0e3 fix(infra): catch/normalize STS failures and fix test-only type issues (Task 2 fix round 1)
291abdf6 feat(infra): migrate installs with a legacy stored Pulumi passphrase to the derived one automatically
98e5e308 refactor(infra): remove the dead passphrase-unavailable error machinery replaced by derivation
9ef189ad docs(infra): document the derived, portable Pulumi secrets passphrase
12220b0e chore(infra): mark Task 6 verification gate complete in tasks.md
d7ea6c6d fix(infra): fail clearly when the keychain is unavailable during legacy passphrase migration
```

---

## 1. Wins

- [evidence: `291abdf6`, `PulumiWorkspaceService.ts:379-436`] Task 3's spike (determining the `pulumi` CLI's non-interactive `stack change-secrets-provider` contract, since the Automation API SDK has no typed method for it) was resolved with unusually strong evidence: a source read at the exact pinned tag (`v3.255.0`) *and* an empirical end-to-end CLI run against a scratch `file://` backend, showing the old passphrase failing and the new one succeeding. The final whole-branch reviewer independently re-fetched the same Pulumi source and confirmed every claimed detail (stdin sequence, `--non-interactive` flag, env var contract) matched exactly.
- [evidence: `d88d980c`, `ff4df306`] The task-review → fix-round → re-review loop caught a real defect the first fix attempt introduced: replacing a cast-rule violation with `vi.spyOn` on a real client produced genuine TS errors invisible to `npm run app:typecheck` (test files are excluded from that build's tsconfig). The controller caught this via IDE diagnostics before dispatching review, and round 2 switched to the repo's already-established `aws-sdk-client-mock` convention, which the re-review independently confirmed compiles clean.
- [evidence: final whole-branch review report, Important finding #1] The whole-branch review caught a cross-task interaction no single task-scoped review could see: Task 2 removed `SafeStorageService` from `PulumiWorkspaceService`'s constructor (it looked unused after old code was slated for deletion), which silently dropped the keychain-availability guard the old code had, only surfacing as a problem once Task 3's migration logic needed exactly that guard. This is the schema's structural argument for a final whole-branch pass in one sentence.
- [evidence: `9ef189ad`, docs-accuracy-auditor report] The docs pass caught a real overclaim before it shipped: "Starting Over" originally said there's no stored passphrase to preserve, full stop — true for a migrated install, false during the migration window, where `FirstRunWizardService.reset()` deliberately preserves the legacy value. Caught by an independent accuracy audit against the actual `reset()` doc comment, not assumed correct because it "sounded right."
- [evidence: `98e5e308` review report] The largest, deletion-heaviest task (removing all the old passphrase machinery + fixing three call sites in `PulumiService.ts`) came back Approved with zero fix rounds — both self-flagged pieces of unplanned fallout (removing the now-unused `safeStorage` constructor param, fixing two test files not named in the brief) were independently verified as correctly scoped by the reviewer.

## 2. Misses

- 🟡 [painful | evidence: bug #6 above] The `SafeStorageService` constructor dependency was removed in Task 2 as dead weight without anyone (implementer or task reviewer) asking "does anything downstream still need this?" — Task 3, dispatched afterward with no visibility into Task 2's internal reasoning, inherited a codebase that could no longer check keychain availability, and needed a new dependency-restoration seam bolted on after the fact in the final fix wave rather than being designed in from the start.
- 🟡 [painful | evidence: bugs #1, #4 above] Two separate test-file-only TypeScript errors (an `as unknown as T` cast and a broken `Record<string, unknown>` cast) were invisible to `npm run app:typecheck` because `desktop-main`'s `tsconfig.json` excludes `*.test.ts` from that build. Both were caught only because the controller independently ran ad hoc scratch `tsc --noEmit` checks with the exclusion lifted — this is not part of the repo's standard CI gate, so an implementer or reviewer relying solely on `npm run app:typecheck` would have missed both. This structural blind spot recurred at least 3 times across the cycle (Task 1, Task 2, and the final fix wave's own verification step) and was worked around ad hoc each time rather than fixed once.
- 📌 [nit | evidence: coverage-auditor report] `tasks.md` checkboxes went unmarked for all of Tasks 1-4 despite each task's implementer/controller loop completing successfully — caught only by the docs-coverage-auditor during Task 5, not by the SDD process itself, and fixed retroactively rather than incrementally as the built-in `apply` instruction actually specifies ("Mark task complete in the tasks file... immediately after completing each task").

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| Task 1 | Two extra fix rounds (cast-rule violation, then a broken `vi.spyOn` remedy) before landing on `aws-sdk-client-mock` | Plan's own code sketch didn't specify a test-mocking mechanism for the new `stsClientFactory` seam; the first two attempts violated either a repo style rule or produced real (if build-invisible) type errors |
| Task 2 Step 2.1 | The brief's own code sketch placed `resolveAwsAccountId`'s call outside `getOrCreateStack`'s try/catch, letting a raw STS error propagate uncaught — ruled a plan defect (not implementer error) against `.claude/rules/logging.md`, and fixed with a localized catch in fix round 1 | The plan's own "matches existing precedent" justification for the uncaught call turned out not to hold: the cited precedent (`resolveCredentialEnvVars`) makes no external call at all, so there was no actual precedent to match |
| Task 5 | No `plan.md` deviation, but the docs pass went through one full accuracy fix round (3 fixes) that the plan's own Step 5.2 anticipated only loosely ("verify against the current file rather than assuming a specific caveat exists") | The plan flagged the *risk* of stale assumptions correctly, but the actual gap (the migration-window exception in "Starting Over") wasn't itself anticipated in the plan text — it only surfaced once the docs-accuracy-auditor cross-checked the new prose against `FirstRunWizardService.reset()`'s real doc comment |
| (post-Task-6) | An unplanned final-review fix round (5 findings: 1 Important + 4 Minor) not present as a plan task at all | This is exactly the schema's designed behavior — the final whole-branch review is a distinct gate from the per-task plan, specifically to catch what task-scoped work can't see |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✓ (prior cycle — this change's brainstorm.md and proposal predate this apply session; verified present and read as context) |
| superpowers:writing-plans                        | ✓ (prior cycle — plan.md existed and was read; not re-authored this session) |
| superpowers:using-git-worktrees                  | ✗ (see below) |
| superpowers:subagent-driven-development          | ✓ |
| (transitive) superpowers:test-driven-development | ✓ (every implementer task followed RED/GREEN, verified in task reports) |
| (transitive) superpowers:requesting-code-review  | ✓ (task-scoped reviews + final whole-branch review, both using the code-reviewer template) |
| superpowers:finishing-a-development-branch       | ✓ (used after this retrospective, per the schema's own instruction ordering) |

> **Default expectation**: all ✓. Every skill is part of the schema's
> design — skipping one is an exceptional situation. Any ✗ MUST have its
> reason and prevention plan stated below in the
> `### Deliberately Skipped Skills` subsection.

### Deliberately Skipped Skills

- **`superpowers:using-git-worktrees`**
  - **What was skipped**: the entire skill invocation for workspace setup.
  - **Why this cycle**: this session runs inside a harness (Claude Code background job) with its own native `EnterWorktree` tool, which the session's system prompt mandates using for any tracked-file change ("Before making any code changes, use the EnterWorktree tool to isolate your work"). `EnterWorktree` was called before any edits (creating `.claude/worktrees/pulumi-portable-passphrase` on branch `worktree-pulumi-portable-passphrase`) and functionally satisfies the same isolation goal the Superpowers skill exists to provide, before `subagent-driven-development`'s own Setup step was reached.
  - **How to prevent recurrence**: `scope-judgment rule` — when the invoking harness already provides a first-class, system-prompt-mandated worktree-isolation mechanism that is functionally equivalent to (and takes precedence over, per the harness's own instructions) the schema's `using-git-worktrees` skill, treat the harness's native isolation as satisfying that skill's requirement rather than double-invoking. This is a genuine harness-boundary case, not a shortcut: the two mechanisms do the same thing (create an isolated git worktree + branch before edits), and the harness's own system prompt is a higher-priority instruction layer than the schema.

> **Relationship to §6 Promote candidates**: if multiple cycles skip the
> same skill with the same `How to prevent` answer → that pattern should be
> promoted to §6 and directly trigger a schema / skill PR — it must not be
> allowed to accumulate into "the new normal".

## 5. Surprises

- The plan's own Step 2.1 code sketch, written after "re-inspecting the actual code line-by-line," still got the try/catch boundary wrong relative to `.claude/rules/logging.md` — a reminder that a plan's self-review checklist checking its own internal consistency (which this plan's did, thoroughly) doesn't substitute for checking consistency against project-wide rules that live outside the plan's own scope.
- `SafeStorageService.decrypt` not throwing on keychain-unavailable (silently returning raw ciphertext instead) was surprising given the rest of this service's error-handling discipline is unusually careful — it's the kind of "quiet degradation" behavior that's easy to miss when reading a function's happy path and much harder to miss once a downstream consumer (the migration code) actually depends on the failure being loud.
- The test-file-typecheck blind spot (`desktop-main/tsconfig.json` excluding `*.test.ts`) was surprising in how consistently it produced real, non-hypothetical bugs (3 separate instances across the cycle) rather than being a theoretical risk — every time an ad hoc scratch check was run to double-check a diagnostic, it found something real.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **`desktop-main`'s `tsconfig.json` excludes `*.test.ts` from the build tsconfig, so `npm run app:typecheck` never catches real type errors introduced in test files — this recurred 3 times in one implementation cycle.** → **Promote to project CLAUDE.md** (`CLAUDE.md` — "Before opening a PR" section, alongside the existing lint/typecheck/test bullet list)
  > **Why**: three separate real TypeScript errors in test files (an unnecessary cast, a broken cast after a fixture field was removed, and — caught independently, not part of this cycle's own bugs — a pre-existing 144-error backlog across 13 unrelated test files) were all invisible to the documented `npm run app:typecheck` gate. Every instance in this cycle was caught only because an implementer or the controller manually ran a scratch `tsc --noEmit` with the test-file exclusion temporarily lifted — an undocumented, ad hoc workaround, not a repeatable check.
  > **How to apply**: either (a) add a genuine `tsconfig.test.json` (mirroring `@hyveon/web`'s existing `tsconfig.typecheck.json` pattern) that includes test files and wire it into `app:typecheck` for `desktop-main` specifically, or (b) if that's deliberately out of scope for a reason not visible in this cycle, at minimum document the blind spot explicitly in CLAUDE.md's "Before opening a PR" section so implementers know `npm run app:typecheck` passing doesn't guarantee test files type-check, and know the scratch-tsconfig workaround this cycle used repeatedly.

- [ ] 🟡 **Deleting/removing a constructor dependency during a mid-sequence task (here: `SafeStorageService` in Task 2) because it "looks unused after this task's own edits" is risky when a *later* task in the same plan hasn't been implemented yet and might need it.** → **Promote to `~/.claude/rules/rnd-subagent-delegation.md`** (or the SDD skill's own dispatch guidance)
  > **Why**: Task 2's implementer correctly observed `SafeStorageService` was unused *after Task 2's own deletions*, and removed it — reasonable in isolation, but it silently removed a capability (keychain-availability checking) that Task 3's migration logic, dispatched later with no visibility into Task 2's reasoning, needed and had no way to know was missing until the final whole-branch review caught it.
  > **How to apply**: when a plan's own multi-task sequence removes a dependency/capability mid-sequence because a specific task's diff makes it locally unused, the task brief (or the controller's dispatch context) should flag it explicitly to the controller as a "removed capability — confirm no later plan task needs this" checkpoint, rather than leaving it to be caught only by the final whole-branch review (which works, but is the most expensive and last-possible place to catch it).

- [ ] 📌 **`tasks.md` checkboxes should be updated incrementally per-task (as the built-in `apply` instruction specifies), not batched and caught later by an unrelated docs-coverage audit.** → **One-off** (record only, do not promote)
  > **Why**: this cycle's own controller simply forgot the checkbox-update step for Tasks 1-4 and only fixed it retroactively after the docs-coverage-auditor happened to flag it as a side observation during Task 5 — a single missed habit, not a schema or tooling gap (the instruction to update checkboxes immediately already exists and is clear).
