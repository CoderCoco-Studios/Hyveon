## Verification Report: add-custom-title-bar

### Summary

| Dimension    | Status                                              |
|--------------|------------------------------------------------------|
| Completeness | 19/20 tasks (1 deferred, disclosed), 5/5 requirements implemented |
| Correctness  | 5/5 requirements covered by passing tests             |
| Coherence    | Design followed; 2 decisions (D2/D3) corrected mid-implementation by final review, now consistent across design.md/plan.md/code |

### Completeness

**Task completion** (`tasks.md`): 19 of 20 checkboxes are `[x]`. One (`6.5`, manual per-platform GUI check — dragging the window, clicking native OS buttons) is `[~]` (deferred), with the deferral reason and its automated-coverage substitute recorded inline in `tasks.md` itself. This was not silently skipped: the final whole-branch review (see `.superpowers/sdd/plan/progress.md`'s git history in this session, now cleaned up post-merge-readiness) explicitly flagged this gap as a pre-merge requirement for a human on real hardware, not a waived item.

**Spec coverage** — all 5 requirements in `specs/custom-title-bar/spec.md` have corresponding implementation:

1. **Window chrome uses the app's own header** — `electron-entry.ts`'s `platformWindowChromeOptions()` sets `titleBarStyle: 'hidden'` unconditionally; `app-layout.component.tsx`'s header carries `-webkit-app-region: drag` (feature-detected) with `no-drag` on every interactive child. Covered by `electron-entry.test.ts` and `app-layout.component.test.tsx`.
2. **Platform-appropriate window controls** — macOS gets `trafficLightPosition` (dynamically repositioned on resize across the sidebar breakpoint via `setWindowButtonPosition`), Windows gets `titleBarOverlay` with a reserved `env(titlebar-area-width)` safe area in the header, Linux gets app-drawn `WindowControls` (minimize/maximize-restore/close, with a real icon swap on state change). Covered across `electron-entry.test.ts` and `app-layout.component.test.tsx`.
3. **Renderer degrades safely outside Electron** — `window.hyveon?.window` feature-detection gates every piece of new styling/behavior; the Playwright `chromium` project (no Electron, no `window.hyveon`) renders the header unmodified. Covered by both the jsdom unit tests and the chromium e2e project passing unmodified.
4. **Window-control IPC channels** — `WindowService`/`WindowController` implement `window.minimize`/`window.toggleMaximize`/`window.close`/`window.isMaximized` (request/response) and `window.maximizedChange` (push), registered in `AppModule`, logging on entry per `.claude/rules/logging.md`. Covered by `WindowService.test.ts` and `window.controller.test.ts`.
5. **Preload exposes window platform and controls** — `window.hyveon.window` namespace in `hyveon-api.ts`/`preload.ts`, `platform` read from `process.platform` with no IPC round-trip, four invoke wrappers plus a subscribable `onMaximizedChange`. Covered by `preload.test.ts`, and by a real end-to-end assertion against the actual preload bridge in `electron-smoke.spec.ts` (not a stub).

No CRITICAL completeness issues.

### Correctness

Requirement-to-implementation mapping (above) shows no divergence between the spec's stated scenarios and the shipped behavior. This was verified at two levels beyond this report: 6 task-level reviews (one per plan.md task, each with its own spec-compliance verdict) and a final whole-branch review that went through 2 fix rounds — the first found 2 Critical + 4 Important defects (a CSS `calc()` bug that made the Windows overlay spacer inert, macOS traffic lights landing on the sidebar instead of the header, a stale-`WindowService`-reference bug on macOS dock-reopen, and an icon that never visually swapped on Linux); the second round found that round 1's own macOS fix introduced 2 new Important regressions (traffic lights covering the header's title, and a hard-coded offset that broke below the responsive sidebar breakpoint). All of these are now resolved and independently re-verified against a real diff by an opus-tier reviewer twice.

Scenario coverage: every `#### Scenario:` in the spec has a corresponding test assertion — verified during task-level review, not re-derived here from scratch since that work was already done to a higher bar than a keyword search would achieve.

No CRITICAL or WARNING correctness issues remain open. Three Minor nits were identified and deferred in the final review round 2 (documented below under Coherence/Suggestions) — none affect correctness.

### Coherence

**Design adherence**: `design.md`'s D1 (merge into header), D4 (NestJS controller/service pattern), D5 (single `toggleMaximize` channel), D6 (platform read without IPC), D7 (feature-detection) were all followed as originally written, with no divergence found.

D2 (macOS traffic lights) and D3 (Linux rationale) were **corrected during implementation**, not silently diverged from: D2's originally-specified `trafficLightPosition: {x:12,y:12}` was wrong (didn't account for the sidebar's 240px width) — this was caught by final review, and `design.md` itself was updated in the same fix commits to reflect the corrected `{x:252,y:20}`/`{x:12,y:20}` dynamic-repositioning behavior, so the design doc now matches the shipped code rather than describing a bug. D3's "Linux has no overlay equivalent" claim was corrected to note Electron has since added Linux `titleBarOverlay` support, without changing the actual (working, tested) Linux implementation — a documentation correction, not an implementation gap.

No design decision remains contradicted by the code.

**Code pattern consistency**: `WindowService`/`WindowController` follow this repo's existing controller/service pattern exactly (verified against `FilesController`/`ElectronStoreService` during task review). Preload additions follow the existing `<namespace>.<action>` channel convention and the established `contextBridge` namespace shape. No pattern deviations found.

**Suggestions** (non-blocking, from final review round 2, not re-litigated here):
- `electron-entry.ts`'s resize listener calls `setWindowButtonPosition` on every resize tick rather than memoizing the last-applied side — cheap native property set, perf nit only.
- `electron-entry.test.ts` has one test named "should not wire resize-based traffic-light handling on win32 or linux" that only exercises win32 (linux behaves identically since the gate is darwin-only, so no behavior gap — a naming/coverage-labeling nit only).
- The resize handler reads `getBounds().width` rather than `getContentBounds().width` — equivalent today for a frameless window at zoomFactor 1, would need revisiting if a frame or non-default zoom is ever introduced.

### Final Assessment

No CRITICAL issues found. All 5 spec requirements are implemented and tested; 19/20 tasks complete with the 20th explicitly and honestly deferred (not silently skipped) pending a human's manual per-platform GUI pass, which the final whole-branch review treated as a real pre-merge requirement given the two rounds of platform-chrome bugs this change already surfaced without one. **Ready for archive**, with that one disclosed manual-verification item carried forward as a pre-merge action item rather than closed out.
