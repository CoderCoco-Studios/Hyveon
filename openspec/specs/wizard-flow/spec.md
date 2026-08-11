# wizard-flow

## Purpose

Defines the first-run wizard's overall flow: launch gating based on `wizardCompleted`, a resumable `FirstRunWizardService` that persists per-step progress, the cloud-choice step, the stack-initialization step with phased progress, wizard completion, and the Settings-page "Reconfigure" entry point that re-runs later steps against existing state.

## Requirements

### Requirement: Wizard launch gating

The app SHALL open into the first-run wizard when `wizardCompleted` in electron-store is false (or unset), and into the dashboard when it is true. Completing the wizard SHALL set `wizardCompleted: true` and navigate to the dashboard.

#### Scenario: First launch on a clean machine

- **WHEN** the app launches with no prior wizard completion recorded
- **THEN** the renderer shows the first-run wizard instead of the dashboard

#### Scenario: Subsequent launches

- **WHEN** the app launches after the wizard has been completed
- **THEN** the dashboard opens directly and the wizard is not shown

### Requirement: FirstRunWizardService with resumable state

A `FirstRunWizardService` in the desktop main process SHALL own wizard progress, persisting per-step completion and answers to `userData/state.json` after each step so a partial run resumes at the first incomplete step on next launch. State reads/writes go through the service (no raw `process.env` or ad-hoc file access in business logic), and the file path is resolved through an Electron seam that degrades gracefully outside Electron for tests.

#### Scenario: Resume after interrupted run

- **WHEN** the operator quits the app after completing steps 1–3 and relaunches
- **THEN** the wizard reopens at step 4 with the answers from steps 1–3 preserved

#### Scenario: Corrupt or missing state file

- **WHEN** `userData/state.json` is missing or unparseable
- **THEN** the wizard starts from step 1 without crashing

### Requirement: Pick-cloud step

The first wizard step SHALL present the cloud choice as a single-option selection hard-coded to "AWS" for v1, with a "more clouds coming" footer, and persist the choice to electron-store as `activeCloud: 'aws'` via `ElectronStoreService`. The step's data model MUST be structured so additional options (`gcp`, `azure`) can be added without reworking the step (options driven by a list, not a hard-coded single control).

#### Scenario: Choosing AWS

- **WHEN** the operator confirms the cloud step
- **THEN** `activeCloud: 'aws'` is persisted and survives an app relaunch

#### Scenario: Only AWS is offered in v1

- **WHEN** the cloud step renders
- **THEN** AWS is the only selectable option and the footer indicates more clouds are coming

### Requirement: Guided IAM provisioning step

The wizard SHALL include a guided IAM provisioning step positioned between the pick-cloud step and the credentials step — ahead of the current four-step baseline (`pick-cloud`, `credentials`, `bootstrap`, `stack-init`) in `WIZARD_STEPS`. The step SHALL offer guided CloudFormation-based provisioning as the default path while keeping "I already have credentials" as an explicit alternative that skips ahead to the credentials step. Completing guided provisioning MUST record the resulting credential source as active, making the credentials step satisfied without further operator input. The step MUST participate in the wizard's resumable progress state, including the rotation-pending case. Resuming requires more than the step name: the persisted progress record MUST also carry a typed guided-IAM sub-state (at minimum: `not-started` | `template-written` | `awaiting-key-intake` | `rotation-pending` | `complete`, plus the bootstrap key's presence/absence so the UI never re-displays a secret) so a relaunch resumes into the exact sub-step it left off at, not only "the guided-IAM step in general."

#### Scenario: Guided path completes

- **WHEN** the operator completes guided provisioning end to end
- **THEN** the rotated key becomes the active credential source and the wizard advances past the credentials step without asking for a profile or pasted keys

#### Scenario: Operator already has credentials

- **WHEN** the operator chooses "I already have credentials"
- **THEN** the wizard advances to the credentials step with the profile-picker and paste paths unchanged

#### Scenario: Resume mid-provisioning

- **WHEN** the app is relaunched after guided provisioning was started but not finished
- **THEN** the wizard resumes at the guided step in the sub-state it was left in, rather than restarting the wizard or skipping the step

#### Scenario: Resume lands in the correct sub-state

- **WHEN** the app is relaunched after guided provisioning reached "awaiting rotation"
- **THEN** the persisted sub-state resumes the operator directly into the rotation UI, not the initial template/console-handoff screen

### Requirement: Stack initialization step with phased progress

The final configuration step SHALL invoke `window.hyveon.iac.stack.initialize()` (the `iac.stack.initialize` IPC channel, no request payload) against the bootstrapped backend resources. The call SHALL return an async-iterable handle that streams structured `{ phase, status }` events — `phase` one of `engine` | `plugins` | `operation` (Pulumi engine resolution, provider plugin install, stack creation, in that order) and `status` one of `start` | `end` — rather than raw log text. The step SHALL render a three-item checklist reflecting each phase's state (pending / in-progress / done / failed) as events arrive. If the shared workspace is already busy with another operation, or the stream throws once started, the step SHALL mark the last-started phase as failed, show an inline error, keep the completion control disabled, and offer a retry that starts a fresh attempt. The completion control SHALL enable only once every phase has completed successfully.

#### Scenario: Successful stack initialization

- **WHEN** `iac.stack.initialize()` streams `start`/`end` events for all three phases and the stream completes without error
- **THEN** the checklist shows all three phases as done and the completion button becomes enabled

#### Scenario: Failed stack initialization

- **WHEN** the `iac.stack.initialize()` stream throws after a phase's `start` event has fired
- **THEN** the step marks that phase as failed, shows an inline error, keeps the completion button disabled, and offers a retry

### Requirement: Wizard completion

On finishing the final step, the wizard SHALL persist all answers (via `ElectronStoreService` and the wizard state file), set `wizardCompleted: true`, and open the dashboard. A fresh install on a clean machine MUST reach "dashboard ready" through the wizard without manual file editing.

#### Scenario: End-to-end completion

- **WHEN** the operator completes all wizard steps on a clean machine
- **THEN** answers are persisted, `wizardCompleted` is true, and the dashboard opens without any hand-edited config files

### Requirement: Reconfigure entry point in Settings

The Settings page SHALL surface a "Reconfigure" button that relaunches the wizard (`mode: 'reconfigure'`) against the existing electron-store state, re-running the cloud, credentials, bootstrap, and stack-init steps. Guided IAM provisioning participates in reconfigure mode as a pre-completed step (added to `RECONFIGURE_PRE_COMPLETED_STEPS` alongside `pick-cloud`/`credentials`/`bootstrap`) rather than being removed from the step list, since an existing install already has a deploy principal. Steps already satisfied by existing state SHALL render as completed with a per-step "Edit" affordance rather than forcing re-entry. Reconfigure MUST preserve existing configuration except the fields the operator changes. Cancelling mid-flow MUST leave the pre-reconfigure **local configuration** intact and the app usable — this guarantee covers only `ElectronStoreService` state; it does NOT retroactively undo AWS-side mutations already performed during the flow (a CloudFormation stack created by guided IAM, an access key already rotated, S3 encryption already enabled). Those are real external changes with no local "undo"; the step must make this distinction visible to the operator rather than implying full rollback.

#### Scenario: Reconfigure with one change

- **WHEN** the operator opens Reconfigure and edits only the region in the credentials step
- **THEN** the region updates while every other stored setting is preserved

#### Scenario: Completed steps are skippable

- **WHEN** Reconfigure opens with all steps previously completed
- **THEN** each step shows as completed with an "Edit" affordance and the operator can jump straight to finishing

#### Scenario: Mid-flow cancel

- **WHEN** the operator cancels Reconfigure partway through
- **THEN** no partial changes are committed and the app returns to Settings in its prior working state

#### Scenario: Mid-flow cancel after an AWS-side mutation

- **WHEN** the operator cancels Reconfigure after guided-IAM provisioning has already created the CloudFormation stack or rotated the access key
- **THEN** local configuration reverts to its pre-reconfigure state, but the created stack and rotated key remain in AWS exactly as they are — the app does not claim to have undone them

#### Scenario: Guided provisioning renders pre-completed

- **WHEN** the operator opens Reconfigure and a persisted deploy-principal record shows guided provisioning previously completed
- **THEN** the guided IAM provisioning step renders collapsed with an "Edit" affordance rather than requiring the operator to re-provision a deploy principal

#### Scenario: No pre-completion without provisioning evidence

- **WHEN** the operator opens Reconfigure on an install whose active credential source is a profile or pasted keys, with no persisted deploy-principal record
- **THEN** the guided-IAM step renders as not-completed, offering guided provisioning or "I already have credentials" like a first run

### Requirement: Resolved Pulumi engine version in Settings

Settings SHALL display the Pulumi engine version resolved by `PulumiEngineService` (via `iac.settings.engineVersion`) alongside the pinned/target engine version (`PULUMI_ENGINE_VERSION`), so operators can see what the app provisioned against.

#### Scenario: Settings shows versions

- **WHEN** the operator opens Settings after wizard completion
- **THEN** the resolved Pulumi engine version and the pinned/target version are both visible

### Requirement: Responsive wizard shell layout

When the wizard is shown in first-run mode (the full-window mandatory
first-launch experience), it SHALL render a two-region layout at the `md:`
breakpoint (768px) and above: a fixed-width step-progress sidebar alongside
the active step's content, with the content column's maximum width
increased from 576px to 672px. Below the `md:` breakpoint, the wizard SHALL
render as a single centered column matching its current (pre-change)
layout, with the sidebar not shown.

#### Scenario: Wide viewport shows sidebar and wider content

- **WHEN** the wizard renders in a window at least 768px wide
- **THEN** a step-progress sidebar is visible alongside the step content,
  and the step content's container is wider than the pre-change 576px cap

#### Scenario: Narrow viewport falls back to single column

- **WHEN** the wizard renders in a window narrower than 768px
- **THEN** no step-progress sidebar is shown and the step content renders
  as a single centered column at its original width

### Requirement: Step progress sidebar

The step-progress sidebar is shown only when the wizard is rendered in
first-run mode. When shown, it SHALL list all wizard steps in order and
indicate, per step, whether it is completed (before the current step),
current, or upcoming (after the current step). The sidebar SHALL NOT be
interactive — it MUST NOT provide a way to navigate directly to a step
other than through the wizard's existing forward/back controls.

#### Scenario: Sidebar reflects current step position

- **WHEN** the wizard is showing step 3 of 5
- **THEN** the sidebar shows steps 1-2 as completed, step 3 as current, and
  steps 4-5 as upcoming

#### Scenario: Sidebar entries do not navigate

- **WHEN** the operator interacts with a step-progress sidebar entry for a
  step other than the current one
- **THEN** the wizard's current step does not change

#### Scenario: No sidebar in reconfigure mode

- **WHEN** the wizard renders in reconfigure mode (launched from Settings →
  Reconfigure)
- **THEN** no step-progress sidebar is shown, regardless of viewport width
