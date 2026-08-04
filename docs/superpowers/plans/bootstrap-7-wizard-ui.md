# Group 7: Wizard UI

## Context

Part of OpenSpec change `add-one-click-aws-bootstrap`
(`openspec/changes/add-one-click-aws-bootstrap/design.md`; specs
`wizard-flow`, `aws-credentials`). Groups 1-6 (merged onto this branch's
base) built every backend piece — the CloudFormation template, `GuidedIamService`
(render/console/intake/rotate/revoke), the IAM permission gate's
`origin`/`blocking` fields, and all five `wizard.guidedIam.*` IPC channels,
already bridged through preload. **Nothing on the renderer side consumes
any of it yet.** This group builds the wizard step: a new step component,
its insertion into the step list, the credentials step's "satisfied by
guided provisioning" rendering, and resumable sub-state persistence. The
next group (stacked on this one) adds Electron e2e coverage.

## Global Constraints

**Step insertion — exact new order:**
`['pick-cloud', 'guided-iam', 'credentials', 'bootstrap', 'stack-init']`
(inserted between `pick-cloud` and `credentials`, per the spec). Four
places currently enumerate the four-step list and all four need the fifth
step added — miss one and the app won't build or will silently misbehave:
1. `app/packages/shared/src/wizardSteps.ts` — `WIZARD_STEPS` (the single
   source of truth both other layers below derive from/mirror).
2. `app/packages/desktop-preload/src/hyveon-api.ts` — `WizardStepName`
   (hand-written union mirror, per this file's established convention).
3. `app/packages/web/src/components/first-run-wizard/first-run-wizard.component.tsx` —
   `STEP_LABELS: Record<WizardStep, string>` (an exhaustive `Record`, so
   the compiler forces this one — but confirm the label text is sensible,
   e.g. `"Provision AWS access"` or similar, not a placeholder).
4. Same file — `RECONFIGURE_PRE_COMPLETED_STEPS: WizardStep[]` (NOT
   exhaustive, easy to forget — see the conditional-gating requirement
   below; this is NOT a simple "add it to the array" like the other three).

The resume-clamp in `first-run-wizard.component.tsx`'s resume-on-mount
effect (`const maxResumableIndex = WIZARD_STEPS.indexOf('bootstrap')`) is
keyed by step *name*, not position — it needs no change when a step is
inserted before it.

**Sub-state persistence — new plumbing across `FirstRunWizardService`,
preload, and the controller (none of this exists today; read
`app/packages/desktop-main/src/services/FirstRunWizardService.ts` in full
first — `WizardProgress` is currently just `{ step }`, and both
`getProgress`/`recordStep` construct/serialize exactly that shape, nothing
else — extending it touches all three layers, not just one):**

```typescript
export type GuidedIamSubState = 'not-started' | 'template-written' | 'awaiting-key-intake' | 'rotation-pending' | 'complete';

export interface WizardProgress {
  step: WizardStepName;
  /** Present only while `step === 'guided-iam'` has ever recorded sub-progress. */
  guidedIam?: {
    subState: GuidedIamSubState;
    /** Whether a bootstrap key was ever submitted this session — never the key itself. */
    hasBootstrapKey: boolean;
  };
}
```

`recordStep` needs a second, optional parameter for this sub-state (its
signature is currently `recordStep(step: WizardStepName): Promise<void>`
— extend it, e.g. `recordStep(step: WizardStepName, guidedIam?: WizardProgress['guidedIam']): Promise<void>`).
`getProgress` must validate and pass the sub-state through (today it
discards every field except `step` — that discard behavior is exactly
what must change). Mirror the same shape into
`desktop-preload/src/hyveon-api.ts`'s `WizardProgress`/`SaveWizardProgressInput`,
and thread the extra parameter through `WizardController`'s
`wizard.progress.save` handler and the shell's `saveProgress(...)` call
site. **Never persist `secretAccessKey` or `accessKeyId` in this
structure** — `hasBootstrapKey` is a boolean flag, never the key material,
per the spec's explicit "so the UI never re-displays a secret."

**`GuidedIamSubState` → persistence call sites (load-bearing — get this
right or resume-on-relaunch silently resumes into the wrong screen):**
- On reaching the guided-IAM step and choosing the guided path (not
  "I already have credentials"): persist `{ subState: 'not-started', hasBootstrapKey: false }`
  once, before calling `prepareTemplate()`.
- Immediately after `prepareTemplate()` resolves: `{ subState: 'template-written', hasBootstrapKey: false }`.
- Immediately after the operator opens the console (or reaches the
  key-intake form — treat these as the same UI moment): `{ subState: 'awaiting-key-intake', hasBootstrapKey: false }`.
- Immediately after `intakeBootstrapKey()` succeeds, BEFORE calling
  `rotate()`: `{ subState: 'rotation-pending', hasBootstrapKey: true }`.
  This is the critical persist — it's what makes the "operator quits
  between intake and rotation" spec scenario resumable.
- On `rotate()` returning `verification-failed` or `delete-failed`: leave
  the sub-state at `rotation-pending` (still mid-flow — the operator
  retries from here).
- On `rotate()` returning `complete`: persist `{ subState: 'complete', hasBootstrapKey: false }`.

**Resume semantics — read carefully, this is the one genuinely subtle
design decision in this group.** The bootstrap key's SECRET material is
never persisted anywhere (per the constraint above) — it only ever lives
in the component's in-memory React state. So on a relaunch with
`subState: 'rotation-pending'`, the ACTUAL in-flight `rotate()` call
cannot be resumed — there is nothing to resume with. "Resumes the operator
directly into the rotation UI, not the initial template/console-handoff
screen" (the spec's own wording) means: skip the intro/template/console
screens and land directly on the key-intake-and-rotate screen, with copy
explaining a bootstrap key was previously submitted and rotation didn't
finish — prompting the operator to re-enter it (from the same
CloudFormation stack outputs, still valid) to retry. This is a UI-copy and
initial-render-target decision, not a literal resume of an async
operation — do not attempt to reconstruct or cache the secret across a
restart.

**`GUIDED_PROFILE_NAME` mirror.** `GuidedIamService.ts` exports
`GUIDED_PROFILE_NAME = 'hyveon-guided'` (main process only, not reachable
from the renderer). The credentials-step "satisfied" check and the
reconfigure pre-completion gate both need to recognize this exact profile
name. Mirror it into `desktop-preload/src/hyveon-api.ts` as its own named
export (`export const GUIDED_PROFILE_NAME = 'hyveon-guided';` with a
"mirrors `GuidedIamService.ts`'s `GUIDED_PROFILE_NAME` — keep in sync"
TSDoc note, matching this file's established mirroring convention — see
Group 5/6's `IamCheckResult`/`OpenConsoleResult` mirrors for the exact
phrasing style) — do not hardcode the literal string `'hyveon-guided'`
anywhere else in `@hyveon/web`.

**Reconfigure pre-completion — conditional, not unconditional (unlike its
three siblings in `RECONFIGURE_PRE_COMPLETED_STEPS`).** Per the spec, the
guided-IAM step only renders pre-completed when there's real evidence
guided provisioning ran — checking `wizard.state.get()`'s
`aws?.profile === GUIDED_PROFILE_NAME` IS that evidence (a plain manual
paste or CLI profile would never have this exact profile name — no new
store field is needed, this check alone is sufficient and precise). Do
NOT add `'guided-iam'` unconditionally to the `RECONFIGURE_PRE_COMPLETED_STEPS`
array the way `'pick-cloud'`/`'credentials'`/`'bootstrap'` are — those are
checked via a single `completedSteps.has(step)` today; this step needs an
extra condition folded into however `completedSteps` gets seeded (read
the shell's current seeding logic for `RECONFIGURE_PRE_COMPLETED_STEPS`
before changing it — it currently seeds unconditionally from the array in
`mode === 'reconfigure'`; the guided-iam entry needs to be added to
`completedSteps` only after confirming the profile check above, likely in
the same reconfigure-prefill `useEffect` that already calls
`window.hyveon.wizard.getState()`).

**Component ownership model — follow `stack-init-step.component.tsx`'s
pattern, NOT `credentials-step.component.tsx`'s.** Every other wizard step
component is purely presentational (shell owns all state and IPC calls) —
`stack-init-step.component.tsx` is the one exception, owning its own
internal `useState` and making its own IPC calls directly, because it's a
multi-phase async flow the shell shouldn't have to orchestrate
step-by-step. The guided-IAM step is the same shape (5 chained IPC calls,
internal sub-state machine) — build it the same way: self-contained,
owns its own state (including a region input — see next point), calls
`window.hyveon.wizard.guidedIam*` methods directly, and exposes a small
prop surface to the shell (roughly: `onComplete: () => void` for
"guided provisioning finished, advance the wizard automatically or enable
Next", `onSkipToManual: () => void` for "I already have credentials",
plus whatever initial-resume props are needed — an `initialProgress?: WizardProgress['guidedIam']`
prop the shell passes down from its own `getProgress()` call, mirroring
how the shell already resumes `stepIndex` from progress on mount).

**Region capture happens IN this step, not the credentials step.** Today
region is chosen in the credentials step, which now comes AFTER guided-IAM
— but the console handoff needs a region before the credentials step is
ever reached. Add a small region input as the first screen of this
component's internal flow (before "not-started"'s guided/manual choice,
or alongside it — implementer's call on exact layout). Once guided
provisioning completes, the credentials step displays this SAME region
(already flows through automatically: `rotate()` already calls
`store.set('aws', { ...current, profile: GUIDED_PROFILE_NAME, region })`,
and `wizard.state.get()` already returns `aws.region` — no new plumbing
needed for that half).

**Credentials step "satisfied" rendering (Task 7.4).** Extend
`CredentialsStepProps` with something like
`satisfiedByGuidedProvisioning?: { principal: string; region: string }`
(shell computes this by checking `wizard.state.get()`'s
`aws?.profile === GUIDED_PROFILE_NAME` — same check as the reconfigure
gate above, reused, not reimplemented — `principal` can be the account ID
if the shell has it handy from the guided-IAM step's completion, or
simply the profile name/region pair if that's all that's available; your
call on exact `principal` sourcing, but don't invent new IPC plumbing to
fetch an account ID that isn't already surfaced somewhere). When set,
`CredentialsStep` renders a satisfied summary (resolved principal +
region) instead of the normal profile-picker/paste form, with a "switch to
a different source" button/affordance that, when clicked, clears the
satisfied state and falls through to the normal form — mirroring
`CompletedStepSummary`'s Edit-affordance pattern but living inside this
one step component rather than replacing it wholesale (since credentials
still needs its normal picker/paste UI available as the fallback, unlike
the shell-level `CompletedStepSummary` which fully replaces a step).

**Never** touch `GuidedIamService.ts`, the IPC channels, or the preload
bridge's five `guidedIam*` methods themselves in this group — Group 6
already built and tested all of it; this group only consumes it.

## Task 1: 7.1 Step list insertion

Update all four locations in Global Constraints' "Step insertion" section.
Confirm `npm run app:typecheck` catches nothing broken by the `STEP_LABELS`
exhaustiveness check (it should just require the new entry). No new tests
needed beyond what typecheck/existing tests already catch — this task is
almost entirely mechanical; if `wizard.utils.test.ts` or similar needs a
trivial update to reflect the new array length, make it.

## Task 2: Sub-state persistence plumbing (backend + preload)

Implement the `WizardProgress`/`GuidedIamSubState` extension across
`FirstRunWizardService.ts`, `desktop-preload/src/hyveon-api.ts`, and
`WizardController`'s `wizard.progress.save`/`wizard.progress.get`
handlers, per Global Constraints. This is backend/IPC work, not UI — no
component changes in this task. Unit tests: `FirstRunWizardService.test.ts`
(new sub-state round-trips through `recordStep`/`getProgress`, a
corrupt/missing sub-state degrades to `undefined` rather than throwing,
matching the existing `DEFAULT_PROGRESS` degrade-on-corruption pattern),
plus `wizard.controller.test.ts` coverage for the extended payload
(including a `Reflect.getMetadata` pattern-guard check if the channel name
itself is unchanged — confirm it is, only the payload shape grew).

## Task 3: 7.3 Build `guided-iam-step.component.tsx`

Build the component per Global Constraints' "Component ownership model"
and "Region capture" sections — the region input; the guided-path-default
vs. "I already have credentials" choice; the template/console screen
(path display with copy + reveal-in-file-manager actions, per the spec's
"Console handoff" requirement — check what "reveal in file manager" means
practically in this Electron app, e.g. `shell.showItemInFolder` — if no
existing precedent for this exists in the codebase, a simple "Copy Path"
button alone with a documented note that reveal-in-file-manager is
deferred is an acceptable, disclosed scope reduction; don't invent new
main-process IPC for this without checking whether it already exists);
the key-intake form (access key ID + secret access key inputs, submit);
rotation progress display; the two distinct rotation failure UI states
(`verification-failed` — error message + retry action; `delete-failed` —
"bootstrap key still active, revoke manually" message + a manual "Revoke"
button wired to `guidedIamRevokeBootstrapKey`, + the console link from the
result); the resume-into-rotation-UI initial render target described in
Global Constraints. Build it standalone in this task — wiring it into the
shell's render chain is Task 4, not this one (build and unit-test the
component in isolation first, following `stack-init-step.component.tsx`'s
file structure as the closest precedent). Write focused component tests
alongside it (this task's own tests; Task 5 does a final coverage
confirmation pass, so don't feel obligated to be exhaustive here, just
cover the main rendering branches and callback firings as you build).

## Task 4: 7.2 + 7.4 + 7.5 Shell wiring

Wire everything together in `first-run-wizard.component.tsx` and
`credentials-step.component.tsx`:
- Insert the guided-IAM step into the shell's render chain (the
  `{step === 'x' && ...}` conditional chain), passing `onComplete`/
  `onSkipToManual`/`initialProgress` per Task 3's component contract.
- Reconfigure conditional pre-completion per Global Constraints (NOT an
  unconditional `RECONFIGURE_PRE_COMPLETED_STEPS` array entry).
- Credentials step's `satisfiedByGuidedProvisioning` prop computation and
  passing, per Global Constraints — extend `CredentialsStepProps` and
  `CredentialsStep`'s render logic in the same task, since the prop
  contract and its two consumers (shell computing it, component rendering
  it) are one coherent change.
- `advanceDisabled` gating: does the guided-IAM step block wizard
  advancement while incomplete? (Almost certainly yes — the operator can't
  usefully reach the credentials step without either completing guided
  provisioning or explicitly choosing "I already have credentials" — wire
  this into the existing nested-ternary `advanceDisabled` chain, matching
  its existing per-step-name pattern.) Also confirm whether "Next" should
  even be visible for this step, or whether the step's own internal
  `onComplete`/`onSkipToManual` callbacks are what advance `stepIndex`
  directly (bypassing the shared footer's Next button entirely) — check
  how `stack-init-step`'s `onFinished` interacts with the shell's
  navigation (it does NOT use the shared Next button, per Global
  Constraints research) and decide consistently; document your choice.
- Add the `guided-iam` case to the resume-on-mount effect if it needs any
  special handling beyond what Task 1/2 already provide (likely none — the
  existing `WIZARD_STEPS.indexOf(progress.step)` resume logic should
  already work once the step exists in the array; the NEW thing this task
  adds is passing `progress.guidedIam` down as `initialProgress` when
  `progress.step === 'guided-iam'`).

## Task 5: 7.6 Component test coverage confirmation

Comprehensive `guided-iam-step.component.tsx` tests (Vitest + jsdom + RTL,
matching `credentials-step.component.test.tsx`'s/`stack-init-step.component.test.tsx`'s
conventions — no `renderPage()`, plain `render()`, `vi.stubGlobal('hyveon', ...)`
for IPC mocking since this component makes its own calls unlike most
siblings): every rendering branch (not-started/guided vs. manual choice,
template-written, awaiting-key-intake, rotation-pending initial-resume
target, verification-failed, delete-failed, complete), every callback prop
firing with the right argument, and the two rotation failure states'
distinct UI. Also extend `first-run-wizard.component.test.tsx` with
coverage for: the new step appearing in the navigation flow (the existing
`advanceToCredentials()`-style helper will need updating for the new step
in between — update it rather than duplicating), the reconfigure
conditional pre-completion (guided-provisioning-evidence present vs.
absent), and the credentials step's satisfied-rendering integration. If
Tasks 3-4 already wrote focused tests covering some of this, don't
duplicate — confirm coverage and fill genuine gaps only, same pattern as
prior groups' final testing tasks.
