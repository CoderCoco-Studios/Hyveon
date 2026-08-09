# Retrospective: add-game-env-vars-ui

> Written: 2026-08-08 (after verify passed)
> Commit range: `4bef01b3..bdf6d81f`
> Worktree: `.claude/worktrees/add-game-server-env-vars`

---

## 0. Evidence

- **Commit range**: `4bef01b3..bdf6d81f` (12 commits)
- **Diff size**: +2100 / -66 lines across 26 files
- **Tasks done**: 23/23 (`grep -cE '^\s*- \[x\]' tasks.md` → 23)
- **Active hours**: ~2h (09:37–11:05 EDT continuous, plus a ~15min resume at 23:49 EDT after an overnight gap where one fix-round subagent's work sat uncommitted)
- **Subagent dispatches**: 17 (2 per task × Tasks 1/2/3/5/6 = 10; Task 4 = implementer + reviewer + fix + re-review = 4; final review + fix + re-review = 3)
- **New external dependencies**: none
- **Bugs encountered during this cycle**: 3 — (1) `storage-step.component.test.tsx`'s `makeDraft` missing the new `environment` field, a plan gap found during Task 3's typecheck run; (2) `EnvironmentStep`'s bare "Name" label colliding with `IdentityStep`'s in `EditGameForm`'s flat layout, found by Task 4's task reviewer; (3) stale `games-add-wizard.png` screenshot still showing "Step 1 of 5", found by the final whole-branch review
- **OpenSpec validate state at archive**: pass (21/21 items valid pre-archive, per `verify.md` §1)
- **Test coverage signal**: 2749/2749 Vitest tests (162 files) + 93/93 Playwright e2e tests, all green (per `verify.md` §5 and Task 7's gate run)

Commit chain (chronological):

```text
fc09c865 docs: propose add-game-env-vars-ui OpenSpec change
d31c86cc feat(shared): reject empty/duplicate environment variable names
92e86fa8 feat(web): add environment field to WizardDraft and route its validation
360db88d feat(web): add EnvironmentStep row editor
552edd78 feat(web): wire EnvironmentStep into add-game wizard and edit-game form
3c2495a9 fix(web): label EnvironmentStep's name field "Variable name" to avoid Name collision
5a4293fe feat(web): show environment variables in the wizard review summary
8265a941 docs: document the add-game wizard's Environment step
22ebde99 chore: check off completed tasks.md items for add-game-env-vars-ui
79497976 docs: fold storage-step.component.test.tsx fix into Task 4 of plan.md
7d595b2b fix(web,docs): regenerate stale wizard screenshot, fix five->six step comments
bdf6d81f docs: verify add-game-env-vars-ui implementation (PASS)
```

---

## 1. Wins

- [evidence: commit d31c86cc, Task 1 review] Correctly identified before any code was written that this feature needed **zero backend/IPC changes** — `environment` already flowed end-to-end through `CreateGamePayload`/`UpdateGamePayload` → `GamesWriteService` → `validateGameServer` → `gameServerSchema`. This kept the whole change to a single-PR, UI-plus-one-shared-rule scope instead of a multi-PR stack.
- [evidence: `game-https-configuration` precedent found during design.md authoring] Recognizing that this feature was a near-exact structural analog of an already-shipped feature (`https` flag: wizard step + edit-form card + validator rule) meant the design phase had a concrete, already-validated template to follow rather than inventing a new pattern.
- [evidence: Task 3 review, Task 5 review — both "Approved", zero findings] Reusing the `file_seeds` sub-editor's exact shape (optional list, no minimum, `{ field }` patch to `onChange`) for `EnvironmentStep` meant two of six tasks landed with zero review findings on the first pass.
- [evidence: Task 4 fix round 1, ledger] The task-review loop caught a real, user-facing accessibility defect (duplicate "Name" labels) that would otherwise have shipped — and traced it to an established codebase convention (`StorageStep`'s "Volume name") the implementer could point to, making the fix unambiguous rather than a judgment call.
- [evidence: final review, Task 6 report] The final whole-branch review caught a stale screenshot the per-task reviews had no way to see (screenshots aren't part of any single task's diff) — validating the "task-scoped gates + one broad final review" structure of subagent-driven-development for exactly the kind of cross-cutting issue it's designed to catch.
- [evidence: verify.md §6] The front-door routing leak detector correctly distinguished a pre-existing, unrelated `docs/superpowers/specs/` file (dated 2026-05-10, outside this change's commit range) from a current-cycle leak — no false-positive block.

## 2. Misses

- 🟡 [painful | evidence: Task 3→Task 4 handoff] Task 2's brief said "add `environment: []` to every hand-built `WizardDraft` literal in the test file" but scoped that instruction to `wizard-form.utils.test.ts` only — missing that `storage-step.component.test.tsx` had its own independent hand-built literal. This wasn't caught until Task 3's typecheck run, requiring a live plan.md correction mid-cycle (folded into Task 4 as "Step 0") rather than being complete from Task 2.
- 🟡 [painful | evidence: Task 4 implementer report "Deviations from the brief"] Task 4's implementer discovered *two more* out-of-scope typecheck/test breakages beyond the Task-3-discovered gap (`review-step.component.test.tsx`'s `makeFullDraft`, and the label-collision breaking `game-detail.page.test.tsx`) — none of which were anticipated by the plan. The plan's Task 2 "add `environment` to every `WizardDraft` literal" instruction should have been scoped repo-wide (a single `grep -rl "WizardDraft"` across all test files) rather than to one named file, which would have surfaced all four affected files (`wizard-form.utils.test.ts`, `storage-step.component.test.tsx`, `review-step.component.test.tsx`, plus confirmed `identity-step`/`networking-step` as unaffected) in one pass instead of three.
- 🟡 [painful | evidence: this session's resume gap] A fix-round subagent (Task-4-adjacent... actually the *final-review* fix subagent) kicked off a long-running background build (`npm run docs:screenshots`) and the session was interrupted for ~13 hours before resuming. The subagent's work (screenshot regenerated, doc comments fixed) was correctly present in the working tree but never got committed or reported, and the subagent itself was no longer reachable via `ListAgents` after resume — the controller had to manually re-verify and complete the commit rather than resuming the original agent's context.
- 📌 [nit | evidence: final review, Minor #2] The Task 2 → Task 5 doc-comment sweep for "five steps" → "six steps" wording missed three occurrences (`add-game-wizard.component.tsx`'s module doc + one function doc, `wizard-form.utils.ts`'s `WizardDraft` interface doc) that only the final whole-branch review caught, requiring a dedicated fix commit.

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| Task 2 (`wizard-form.utils.ts`) | Scope of "update every `WizardDraft` literal" turned out incomplete — only caught `wizard-form.utils.test.ts`, missed `storage-step.component.test.tsx` | Discovered during Task 3's typecheck run; plan.md was live-edited to fold the fix into Task 4 Step 0 rather than reopening Task 2 |
| Task 4 | Grew from the brief's 5-file scope to 7 committed files (`review-step.component.test.tsx`, `game-detail.page.test.tsx` added) plus one full fix round (label rename) | The brief's "typecheck must be fully clean" requirement surfaced two more `WizardDraft`-literal gaps and one genuine accessibility bug that no earlier task's scope covered |
| (post-Task-7) Final review | Not a task deviation per se, but added one unplanned fix-and-re-review cycle (screenshot + 3 doc comments) after all 7 tasks were otherwise "complete" | Cross-cutting issues (a committed screenshot, doc-comment prose) aren't owned by any single task's file list — exactly what the final whole-branch review step exists to catch |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✓    |
| superpowers:writing-plans                        | ✓    |
| superpowers:using-git-worktrees                  | ✗ (see below) |
| superpowers:subagent-driven-development          | ✓    |
| (transitive) superpowers:test-driven-development | ✓    |
| (transitive) superpowers:requesting-code-review  | ✓    |
| superpowers:finishing-a-development-branch       | (pending — runs after this retrospective, per the schema's own ordering) |

### Deliberately Skipped Skills

- **`superpowers:using-git-worktrees`**
  - **What was skipped**: the entire skill invocation at `subagent-driven-development`'s Setup step ("use superpowers:using-git-worktrees to create an isolated workspace or verify the existing one").
  - **Why this cycle**: the session's own harness-level instructions (a background-job system prompt, not this schema) already mandated isolating in a git worktree *before any code change*, via a different tool (`EnterWorktree`) called at the very start of the conversation, before `/opsx:propose` was even invoked. By the time `opsx:apply`'s instruction reached the `using-git-worktrees` step, the session was already on branch `worktree-add-game-server-env-vars` inside `.claude/worktrees/add-game-server-env-vars` with a clean working tree — re-invoking the Superpowers skill would have attempted to create a second, redundant worktree nested inside the first.
  - **How to prevent recurrence**: `scope-judgment rule` — when the outer harness/session has already satisfied a schema step's *intent* (isolated workspace) via an equivalent but differently-named mechanism before the schema's own step is reached, skip the schema step and record the equivalent evidence (branch name, worktree path) in its place, exactly as done here. This is not a schema defect — `using-git-worktrees` is written for the common case where no such outer isolation exists yet.

## 5. Surprises

- Expected the `WizardDraft`-literal-needs-`environment` typecheck fallout to be confined to the two files the plan anticipated (`wizard-form.utils.test.ts`, `storage-step.component.test.tsx`); it also hit `review-step.component.test.tsx` and (via the label-collision bug, not the missing-field bug) `game-detail.page.test.tsx`. TypeScript's structural typing meant every hand-built `WizardDraft`/`GameServer`-shaped literal in the test suite was a potential landmine, not just the ones the plan happened to enumerate.
- Expected `EnvironmentStep`'s generic "Name"/"Value" labels to be fine since the add-game wizard only ever renders one step at a time — didn't anticipate that `EditGameForm`'s flat, all-cards-simultaneously layout would resurrect the exact label-collision problem `StorageStep` had already solved once, because the two components (`EnvironmentStep`, `IdentityStep`) were never rendered together during Task 3's own isolated component testing.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **When a plan instructs "update every literal of shape X in file Y," scope the search repo-wide (`grep -rl` for the type name) instead of naming one file — TypeScript's structural typing means any file with its own hand-built literal of that shape is equally at risk, not just the file the plan author happened to check.** → **Promote to memory** (type: feedback)
  > **Why**: this exact gap recurred three times in one cycle (`storage-step.component.test.tsx` in Task 3, `review-step.component.test.tsx` + `game-detail.page.test.tsx` in Task 4) because Task 2's plan brief scoped the literal-update instruction to one named file instead of a repo-wide search pattern.
  > **How to apply**: whenever a plan/brief says "add field X to every existing literal of shape Y," write the instruction as a `grep -rl "<TypeName>"` search step, not a named-file list — applies to any TypeScript codebase using structural typing with hand-built test fixtures.

- [ ] 🟡 **When adding a new field/label to a component that's designed to render standalone (one wizard step at a time), explicitly check whether any *other* surface in the codebase renders it alongside sibling components simultaneously (e.g. a flat "all cards at once" form) before finalizing generic field labels.** → **Promote to project CLAUDE.md** (`CLAUDE.md` — Code & test conventions section, near the existing `EnvironmentStep`/`StorageStep` precedent)
  > **Why**: `EnvironmentStep`'s bare "Name" label was fine in isolation (Task 3's own tests) and fine in the wizard (one step at a time) but broke in `EditGameForm`'s flat layout — the exact same failure mode `StorageStep`'s "Volume name" label already prevents, but the convention wasn't written down anywhere a future component author would find it before shipping.
  > **How to apply**: when this repo's `add-game-wizard` step components are reused in `EditGameForm`'s flat layout (already true for `IdentityStep`, `ResourcesStep`, `NetworkingStep`, `StorageStep`, `EnvironmentStep`), any new step's field labels must be prefixed/qualified to avoid colliding with another step's label when both cards render on the same page — check this explicitly before merging a new step component.

- [ ] 📌 **A long-running background command dispatched by a subagent can survive a session interruption in the working tree (uncommitted) but the subagent itself becomes unreachable on resume.** → **One-off** (record only, do not promote)
  > **Why**: this happened once, was recoverable (the controller could inspect and verify the uncommitted state directly), and didn't lose any work — not yet a repeated enough pattern to justify a process change.
