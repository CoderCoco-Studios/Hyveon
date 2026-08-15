# Retrospective: add-custom-title-bar

> Written: 2026-08-14 (after verify passed)
> Commit range: `4519f2b3..869d4678` (this change's own commits; the full worktree range `a47f7533..869d4678` also includes two unrelated pre-existing commits from the branch point — see note below)
> Worktree: `/home/chris/GitHub/Hyveon/.claude/worktrees/add-custom-title-bar` (branch `worktree-add-custom-title-bar`, not yet merged)

---

## 0. Evidence

> Note on commit range: this worktree's merge-base with `main` (`a47f7533`) includes two commits belonging to an already-merged, unrelated change (`1b059bbe` "add auto-update toggle (#524)" and `63a64210` "chore(release): v0.4.0") that landed on `main` after this worktree's branch point but appear in the local `merge-base main HEAD` diff due to how the worktree was created. This change's own work starts at `4519f2b3` (the OpenSpec propose commit) and runs through `869d4678` (verify.md). All figures below are scoped to that range.

- **Commit range**: `4519f2b3..869d4678` (24 commits)
- **Diff size**: +4065/-47 lines across 43 files (includes the two unrelated commits' files; this change's own touched files: `WindowService.ts`/`.test.ts`, `window.controller.ts`/`.test.ts`, `app.module.ts`, `hyveon-api.ts`, `preload.ts`, `preload.test.ts`, `electron-entry.ts`, `electron-entry.test.ts`, `app-layout.component.tsx`, `app-layout.component.test.tsx`, `electron-smoke.spec.ts`, `AppLayout.ts` (page object), `management-app.md`, `dashboard.md`, plus 7 OpenSpec artifact files)
- **Tasks done**: 19/20 (`grep -cE '^\s*- \[x\]' tasks.md` → 19; one `- [~]` deferred item, task 6.5)
- **Active hours**: single continuous session, ~2 hours wall-clock from `/opsx:propose` through `verify.md`
- **Subagent dispatches**: 19 (1 failed/no-op fork retried as a fresh dispatch; 6 task implementers; 6 task reviewers + 1 task-level re-review; 1 final whole-branch reviewer; 2 final-review fix waves + 2 final-review re-reviews)
- **New external dependencies**: none (`Copy` icon used in the fix wave is from `lucide-react`, already a project dependency)
- **Bugs encountered during this cycle**: 9 — 2 plan-mandated (missing `try/catch` on `WindowService.isMaximized()`; `as unknown as T`/chained-cast test violations, both baked into `plan.md`'s own code, caught at Task 1 review), 1 docs gap (missing platform-control context in the IPC table, Task 5 review), 6 found only by the final whole-branch review across two rounds (Windows `titleBarOverlay` CSS `calc()` bug that made the fix inert; macOS traffic lights landing on the sidebar instead of the header; a stale `WindowService`→destroyed-`BrowserWindow` reference on macOS dock-reopen; a maximize/restore icon that never visually swapped; round 1's own macOS fix covering the header's title/env-pill; round 1's macOS fix breaking below the responsive sidebar breakpoint)
- **OpenSpec validate state at archive**: pass (`openspec validate add-custom-title-bar` → "Change 'add-custom-title-bar' is valid")
- **Test coverage signal**: Vitest 175 files / 3241 tests passing (up from 3225 baseline before this change); Playwright e2e 95/95 passing across both `chromium` and `electron` projects

Commit chain (chronological, this change's own commits only):

```
4519f2b3 docs(openspec): propose add-custom-title-bar change
7558a2ba feat(desktop-main): add window-control IPC surface (WindowService/WindowController)
2c8141ad fix(desktop-main): add error handling to WindowService.isMaximized() and fix test casts
ec9172f1 fix(desktop-main): remove chained cast in window.controller.test.ts
687bf28b chore(openspec): check off Task 1 in add-custom-title-bar tasks.md
6494cf26 feat(desktop-preload): add window.hyveon.window namespace
dcf131b5 chore(openspec): check off Task 2 in add-custom-title-bar tasks.md
131afc22 feat(desktop-main): hide OS title bar with platform-conditional chrome, wire WindowService
a6bba49a chore(openspec): check off Task 3 in add-custom-title-bar tasks.md
c0b1c2d9 feat(web): make the top header a drag region with platform-conditional window controls
2d75439f chore(openspec): check off Task 4 in add-custom-title-bar tasks.md
ab3929d7 docs: document the window-control IPC channels and merged title bar
c7b009d7 docs: add platform-specific window-control rendering details to WindowController entry
b6f4578d chore(openspec): check off Task 5 in add-custom-title-bar tasks.md
befb46a4 chore(openspec): check off Task 6 in add-custom-title-bar tasks.md
4cfed1a0 fix(desktop): reserve Windows overlay space and fix macOS traffic-light offset
dc72b09c fix(desktop-main): re-attach WindowService when macOS recreates the window
a77f0da1 test(e2e): cover the custom title bar's drag region and Linux window controls
f32f05d7 docs(app): note the top bar doubles as the window title bar
3f7754f5 fix(web): correct the win32 titlebar-overlay spacer's percentage base
28726ab2 fix(desktop-main): keep macOS traffic lights aligned across the sidebar breakpoint
3d51a357 fix(desktop-main): guard WindowService's closed listener with an identity check
b2ef5b09 fix(e2e): use exact name matching for the window-control button locator
869d4678 docs(openspec): add verify.md for add-custom-title-bar
```

---

## 1. Wins

- [evidence: 6 task-level reviews, all task-quality "Approved"] Every one of the 6 plan.md tasks passed its task-scoped review on the first or second fix round — no task required more than 2 fix rounds, and 4 of 6 (Tasks 2, 3, 4, 5-after-1-round) needed zero or one round. The plan.md itself (written by a dedicated subagent before implementation started) was detailed enough that most implementers described their work as close to transcription — real signal that investing in a fully-fleshed-out plan with actual code, not just prose task descriptions, pays off in implementation reliability.
- [evidence: `WindowService.test.ts`, `app-layout.component.test.tsx` diffs] Reviewers consistently found tests exercising real behavior rather than mocked assertions — e.g. `WindowService.test.ts` fires actual registered Electron event listeners through a `__fire` escape hatch rather than asserting the listener was merely registered; `app-layout.component.tsx`'s tests drive real `userEvent` clicks through to preload method calls.
- [evidence: final whole-branch review, round 1] The two-round final whole-branch review process (opus-tier) is the single highest-value step in this cycle — it caught 2 Critical + 4 Important bugs that all 6 task-level reviews combined had missed, because the bugs were cross-task integration issues (a CSS formula whose containing block only becomes visible when you look at the full component tree; a hardcoded pixel offset that only becomes wrong when you know the sidebar is `hidden md:flex`) that no single task's diff could reveal in isolation.
- [evidence: `progress.md` ledger, final review round 2] The fix-and-re-review loop caught its own regressions before they shipped: round 1's macOS fix (moving traffic lights off the sidebar) introduced 2 *new* Important bugs (covering the header's own title, breaking below the responsive breakpoint) that round 2's re-review caught and round 2's fix resolved — without this loop, the shipped code would have traded one visible macOS bug for two different ones.
- [evidence: `electron-entry.test.ts`'s Electron-API-name catch, per the round-2 implementer's own report] TypeScript's typecheck gate caught a real API-naming mistake mid-fix (`setTrafficLightPosition` doesn't exist on Electron 43; the real API is `setWindowButtonPosition`) before it ever reached a human or a runtime failure — this is exactly what a strict, blocking typecheck gate is for.

## 2. Misses

- 🔴 [blocking | evidence: `design.md` D2's original `trafficLightPosition: {x:12,y:12}`, corrected in `4cfed1a0`/`28726ab2`] The design phase's D2 decision assumed the header spans the full window width when repositioning macOS traffic lights, but this app has a 240px sidebar to the header's left — the design was never checked against an actual screenshot or the real `AppLayout` DOM structure during brainstorming. This single wrong assumption propagated through `plan.md`'s Global Constraints, into the Task 3 implementer's code, past that task's own review (which correctly checked the code against the plan's — wrong — stated value, so it "passed"), and was only caught two review layers later by the final whole-branch reviewer actually reading `app-layout.component.tsx`'s JSX structure.
- 🟡 [painful | evidence: final review round 1 → round 2, 2 additional Important findings] Fixing finding 2 (macOS sidebar overlap) in round 1 required a second full fix-and-re-review cycle because the round-1 fix itself introduced 2 new regressions in the same area of code. This cost roughly as much wall-clock as the original 6-task implementation loop's Task 3 and Task 4 combined.
- 🟡 [painful | evidence: repeated "stale diagnostics" system-reminders throughout this session] This worktree's IDE/LSP surfaced spurious diagnostics (missing globals like `Promise`/`Error`/`Record`) on nearly every file edit throughout the entire session, due to an unbuilt TypeScript project-reference graph. Every implementer and reviewer subagent had to be explicitly told to ignore these and trust the real `npm run app:typecheck` gate instead — this is pure repeated overhead that a `npm run app:build` (or equivalent project-reference warm-up) immediately after `EnterWorktree` + `npm install` would likely eliminate.
- 📌 [nit | evidence: final review round 2's "Out-of-Scope Observations" x3] Three Minor nits (resize-tick churn calling `setWindowButtonPosition` on every tick, a misleadingly-named test that only covers win32 not linux, `getBounds()` vs `getContentBounds()`) were correctly deferred rather than triggering a third fix round — this is the loop's cap working as designed, not a miss, but noting it here since it's the kind of thing worth a follow-up issue rather than silently forgetting.

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| 1 (WindowService/WindowController) | Added `try/catch` to `isMaximized()` that `plan.md`'s own Step 3 code omitted; converted 4 `as unknown as T` test casts to `Partial<T> as T` | Task-level review caught two constraints (`logging.md`, root `CLAUDE.md`) that the plan's own code violated — ruled as plan-mandated defects, fixed rather than shipped as-specified |
| 3 (BrowserWindow chrome) | Added a `fakeNestApp.get` default mock return value in `electron-entry.test.ts`'s `beforeEach`, not in the plan | `WindowService.attach()` becoming unconditional (per the plan) broke a pre-existing test via a synchronous throw racing an async `.then()` chain; independently verified by the task reviewer as a correct, minimally-scoped fix rather than a masked bug |
| 4 (renderer) | Added a mount-guard against a maximize-state race, and a jsdom CSSOM shim for `-webkit-app-region` | Neither was in the plan's literal code; both were necessary for the plan's own test assertions to pass correctly (race) or at all (jsdom has no native `-webkit-app-region` support) — independently verified sound by task review |
| 3 + 4 (post-hoc, final review) | macOS `trafficLightPosition` changed from plan's `{x:12,y:12}` to a dynamic `{x:252,y:20}`/`{x:12,y:20}` pair switched on window resize via `setWindowButtonPosition`; header gained darwin/win32-conditional spacer elements; `WindowService` gained a `closed`-listener self-detach with identity guard | The plan's stated coordinate was wrong (didn't account for the sidebar), and fixing it correctly required runtime behavior (resize-responsive repositioning) the plan never anticipated — this is the retrospective's central "misses" story, not a routine deviation |
| 5 (docs) | Added an additional sentence to the IPC table row beyond the plan's literal proposed text | Task review flagged the plan's suggested text as omitting the platform-specific rendering context its own Step 3 instruction asked for |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✓    |
| superpowers:writing-plans                        | ✓    |
| superpowers:using-git-worktrees                  | ✗    |
| superpowers:subagent-driven-development          | ✓    |
| (transitive) superpowers:test-driven-development | ✓    |
| (transitive) superpowers:requesting-code-review  | ✓    |
| superpowers:finishing-a-development-branch       | (pending — runs after this retrospective, per schema ordering) |

### Deliberately Skipped Skills

- **`superpowers:using-git-worktrees`**
  - **What was skipped**: the entire skill invocation at apply-phase Step 1 ("Setup: worktree, ledger check...").
  - **Why this cycle**: the session was already isolated in a worktree created via this repo's own `EnterWorktree` tool (per `.claude/rules/worktree.md`, a project-level mandatory convention that predates and supersedes ad hoc worktree creation for this specific repo) before `/opsx:apply` was invoked. Re-invoking `using-git-worktrees` would have either created a redundant nested worktree or been a no-op re-verification of state that already existed — this was a live judgment call recorded in-session ("Already isolated in the `add-custom-title-bar` worktree per this repo's own worktree convention — skipping the redundant `using-git-worktrees` step").
  - **How to prevent recurrence**: `CLAUDE.md trigger` — this repo's `spec-driven-development.md` (or the `superpowers-bridge` schema's own project-context injection) should state explicitly: "if the adopter repo has its own mandatory pre-apply worktree-isolation convention (e.g. a project rule requiring `EnterWorktree`/`git worktree add` before any tracked-file change), the apply-phase's `using-git-worktrees` step is satisfied by that convention already having run, and should be treated as done-by-precondition rather than skipped-without-reason." This is specific to repos like this one with their own competing worktree mandate — a genuine boundary case, not a routine skip, so the schema (or this repo's schema adapter) should encode it rather than leave every cycle to re-derive the same judgment call.

## 5. Surprises

- The design phase's assumption that macOS traffic-light repositioning was "just a coordinate to compute once" turned out to require live, resize-responsive behavior — an assumption that only broke because this app's layout (sidebar + header, not a full-width single-row title bar like Discord's, which the brainstorming session explicitly referenced as inspiration) has a responsive breakpoint that changes which part of the window is the visual "top-left corner." A full-width title bar design (the alternative rejected in D1) would not have had this problem at all — worth remembering that D1's "merge into existing header" choice, while saving vertical space, is what created this entire class of bug.
- `BrowserWindow.setWindowButtonPosition()` exists and is real, but is undocumented-by-obvious-naming (the Electron API named closest to "traffic light" conceptually — `setTrafficLightPosition` — does not exist as a runtime method on `BrowserWindow`; only `trafficLightPosition` exists as a constructor option). The round-2 implementer's own initial attempt used the wrong name and was caught only by `tsc`, not by any documentation lookup done beforehand.
- Electron's `titleBarOverlay` safe-area mechanism (`env(titlebar-area-*)`) is not something CSS's `calc()` percentage resolution "just works" with when nested inside a shrink-to-fit flex container — the percentage base is the *containing block*, not the viewport, which is an easy and non-obvious mistake (the first fix attempt made exactly this mistake, and its own test couldn't detect the bug because the test only checked the formula's string shape, not its computed numeric result).

## 6. Promote candidates → long-term learning

- [ ] 🔴 **Design decisions about window/UI chrome positioning must be checked against the actual current component tree (or a real screenshot), not just described in prose, before being written into a design doc.** → **Promote to memory** (type: feedback)
  > **Why**: `design.md`'s D2 stated a `trafficLightPosition` coordinate that was wrong from the moment it was written, because brainstorming never checked `app-layout.component.tsx`'s actual DOM structure (header offset by a 240px sidebar) against the assumption of a full-width title bar. This propagated through 3 review layers before being caught, and required a 2-round fix-and-re-review cycle to correct.
  > **How to apply**: whenever a design decision involves absolute/relative pixel positioning, window chrome, or visual layout in an app with existing UI structure, require reading the actual current component/layout file (not just its description) during brainstorming — and if the design doc states a specific coordinate/offset, that coordinate should be derivable from a real measurement of the actual layout, not an assumption.

- [ ] 🟡 **This worktree's stale-IDE-diagnostics noise (unbuilt TS project references) recurred on effectively every file edit across the entire session and had to be manually dismissed each time.** → **Promote to project CLAUDE.md** (`.claude/rules/worktree.md`)
  > **Why**: every implementer and reviewer subagent dispatched in this cycle needed an explicit "ignore stale diagnostics, trust the real typecheck gate" instruction, and the controller had to independently re-verify the real gate after nearly every fix round specifically because the diagnostics were unreliable noise, not signal — this is pure repeated overhead across ~19 subagent dispatches in a single cycle.
  > **How to apply**: `worktree.md` already documents the "`node_modules` resolves outside the worktree" gotcha and its `npm install` fix; add a sibling note that a fresh worktree's TypeScript project-reference graph is unbuilt until the first `npm run app:build`/`app:typecheck` pass, and that running one of those once, immediately after `npm install`, warms the reference graph and eliminates the bulk of spurious IDE diagnostics for the rest of the session — worth doing proactively rather than rediscovering per-cycle.

- [ ] 📌 **`BrowserWindow.setWindowButtonPosition()` (not `setTrafficLightPosition`) is the real Electron API for runtime macOS traffic-light repositioning.** → **One-off** (record only, do not promote)
  > **Why**: narrow, Electron-API-specific fact unlikely to recur across unrelated changes; caught cleanly by `tsc` in this cycle with no lasting cost.
