# Retrospective: wizard-responsive-layout

> Written: 2026-08-05 (after verify passed)
> Commit range: `9c9235d..a082ef1`
> Worktree: `/home/chris/GitHub/Hyveon/.claude/worktrees/wizard-responsive-layout`

---

## 0. Evidence

- **Commit range**: `9c9235d..a082ef1` (8 commits)
- **Diff size**: +1130 / -15 lines across 15 files
- **Tasks done**: 9/10 (`grep -cE '^\s*- \[x\]' tasks.md` → 9; the 10th, 2.3, is deliberately `[~]` deferred — see verify.md §2)
- **Active hours**: ~1 session, roughly 45 minutes wall-clock for the apply phase specifically (brainstorm → propose → apply → verify, contiguous, no breaks)
- **Subagent dispatches**: 12 total across the full cycle — 1 research (Explore, wizard UI structure, during brainstorming) + 4 task implementers (Tasks 1-4) + 4 task reviewers + 1 final whole-branch reviewer (opus) + 1 final-review fix-wave implementer + 1 scoped re-review of the fix wave. (One additional message resumed an existing implementer mid-task via SendMessage — not counted as a new dispatch.)
- **New external dependencies**: none
- **Bugs encountered during this cycle**: 3 real, 2 false-positive
  1. Test-query collision (`/provision aws access/i` matching both header and sidebar) — plan-time grep missed it, found empirically by Task 2's implementer.
  2. Second instance of the same collision pattern in `settings.page.test.tsx` — found by Task 3's full-suite run.
  3. Reconfigure-mode viewport-breakpoint composition bug (design.md D4) — found by the final whole-branch review; the most significant of the three.
  4. (false positive) Stale "Cannot find module" TypeScript diagnostic surfaced via system-reminder after Task 1's dispatch — didn't match the actual committed file; confirmed clean via a real `npm run app:typecheck`.
  5. (false positive) Same pattern recurred after the final fix wave's dispatch ("Cannot find name 'CompletedStepSummary'") — again stale, confirmed clean by direct file read + typecheck.
- **OpenSpec validate state at archive**: pass (`openspec validate --all --json` → 21/21 items valid, 0 invalid)
- **Test coverage signal**: 2682/2682 vitest tests passing (full repo suite, up from a 127/127 wizard-scoped baseline), 96/96 Playwright e2e passing (chromium + electron projects)

Commit chain (chronological):

```text
9d8f331 docs: propose wizard-responsive-layout OpenSpec change
7cf786b feat(web): add WizardStepSidebar progress component
545221c feat(web): show wizard step progress and widen content at md+
01dc0bd test(web): scope wizard step-label query to header after sidebar addition
f61f249 docs: describe wizard step-progress sidebar layout
82cbab7 fix(web): scope wizard step sidebar to first-run mode only
b6be32e chore: mark wizard-responsive-layout tasks complete
a082ef1 docs: add wizard-responsive-layout verification report (PASS)
```

---

## 1. Wins

- Task 1 (`WizardStepSidebar` component) was approved on first task review with zero findings — the plan's verbatim code snippets meant implementation was effectively transcription-plus-testing, exactly matching the Model Selection guidance to use the cheapest tier for that shape of task [evidence: commit `7cf786b`, task-1 review verdict "Approved", 0 issues].
- Task 3's instruction to run the *full* suite after applying the pre-diagnosed fix (not just the two known lines) caught a second, identical collision in `settings.page.test.tsx` that the plan-time analysis missed entirely [evidence: commit `01dc0bd`, task-3 report].
- The final whole-branch review (dispatched on the most-capable available tier per Model Selection) caught a real, non-obvious composition bug — `FirstRunWizard` mounts twice (full-window first-run vs. embedded-in-`app-layout` reconfigure) and the new viewport-based breakpoint didn't account for the outer chrome's own sidebar — that survived 3 clean task-level reviews and a fully green 2682/2682 + 96/96 test suite [evidence: opus final-review report, fix commit `82cbab7`, `design.md` Decision D4].
- Full repo test suite went from a 127/127 wizard-scoped baseline to 2682/2682 passing at the end with zero regressions introduced outside the touched files.
- Zero manual conflict resolution, zero force-pushes, zero destructive git operations across the whole cycle.

## 2. Misses

- 🔴 [blocking, now fixed | evidence: `design.md` D4, commit `82cbab7`] The reconfigure-mode viewport-breakpoint composition bug — a real bug that would have shipped if the final whole-branch review step had been skipped or downgraded to a per-task-only review.
- 🟡 [painful | evidence: task-2 report status `DONE_WITH_CONCERNS`, ledger ruling] My own plan.md Step 6 "no collision" claim (a grep-based check during plan-writing) was wrong — it checked a curated list of query-pattern strings and missed `screen.findByText(/provision aws access/i)` used without a role/selector filter. Cost one controller-ruling detour mid-implementation instead of being caught during planning.
- 🟡 [painful | evidence: two system-reminder diagnostics, both contradicted by a real `npm run app:typecheck` run] Stale TypeScript diagnostics fired twice mid-session (after Task 1's dispatch, and after the final fix wave's dispatch), both false alarms once verified directly. Cost two extra verification round-trips.
- 📌 [nit | evidence: this session's own transcript] `openspec new change` was initially run without `--schema superpowers-bridge` (silently defaulting to `spec-driven`) and had to be deleted and recreated. One-time operator error, not a recurring pattern this cycle.

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| Task 2 Step 6 | Expected the suite to pass unchanged after the shell wiring; it didn't (test-query collision) | Plan-time verification was incomplete; the fix was deliberately deferred to Task 3 per Task 2's own file-scope boundary (controller ruling, recorded in the SDD ledger) |
| Task 2 Step 7 | Manual `desktop:dev` visual check skipped entirely | No display access in that implementer's session; later judged low-risk given independent JSX-balance verification and the passing Electron e2e suite; deferred as `tasks.md` `[~]` rather than forced |
| Task 3 | Fixed 1 collision beyond the 2 pre-diagnosed ones (`settings.page.test.tsx`) | The plan's collision analysis (done during Task 2's ruling, not Task 3 itself) was incomplete; Task 3's "run the full suite, not just the known lines" instruction surfaced it exactly as designed |
| (post-plan) Final review fix wave | 5 findings fixed beyond the original 4 plan tasks: `mode`-gate fix, 2 new regression/boundary tests, a TSDoc link fix, and `design.md`/`spec.md` updates for the new D4 decision | The final whole-branch review — a process step, not a plan task — found a real composition bug because no plan task had ever audited `FirstRunWizard`'s second mount point (Settings → Reconfigure) |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✓    |
| superpowers:writing-plans                        | ✓    |
| superpowers:using-git-worktrees                  | ✓    |
| superpowers:subagent-driven-development          | ✓    |
| (transitive) superpowers:test-driven-development | ✓    |
| (transitive) superpowers:requesting-code-review  | ✓    |
| superpowers:finishing-a-development-branch       | (next step — not yet reached, not skipped) |

### Deliberately Skipped Skills

None. All apply-phase skills in this schema's flow were used as designed.

## 5. Surprises

- Assumed jsdom would either apply or ignore Tailwind's `hidden md:block` class in some safe way. It does neither — the element renders fully in the DOM tree every time regardless of the class, which is the direct mechanical cause of every test collision this cycle hit. General jsdom-testing gotcha (no CSS layout engine at all), not obvious from the design phase.
- Assumed (per `design.md`'s original Context section) that `FirstRunWizard` has exactly one mount point — full-window, first-run. It has two: the same component also renders embedded inside `app-layout.component.tsx` via Settings → Reconfigure with `mode="reconfigure"`. The brainstorming-phase codebase exploration focused on the wizard's own directory and never grepped for the component's call sites elsewhere in the app, so this surfaced only at final review.
- The sandbox environment turned out to support a real Electron display for e2e (`_electron.launch()` succeeded, all 70 electron-project specs passed) — uncertain going in, and this meaningfully de-risked the deferred manual-visual-check gap once discovered mid-cycle.

## 6. Promote candidates → long-term learning

- [ ] 🔴 **When designing a UI change to an existing shared/reusable component, search for ALL of that component's mount points across the codebase, not just its own directory, before finalizing viewport-based responsive decisions.** → **Promote to memory** (type: feedback)
  > **Why**: `wizard-responsive-layout`'s design missed that `FirstRunWizard` mounts twice (first-run full-window, reconfigure embedded-in-`app-layout`), which caused a real breakage caught only by the final whole-branch review, not by design or any of the 3 task-level reviews.
  > **How to apply**: during brainstorming/design for any change to a shared component, run `grep -rn '<ComponentName' src/` (or equivalent) across the whole source tree before committing to a breakpoint/layout decision, not just within the component's own folder.

- [ ] 🟡 **A final whole-branch review at the most-capable model tier catches structural bugs that per-task reviews and a fully green test suite both miss.** → **Promote to memory** (type: feedback — reinforces existing `subagent-driven-development` skill guidance with a concrete validated instance, not a new rule)
  > **Why**: in this cycle, 3/3 task reviews approved and the full suite was 2682/2682 green, and the final review still found a real production bug (the reconfigure-mode breakage).
  > **How to apply**: never skip or downgrade the final whole-branch review step to save time or cost, even when every task-level review already came back clean — it is checking a different, cross-cutting thing (composition across the whole diff) that task-scoped reviews structurally cannot see.

- [ ] 📌 **`openspec new change` defaults to schema `spec-driven` even in a repo whose CLAUDE.md documents `superpowers-bridge` as the routing default for `/opsx:propose`-family commands.** → **One-off** (record only, do not promote)
  > **Why**: this repo's own `.claude/rules/spec-driven-development.md` already documents the `--schema superpowers-bridge` requirement clearly (routing table row 2); the miss this cycle was operator error in following an existing rule, not a gap in the rule itself.

(Related but already-promoted, not re-listed here: the narrative-brainstorming → `docs/superpowers/specs/` write attempt caught earlier in this same session was already captured as `feedback-brainstorming-opsx-routing.md` in auto-memory, plus a durable enforcement hook shipped in PR #410.)
