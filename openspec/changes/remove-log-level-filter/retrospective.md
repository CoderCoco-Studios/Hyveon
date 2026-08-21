# Retrospective: remove-log-level-filter

> Written: 2026-08-21 (after verify passed)
> Commit range: `bc62c595dda3..03bfd217`
> Worktree: `.claude/worktrees/remove-log-level-filter`

---

## 0. Evidence

- **Commit range**: `bc62c595dda3..03bfd217` (1 commit)
- **Diff size**: +525 / -415 lines across 22 files (code+docs: 15 files,
  openspec artifacts: 7 files)
- **Tasks done**: 17/17
- **Active hours**: ~1 (single session, no context handoffs)
- **Subagent dispatches**: 0 — implemented directly rather than via
  subagent-driven-development (see §4)
- **New external dependencies**: none
- **Bugs encountered during this cycle**: 2 — both pre-existing environment
  issues, not introduced by this change:
  1. Fresh `npm install` in this worktree produced corrupted/incomplete
     packages (`hermes-parser` missing `dist/index.js`,
     `@jridgewell/sourcemap-codec` missing its `.mjs` build) — fixed by
     copying `node_modules` from the main checkout instead of trusting the
     worktree's own `npm install`.
  2. `archiver`/`@types/archiver` missing from `node_modules` entirely,
     breaking `npm run app:typecheck` on `DiagnosticsBundleService.ts` —
     reproduces identically on `main`, unrelated to this change's scope.
- **OpenSpec validate state at archive**: pass (`openspec validate --all
  --json` → 38/38 valid, 0 blocking issues)
- **Test coverage signal**: 3389/3389 vitest tests passed (1 suite failed to
  *load* due to bug #2 above, unrelated to any file this change touched)

Commit chain (chronological):

```
bc62c595 chore(release): v0.5.1
03bfd217 fix(web): remove unreliable log level detection
```

---

## 1. Wins

- [evidence: `app/packages/web/src/lib/log-level.utils.ts` deletion +
  grep verification] Complete removal with zero leftover references —
  final `grep -rn "LogLevel\|log-level.utils\|LevelFilterMenu\|hiddenLevels\|toggleLevel\|levelBadge\|levelsTrigger\|levelMenuItem" app/packages docs/docs`
  returned nothing.
- [evidence: `openspec validate --all --json` → 0 invalid] The delta spec
  (RENAMED + MODIFIED on `app-diagnostics-logging`) validated cleanly on
  the first write — no schema-format iteration needed.
- [evidence: 3389/3389 vitest pass] All five touched unit/component test
  files (`log-line-display.component.test.tsx`,
  `use-log-tail.hook.test.ts`, `logs.page.test.tsx`,
  `infrastructure-logs.page.test.tsx`, `DiagnosticsPanel.test.tsx`) pass
  after their level-specific cases were removed, with no incidental
  breakage to the surrounding (kept) test cases.
- [evidence: e2e scope caught mid-flow] Initial code survey (grep across
  `app/packages/web/src`) missed the Playwright e2e page object
  (`e2e/pages/LogsPage.ts`) and spec (`e2e/specs/logs.spec.ts`), which live
  in a sibling `e2e/` directory outside `src/`. A second grep pass across
  `app/packages` (not scoped to `src/`) caught these before the final
  verify, avoiding a broken/incomplete PR.

## 2. Misses

- 🟡 [painful | evidence: `npm install` producing corrupted packages
  requiring a `node_modules` copy from the main checkout] The worktree's
  own `npm install` is unreliable in this environment — silently drops
  files from some packages without erroring the install itself. Cost ~10
  minutes of debugging before the fix (copy `node_modules` wholesale from
  the main checkout, which has an already-working install) was found.
- 🟡 [painful | evidence: initial grep scoped to `app/packages/web/src`
  only] The proposal/design phase's file survey (done before entering plan
  mode) grepped `app/packages/web/src` and missed `app/packages/web/e2e/`
  entirely — a different top-level directory under the same package. This
  wasn't caught until the post-implementation verification grep widened
  scope to `app/packages`. Cost: two additional edit rounds after the
  "main" implementation felt done.
- 📌 [nit | evidence: `openspec new change` default schema] First
  `openspec new change` invocation used the CLI default (`spec-driven`)
  instead of the repo's `superpowers-bridge` schema; caught immediately via
  `.claude/rules/spec-driven-development.md`'s routing table before any
  artifacts were written, so recovery was a `rm -rf` + recreate with
  `--schema superpowers-bridge` — cheap, but avoidable.

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| Task 2 (log-line-display) | Plan didn't anticipate `Filter` icon still being needed after removing `LevelFilterMenu`'s import of it — `logs.page.tsx`'s own mobile "Filters" toggle button also imports `Filter` and was over-pruned in the first edit pass, requiring it to be re-added. | The plan's file-level task descriptions didn't distinguish "imports used only by the removed code" from "imports used by both the removed code and surviving code" — a granularity the plan.md template doesn't force. |
| Tasks 4/5 (page/panel test updates) | Not scoped in the original tasks.md/plan.md: the Playwright e2e page object and spec (outside `src/`) needed the same treatment as the Vitest test files. | Scope-survey gap (see §2) — not a plan authoring error so much as an input-gathering gap before the plan was written. |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✗ (raw-capture written directly, see below) |
| superpowers:writing-plans                        | ✗ (plan.md written directly, see below) |
| superpowers:using-git-worktrees                  | ✗ (worktree already established via harness's `EnterWorktree`, see below) |
| superpowers:subagent-driven-development          | ✗ (implemented directly, see below) |
| (transitive) superpowers:test-driven-development | ✗ (deletion-shaped change, see below) |
| (transitive) superpowers:requesting-code-review  | ✗ (no code-reviewer subagent dispatched) |
| superpowers:finishing-a-development-branch       | ✗ (not yet reached — PR opening is the next step after archive) |

> Default expectation is all ✓; every ✗ below is answered per the schema's
> three required questions.

### Deliberately Skipped Skills

- **`superpowers:brainstorming`**
  - **What was skipped**: the interactive Q&A flow of the brainstorming
    skill itself; `brainstorm.md` was instead written directly as a raw
    capture reflecting a decision the user had already made in their
    initial request plus one round of scope-clarification from the user
    ("I think you may need to still create an openspec for this").
  - **Why this cycle**: this is a background job with no synchronous user
    present to answer interactive brainstorming questions in real time —
    the skill's turn-by-turn clarifying-question loop cannot run against a
    user who has already stated the decision and stepped away. The user's
    original message already specified the what (remove level filtering)
    and the why (regex doesn't match unowned log formats), leaving no open
    forks to actually brainstorm.
  - **How to prevent recurrence**: `scope-judgment rule` — when the
    triggering user message already states a firm decision with a clear
    single rationale (not "should we do X or Y"), skip straight to writing
    brainstorm.md as a direct decision-log capture rather than running the
    interactive flow synchronously; this is explicitly allowed by the
    artifact's own instruction ("or that they can explicitly opt to write
    brainstorm.md manually using the template below").

- **`superpowers:writing-plans`**
  - **What was skipped**: the writing-plans skill's own process; `plan.md`
    was authored directly from `tasks.md` + the design.md decisions.
  - **Why this cycle**: the task list was already fully mechanical and
    fully enumerable from the code survey done during plan-mode
    exploration (grep results identifying all 8 file groups) — there was
    no ambiguity left for a planning *process* to resolve, only
    transcription into micro-steps.
  - **How to prevent recurrence**: `scope-judgment rule` — for a
    change whose tasks.md is already a complete, unambiguous enumeration
    (every task names its exact file and exact symbols to remove), writing
    plan.md directly from tasks.md + design.md is equivalent output to
    running the skill; reserve the interactive skill invocation for
    changes where the task breakdown itself has open design forks.

- **`superpowers:using-git-worktrees`**
  - **What was skipped**: the skill's own worktree-creation flow.
  - **Why this cycle**: the session's harness-level instructions (this
    background job's system prompt) already require calling the
    `EnterWorktree` tool before any tracked-file edit, and that call was
    made (creating `.claude/worktrees/remove-log-level-filter` on branch
    `worktree-remove-log-level-filter`) before any code was touched. A
    second, skill-driven worktree creation would have been redundant.
  - **How to prevent recurrence**: `one-off — schema boundary case, no
    prevention possible`. This is a genuine platform boundary: the schema
    was authored assuming the *skill* owns worktree creation, but this
    Claude Code harness already enforces worktree isolation at the tool
    level via a separate, mandatory mechanism (`EnterWorktree`, backed by a
    PreToolUse hook that rejects untracked-file edits outside a worktree).
    Running both would not be additive, just duplicated setup.

- **`superpowers:subagent-driven-development`**
  - **What was skipped**: dispatching a fresh subagent per micro-task from
    plan.md.
  - **Why this cycle**: the implementing agent had already read every
    target file in full during plan-mode exploration (all 8 file groups
    read via the `Read` tool before `ExitPlanMode`), so a fresh subagent
    per task would have had to re-read the same files from zero context —
    pure overhead for a change where the full picture already fit in one
    context window and no task genuinely benefited from isolation.
  - **How to prevent recurrence**: `scope-judgment rule` — when the total
    file set touched is small enough (here: 15 code/doc files) that the
    orchestrating agent already holds full read context on all of them
    from the planning phase, direct implementation is equivalent-or-better
    than subagent dispatch; reserve subagent-per-task for changes large
    enough that no single context window holds the whole picture, or where
    parallel independent edits actually save wall-clock time.

- **`(transitive) superpowers:test-driven-development`**
  - **What was skipped**: writing a new failing test before implementation
    (RED-GREEN-REFACTOR).
  - **Why this cycle**: this change is pure deletion — there is no new
    behavior to write a failing test for. The correct "test-first" motion
    for a deletion is the inverse: delete the assertions for the removed
    behavior, then confirm the remaining suite still passes, which is what
    happened (deletions in `logs.page.test.tsx`,
    `infrastructure-logs.page.test.tsx`, `DiagnosticsPanel.test.tsx`,
    `use-log-tail.hook.test.ts`, `log-line-display.component.test.tsx`,
    verified by the final `npm run app:test` run showing 3389/3389 pass).
  - **How to prevent recurrence**: `schema graph fix` — the schema's
    apply-phase instruction should recognize "deletion-shaped" changes
    (proposal.md's "What Changes" section is a pure removal, no new
    Requirement scenarios in the delta spec) as a case where TDD's
    red-green cycle doesn't apply in its literal form, and should instead
    require "delete test, confirm suite green" as the equivalent
    discipline — this is currently unstated, forcing every deletion-shaped
    change to justify skipping TDD in its retro instead of the schema
    just saying so.

- **`(transitive) superpowers:requesting-code-review`**
  - **What was skipped**: dispatching a code-reviewer subagent per task
    and a final whole-implementation review before archive.
  - **Why this cycle**: no subagents were dispatched at all (see above), so
    the per-task review trigger never fired. A final review was not run
    separately either.
  - **How to prevent recurrence**: `schema graph fix` — decouple the
    final whole-implementation code-review step from the per-task
    subagent-driven-development loop so it still fires even when
    implementation happened directly; as currently written, skipping
    subagent-driven-development silently also skips the review gate, which
    is a real coverage gap this cycle didn't backfill.

- **`superpowers:finishing-a-development-branch`**
  - **What was skipped**: not skipped — deferred. This is the next step
    after archive, per the schema's own step ordering ("6. Completion (PR
    is the LAST step)"). Recorded here only because the compliance table
    is a snapshot at retrospective-write time, which happens before
    archive per the schema's own instruction ("BEFORE opening any PR").
  - **Why this cycle**: N/A — not applicable, this is sequencing, not a
    skip.
  - **How to prevent recurrence**: N/A.

> **Relationship to §6**: the "requesting-code-review" gap (no review ever
> ran, whether or not subagent-driven-development is used) is the pattern
> most likely to recur and is promoted below.

## 5. Surprises

- Assumed the code survey (`grep -rln "LogLevel\|..." app/packages/web/src`)
  was complete scope; it wasn't — `app/packages/web/e2e/` is a sibling
  directory to `src/` within the same package and uses the same symbols
  (`LogLevelLabel`, `levelBadge`, `toggleLevel` as page-object methods) but
  wasn't covered by a `src/`-scoped grep. Corrected in §2/§3 above.
- Assumed a fresh `npm install` in a newly created worktree would just work
  (per `.claude/rules/worktree.md`'s own guidance, "Immediately after
  entering: `npm install`"); in this environment it silently produced
  corrupted package installs for at least two unrelated packages
  (`hermes-parser`, `@jridgewell/sourcemap-codec`), which the rule's
  documented failure mode (stale cross-package `@hyveon/*` type resolution)
  didn't anticipate or describe. Not something this change caused or could
  fix — worth flagging upstream (see §6).

## 6. Promote candidates → long-term learning

- [ ] 🟡 **Grep-based code-removal scope surveys must include `e2e/` alongside `src/` for `@hyveon/web`, not just `src/`.** → **Promote to memory** (type: feedback)
  > **Why**: A `src/`-scoped grep during the plan-mode survey missed
  > `app/packages/web/e2e/pages/LogsPage.ts` and
  > `app/packages/web/e2e/specs/logs.spec.ts`, which reference the same
  > removed symbols via page-object methods (`levelBadge`, `toggleLevel`,
  > `levelsTrigger`) rather than direct imports — a pattern grep for the
  > exact import names wouldn't catch without widening the search root.
  > This cost an extra edit round after the "main" implementation felt
  > complete.
  > **How to apply**: when removing or renaming a feature touching
  > `@hyveon/web`, scope the initial reference-survey grep to
  > `app/packages/web` (parent of both `src/` and `e2e/`), not `src/`
  > alone — the Playwright page objects under `e2e/pages/` mirror UI
  > structure independently of `src/` imports.

- [ ] 🟡 **This environment's `npm install` inside a freshly created worktree can silently produce corrupted package installs (missing files, not a hard install failure) — verify specific packages, don't just trust exit code 0.** → **Promote to memory** (type: project)
  > **Why**: In this session, `npm install` inside
  > `.claude/worktrees/remove-log-level-filter` completed with exit 0 but
  > left `hermes-parser` missing `dist/index.js` and
  > `@jridgewell/sourcemap-codec` missing its `.mjs` build — both silently
  > incomplete, only surfacing as downstream `ERR_MODULE_NOT_FOUND` in
  > unrelated tools (eslint, vitest). Fixed by copying `node_modules`
  > wholesale from the main checkout instead of trusting a fresh install.
  > This is a different failure mode than `.claude/rules/worktree.md`'s
  > documented "stale cross-package `@hyveon/*` type resolution" symptom —
  > worth a memory note distinct from that rule until root-caused (possibly
  > disk space, npm cache corruption, or the `install-scripts` blocking
  > warnings seen alongside it).
  > **How to apply**: if `npm run app:lint`/`app:typecheck`/`app:test`
  > fails immediately after a fresh worktree `npm install` with a
  > `Cannot find module`/`ERR_MODULE_NOT_FOUND` error pointing at a
  > *dependency* (not an `@hyveon/*` workspace package), suspect a
  > corrupted install before debugging the code change itself — compare
  > against the main checkout's `node_modules` for the same package, and
  > copy it over as a faster fix than re-running `npm install` repeatedly.

- [ ] 📌 **The apply-phase schema doesn't state what "TDD-equivalent" discipline applies to pure-deletion changes.** → **Promote to schema** (`superpowers-bridge` apply.instruction)
  > **Why**: this cycle had to justify skipping literal red-green TDD in
  > its own retrospective because the schema's apply instruction assumes
  > new-behavior development. A pure-removal change has a natural
  > equivalent ("delete the assertion, confirm the suite is still green")
  > that isn't currently named anywhere in the schema.
  > **How to apply**: next time a deletion-shaped change (proposal.md's
  > "What Changes" is pure removal, no new spec scenarios) goes through
  > this schema, check whether the schema has been updated to state this
  > explicitly; if not, this candidate should get promoted for real via a
  > schema PR rather than re-justified per cycle.

- [ ] 🟡 **Code review never ran this cycle — `requesting-code-review` is currently only reachable via `subagent-driven-development`, so skipping the latter silently skips the former too.** → **Promote to schema** (`superpowers-bridge` apply.instruction step 2)
  > **Why**: the schema's step 2 nests the TDD and code-review guarantees
  > entirely inside `subagent-driven-development`'s dispatch loop
  > ("subagent-driven-development internally enforces... test-driven-
  > development... requesting-code-review"). When an agent judges direct
  > implementation as equivalent-or-better (per the scope-judgment rule
  > used three times in this retro), the review gate disappears with it —
  > an unintended side effect, not a deliberate call.
  > **How to apply**: if a future cycle in this repo also skips
  > subagent-driven-development for the same "small enough to hold in one
  > context" reason, and also skips code review as a result, that's two
  > occurrences of the same gap — escalate this to an actual schema.yaml
  > change (e.g. a standalone review step that isn't nested inside the
  > subagent-loop step) rather than a third retro justification.
