# Retrospective: add-infra-log-viewer

> Written: 2026-08-14 (after verify passed)
> Commit range: `63a64210..5517527c`
> Worktree: `.claude/worktrees/add-infra-log-viewer` (not yet merged)

---

## 0. Evidence

- **Commit range**: `63a64210..5517527c` (13 commits)
- **Diff size**: +4123/-246 lines across 41 files (includes openspec artifacts; app-code-only diff is smaller)
- **Tasks done**: 32/32 (`grep -cE '^\s*- \[x\]' tasks.md` → 32, 0 unchecked)
- **Active hours**: ~2.5 (brainstorm+scaffold ~1h, implementation+review loop ~1.25h, verification+finish ~0.25h — single continuous session, 22:03–23:23 local)
- **Subagent dispatches**: 20 (1 plan-writing subagent, 1 plan-revision subagent, 9 task implementers, 1 fix-round implementer, 9 task reviewers, 1 docs-accuracy re-verifier, 1 final whole-branch reviewer, 1 final-fix implementer, 1 scoped re-review — some tasks needed 2 dispatches for a fix round)
- **New external dependencies**: none (reuses `@aws-sdk/client-cloudwatch-logs`, already a `LogsService` dependency)
- **Bugs encountered during this cycle**: 3 — (1) sidebar child-link label collision with pre-existing top-level nav items, found during Task 4, fixed same task; (2) a pre-existing latent bug in the chromium e2e fixture's stream stub (missing `.cancel()`), found and fixed during Task 7, unrelated to this change's own code but shared infrastructure both `/logs` and `/logs/infrastructure` e2e coverage depend on; (3) missing `ResourceNotFoundException` handling for the conditionally-provisioned `health-check` Lambda, found by the final whole-branch review, fixed in commit `5517527c`
- **OpenSpec validate state at archive**: not yet run (archive is the next step after this retrospective)
- **Test coverage signal**: 175 unit test files / 3228 tests passing (vitest); 42 integration tests passed, 1 skipped, 0 failed (Playwright tier 2); chromium e2e green for this branch's own additions (verified `--repeat-each=3`, 0 flakes); Electron-project e2e showed pre-existing, unrelated flakiness across 3 non-overlapping failure sets, ruled out as a regression (see §5)

Commit chain (chronological):

```
a0925320 feat(shared): add LambdaFunctionKey union
c0eee554 feat(desktop-main): add LogsService Lambda log methods
ab089929 feat(desktop-main): add logs.lambda IPC channels
3dbfbcc9 feat(desktop-preload): expose logs.lambda.get/stream on window.hyveon
66b94f34 feat(web): nest Logs sidebar entry into Games/Infrastructure group
e49a9ed6 fix(web): rename Logs sidebar children to Game Logs/Infra Logs to avoid label collision
709b7b05 feat(web): extract useLogTail hook from logs.page.tsx
ebe29af3 refactor(web): move logs.page.tsx onto useLogTail
18bbd3e4 feat(web): add /logs/infrastructure page with Lambda function picker
f0dcbcd0 test(e2e): add /logs/infrastructure chromium coverage
cca340f9 docs(logs): document /logs/infrastructure, lambda IPC channels, useLogTail
ce020e9a docs(openspec): add infra-log-viewer change artifacts and sync main spec
5517527c fix(desktop-main): handle missing Lambda log group gracefully
```

---

## 1. Wins

- [evidence: 9/9 task reviews approved, 1 with a single fix round] Task-scoped review caught a real, load-bearing defect (sidebar label collision, Task 4) before it could reach the final review or ship — the fix loop worked exactly as designed: ruling made, artifacts updated, fix dispatched, re-reviewed clean, all in one round.
- [evidence: `git diff --stat e49a9ed6..ebe29af3` on `logs.page.test.tsx` → empty] Task 5's hard regression gate (the existing `/logs` page's test suite must pass with zero edits after extracting `useLogTail`) held on the first attempt — independently confirmed twice (once by the task reviewer, once by the controller directly) before either review or the final review trusted it.
- [evidence: Task 7 report + independent controller re-run] A genuinely pre-existing bug (missing `.cancel()` on the chromium e2e stream stub) was found, root-caused, and fixed as a byproduct of adding new e2e coverage — the fix benefits the existing `/logs` page's e2e reliability too, not just this change's own tests.
- [evidence: final whole-branch review, "Strengths" section] The final review's cross-task consistency checks (tracing `LambdaFunctionKey` end-to-end, re-grepping for stale sidebar labels across the whole tree) found zero drift between what Task 2 defined and what Task 6 consumed six tasks later — the type-safety-first design (D1/D2) paid off.
- [evidence: docs-accuracy-auditor re-verification, 10/10 claims confirmed] Documentation was independently accuracy-checked against the real code after the implementer's own write-docs evaluator pass, rather than trusting a single self-reported pass — caught nothing wrong, but the process would have caught drift if it existed.

## 2. Misses

- 🟡 [painful | evidence: `.superpowers/sdd/plan/progress.md`, Task 9 Step 4 section] Full e2e suite (`npm run app:test:e2e`) never achieved a single all-green run across 4 attempts at varying worker counts, due to pre-existing Electron-project flakiness unrelated to this branch. Required manual per-spec isolation runs to build confidence instead of one clean CI-style pass — cost real time (~15 min of investigation) that a stable test environment wouldn't have needed.
- 🟡 [painful | evidence: this retrospective's own writing] The OpenSpec change's own artifacts (`proposal.md`, `brainstorm.md`, `design.md`, `plan.md`, `tasks.md`) sat uncommitted in the worktree from scaffolding through all 9 implementation tasks — only discovered and fixed at Task 9 (commit `ce020e9a`). Nothing was lost since it was a single continuous session, but in a session that crashed or was interrupted between scaffolding and Task 9, all planning artifacts would have been silently lost from git history.
- 📌 [nit | evidence: task-6-brief.md, task-7-brief.md, task-8-brief.md dispatch prompts] The mid-plan sidebar-label rename (ruled during Task 4) required manually re-checking every subsequent task's brief for the stale `Games`/`Infrastructure` wording before each dispatch — caught in Tasks 6, 7, and 8 each time, but this was controller vigilance, not something the plan-revision process automatically propagated (the `plan.md` rewrite after the D6 ruling was thorough; the D3 label rename's propagation into already-drafted task briefs was not similarly automated).

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| 4.1 | Sidebar child labels changed from plan's `Games`/`Infrastructure` to `Game Logs`/`Infra Logs` | Implementer found a real accessible-name collision with pre-existing top-level Configuration nav links during implementation; ruled and fixed same-task, spec/design/tasks updated to match |
| 5 (whole task) | Plan's `useLogTail` extraction approach was itself the result of a design ruling made *before* Task 5 started (D6, superseding an earlier plan draft that duplicated tail logic) — not a deviation from the executed plan, but the plan itself was revised once (by a dedicated plan-revision subagent) before any task touched code | User explicitly chose "extract a shared hook" over "duplicate the tail logic" when asked; the first `plan.md` draft (before this choice was elicited) had specified duplication |
| 9 (final review) | Added a 13th commit (`5517527c`) beyond the plan's originally-scoped 9 task groups | Final whole-branch review — a step the plan's own instruction included but couldn't enumerate specific findings for in advance — surfaced a real Important-severity gap (missing `ResourceNotFoundException` handling) not caught by any individual task's spec-compliance check, since no single task's spec text called out the conditionally-provisioned nature of `health-check`'s log group as a distinct failure mode |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✓    |
| superpowers:writing-plans                        | ✓    |
| superpowers:using-git-worktrees                  | ✓    |
| superpowers:subagent-driven-development          | ✓    |
| (transitive) superpowers:test-driven-development | ✓    |
| (transitive) superpowers:requesting-code-review  | ✓    |
| superpowers:finishing-a-development-branch       | (pending — next step after this retrospective) |

### Deliberately Skipped Skills

None skipped. `finishing-a-development-branch` is not yet invoked at the time
of writing this retrospective (its invocation is the schema's next required
step, per instruction ordering — retrospective must be written before
archive/PR, and archive happens before finishing-a-development-branch is
called) — this is sequencing, not a skip.

One notable adaptation, not a skip: the schema's apply instructions specify
`superpowers:requesting-code-review`'s `code-reviewer.md` template and imply
a dedicated `code-reviewer` subagent type; this environment's `Agent` tool
had no `code-reviewer` subagent type available (confirmed via a tool-call
error listing available types). Every review dispatch in this cycle used
`general-purpose` with the `code-reviewer.md`/`task-reviewer-prompt.md`
templates' full text embedded directly in the dispatch prompt, rather than
relying on a specialized subagent's built-in system prompt. This preserved
the review rubric and process exactly; it changed only which agent type
executed it.

## 5. Surprises

- The assumption that a single `npm run app:test:e2e` run would either pass
  or reveal real regressions cleanly turned out wrong — this environment's
  Electron-project e2e tests are flaky enough that 4 separate runs produced
  4 different failure sets, none overlapping, none in files this branch
  touched. Confirming "not a regression" required per-spec isolation runs
  and `git log`/`git diff` cross-checks rather than a single suite
  execution — a heavier verification burden than the plan anticipated for
  Task 9 Step 4.
- `logs.page.tsx` turned out to have no separately-exported live-tail
  component at all (design.md D6's context) — the spec's "reuses the same
  live-tail UI component" requirement was written assuming such a component
  might already exist to import; discovering it didn't (a monolithic page)
  is what triggered the extract-vs-duplicate design fork the user was asked
  to resolve.
- The OpenSpec `superpowers-bridge` schema's `retrospective` artifact has a
  hard PRECHECK requiring `verify.md` to contain an exact `- [x] ✅ PASS` /
  `- [ ] ⚠️ PASS WITH WARNINGS` / `- [ ] ❌ FAIL` checkbox block — the
  `opsx:verify` skill's own output template (a Summary Scorecard + Issues
  list) doesn't include this exact block by default, so it had to be added
  by hand after writing `verify.md` in the `opsx:verify` skill's native
  format, to satisfy the `retrospective` artifact's grep-based precheck.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **Commit OpenSpec change-planning artifacts (`proposal.md`/`design.md`/`tasks.md`/`plan.md`/`brainstorm.md`) immediately after each is written, not just at Task 9/pre-archive.** → **Promote to** schema (superpowers-bridge `.openspec.yaml`/skill instructions)
  > **Why**: This cycle's planning artifacts sat uncommitted through all 9 implementation tasks (~1.25h of work) before being discovered and committed at Task 9 — recoverable only because the session never crashed. A session interruption between scaffolding and Task 9 would have silently lost the entire brainstorm/design/plan history from git.
  > **How to apply**: Either the `opsx:new`/`opsx:propose`/`writing-plans` skill instructions should commit each artifact file immediately after writing it (small, frequent commits), or the schema's own step sequencing should insert an explicit "commit planning artifacts" checkpoint right after scaffolding completes, before the first `agent()`/implementer dispatch.

- [ ] 📌 **When a mid-plan ruling changes a literal string/label referenced by multiple not-yet-dispatched task briefs, grep the plan file for the old string across ALL remaining tasks before continuing, not just the task where the ruling was made.** → **One-off** (record only, do not promote)
  > **Why**: The D3 sidebar-label rename required the controller to manually catch stale `Games`/`Infrastructure` references in 3 separate later task briefs (6, 7, 8) one at a time, each just before dispatch. It worked, but relied on controller vigilance rather than a systematic check.
  > **How to apply**: N/A as a systemic rule — this is a narrow, low-frequency situation (a mid-plan ruling that changes a literal string referenced by name in later, not-yet-written task briefs) specific to this cycle's plan structure; doesn't clearly generalize into a schema-level rule without more instances to compare against.

- [ ] 📌 **`verify.md`'s free-form `opsx:verify` output format and the `retrospective` artifact's PRECHECK format (exact PASS/WARN/FAIL checkboxes) are inconsistent with each other.** → **One-off** (record only, do not promote — needs a second occurrence to confirm it's a pattern, not this cycle's one-time friction)
  > **Why**: Had to hand-add an "Overall Decision" checkbox block to `verify.md` after writing it in `opsx:verify`'s native Summary-Scorecard format, purely to satisfy `retrospective`'s grep-based precheck.
  > **How to apply**: If a future cycle hits the same friction, promote this to a schema fix (either `opsx:verify`'s template should include the checkbox block by default, or `retrospective`'s precheck should accept the Summary Scorecard's own pass/fail signal instead of requiring a specific checkbox phrasing).
