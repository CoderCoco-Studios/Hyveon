# Group 8: End-to-end coverage

## Context

Part of OpenSpec change `add-one-click-aws-bootstrap`
(`openspec/changes/add-one-click-aws-bootstrap/specs/wizard-flow/spec.md`).
Group 7 (merged onto this branch's base) built the guided-IAM wizard step
with full unit/component-test coverage but zero Electron e2e coverage —
this group adds it, the last piece before the docs group closes out the
stack. Read `docs/docs/components/integration-tests.md`'s Electron e2e
section and `app/packages/web/e2e/specs/discord.spec.ts` in full before
starting — that spec is the closest existing precedent: a single shared
`ElectronApplication` per describe block, `window.hyveon.__test.mock()`
seeded per-test via a helper, `clearElectronMocks()` in `afterEach`.

## Global Constraints

**No real AWS calls, ever.** `GuidedIamService`'s methods ultimately call
real AWS SDK clients — at the Electron e2e tier (the REAL packaged app,
REAL main process, REAL `GuidedIamService`), you cannot rely on
`aws-sdk-client-mock` the way unit/tier-2 tests do (this tier launches the
actual built app via `_electron.launch()`, not an in-process DI
container). Mock at the IPC layer instead: use `window.hyveon.__test.mock('wizard.guidedIam.rotate', () => ...)`
etc. — exactly like `discord.spec.ts` mocks `discord.*` channels — to
intercept the wizard's guided-IAM channels before they ever reach the real
`GuidedIamService`/AWS SDK. This is the standard, already-established
pattern for this tier; do not invent a different one.

**Forcing the wizard to show.** `WizardController.getState()` defaults
`wizardCompleted` to `true` under `HYVEON_TEST_MODE` (so existing dashboard
specs don't need to mock it) — a wizard spec must explicitly mock
`wizard.state.get` to return `{ wizardCompleted: false, ... }` to force the
wizard route instead of the dashboard. Also mock `wizard.progress.get` to
control which step the wizard resumes to (this is how the rotation-pending
resume spec, Task 3, controls the initial render).

**Page object naming/location** — follow the existing convention exactly:
new file in `app/packages/web/e2e/pages/`, registered in
`app/packages/web/e2e/pages/index.ts`'s barrel and (if the spec pattern
needs it as a fixture, check whether Electron specs actually use the
`test.extend` fixture registration in `fixtures/index.ts` the way Chromium
specs do, or whether Electron specs just `new PageObjectClass(win)`
directly, matching `discord.spec.ts`'s pattern — mirror whichever is
actually true, don't assume).

**Scope discipline.** This group's e2e coverage is for the NEW guided-IAM
step only — the pre-existing wizard steps (`pick-cloud`, `credentials`,
`bootstrap`, `stack-init`) have never had Electron e2e coverage and adding
it for them is out of scope for this OpenSpec change. Your page object
needs enough locators to navigate from the wizard's start through the
guided-IAM step's screens — you do not need to build out full coverage of
every other step.

## Task 1: 8.1 Page object for the guided-IAM wizard step

Create `app/packages/web/e2e/pages/GuidedIamWizardPage.ts` (or similar
name matching the existing `XPage.ts` convention), wrapping every locator
`guided-iam-step.component.tsx` needs for e2e interaction: region input,
"Continue with guided setup" / "I already have credentials" choice,
template screen (path display, Copy Path button, Open Console button),
key-intake form (access key ID / secret access key inputs, submit),
rotation-in-progress indicator, the `verification-failed` and
`delete-failed` screens' distinct elements (retry button; revoke button +
consoleUrl link), and the resume banner text. Register it in
`app/packages/web/e2e/pages/index.ts`. No spec-writing in this task — just
the page object, matching `DiscordPage.ts`'s style and TSDoc density. If
useful, add minimal navigation locators for reaching the wizard's
`pick-cloud`/`credentials` steps too (just enough to get in and out of the
guided-IAM step in a real spec), but don't build full page objects for
those steps' own internals.

## Task 2: 8.2 Electron e2e spec — guided path happy case

New spec `app/packages/web/e2e/specs/guided-iam-wizard.spec.ts` (or
similar, matching existing naming). Full happy path: launch the app with
`wizard.state.get` mocked to `wizardCompleted: false`, `wizard.progress.get`
mocked to the wizard's actual starting point, navigate to the guided-IAM
step, fill the region, choose guided setup, mock `wizard.guidedIam.prepareTemplate`
(returns a path), mock `wizard.guidedIam.openConsole` (returns
`{ opened: true }` or `{ opened: false, url }` — either is fine, pick one
and assert its corresponding UI), fill and submit the bootstrap key form
(mock `wizard.guidedIam.submitBootstrapKey` to resolve with an account
ID), mock `wizard.guidedIam.rotate` to resolve `{ status: 'complete' }`,
assert the wizard advances past the guided-IAM step (lands on the
credentials step, ideally asserting the "satisfied by guided provisioning"
summary renders — this exercises Group 7's Task 4 wiring end-to-end for
the first time at the e2e tier).

## Task 3: 8.3 Electron e2e spec — rotation-pending resume case

Same spec file (or a new one — your call) covering the resume scenario:
mock `wizard.progress.get` to return
`{ step: 'guided-iam', guidedIam: { subState: 'rotation-pending', hasBootstrapKey: true } }`
directly (simulating a relaunch after a prior session quit mid-rotation —
no need to actually quit and relaunch the app, just seed the mock to what
a real relaunch would have read from disk). Launch fresh, navigate to the
wizard, and assert the guided-IAM step renders DIRECTLY onto the
key-intake-and-rotate screen with the "previously submitted" resume banner
— NOT the region/template/console screens (per the spec scenario this
sub-state persistence design exists to serve, and per Group 7's own fix
round that made this actually work). Complete the flow from there (mock
`submitBootstrapKey` + `rotate` → `complete`) to confirm the resumed
session can still finish successfully.

## Task 4: 8.4 Confirm Pulumi externalization and teardown are unaffected

This is a confirmation/audit task, not new-feature work — expect little
or no production code change. Confirm:
1. `@pulumi/pulumi`/`@pulumi/aws`/`@grpc/grpc-js` remain externalized —
   `electron.vite.config.ts`'s `external` entries are untouched by this
   OpenSpec change's earlier groups (a quick check, not a deep audit —
   this repo already has a build-time guard,
   `build/verify-main-bundle-externals.mjs`, that fails the build if this
   regresses; confirm it still runs as part of `npm run desktop:build` and
   passes).
2. `electron-builder.yml`'s `node_modules/**` allowlist doesn't need a new
   entry for anything this OpenSpec change added — the CFN template
   resource (Group 1) ships via `extraResources`, not `node_modules`, so
   it shouldn't need one, but confirm this directly rather than assuming.
3. Electron e2e teardown (the existing `electron-clean-quit.spec.ts`
   suite) still passes cleanly with this branch's changes — run it
   explicitly and confirm no new hang/leak, given this exact failure mode
   (`hcl2json`-era bundling regression) has bitten this codebase before
   (see repo history/memory if available, otherwise just confirm the
   specs pass).

If everything already holds (likely), report this clearly with evidence
(the commands run and their output) rather than inventing changes to
justify the task's existence.
