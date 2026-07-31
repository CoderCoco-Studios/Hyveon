## ADDED Requirements

### Requirement: Guided IAM provisioning step

The wizard SHALL include a guided IAM provisioning step positioned between the pick-cloud step and the credentials step — ahead of the current four-step baseline (`pick-cloud`, `credentials`, `bootstrap`, `stack-init`) in `WIZARD_STEPS`. The step SHALL offer guided CloudFormation-based provisioning as the default path while keeping "I already have credentials" as an explicit alternative that skips ahead to the credentials step. Completing guided provisioning MUST record the resulting credential source as active, making the credentials step satisfied without further operator input. The step MUST participate in the wizard's resumable progress state, including the rotation-pending case.

#### Scenario: Guided path completes

- **WHEN** the operator completes guided provisioning end to end
- **THEN** the rotated key becomes the active credential source and the wizard advances past the credentials step without asking for a profile or pasted keys

#### Scenario: Operator already has credentials

- **WHEN** the operator chooses "I already have credentials"
- **THEN** the wizard advances to the credentials step with the profile-picker and paste paths unchanged

#### Scenario: Resume mid-provisioning

- **WHEN** the app is relaunched after guided provisioning was started but not finished
- **THEN** the wizard resumes at the guided step in the sub-state it was left in, rather than restarting the wizard or skipping the step

## MODIFIED Requirements

### Requirement: Reconfigure entry point in Settings

The Settings page SHALL surface a "Reconfigure" button that relaunches the wizard (`mode: 'reconfigure'`) against the existing electron-store state, re-running the cloud, credentials, bootstrap, and stack-init steps — prerequisite detection is the first step and is not repeated. Guided IAM provisioning participates in reconfigure mode as a pre-completed step (added to `RECONFIGURE_PRE_COMPLETED_STEPS` alongside `pick-cloud`/`credentials`/`bootstrap`) rather than being removed from the step list, since an existing install already has a deploy principal. Steps already satisfied by existing state SHALL render as completed with a per-step "Edit" affordance rather than forcing re-entry. Reconfigure MUST preserve existing configuration except the fields the operator changes, and cancelling mid-flow MUST leave the pre-reconfigure configuration intact and the app usable.

#### Scenario: Reconfigure with one change

- **WHEN** the operator opens Reconfigure and edits only the region in the credentials step
- **THEN** the region updates while every other stored setting is preserved

#### Scenario: Completed steps are skippable

- **WHEN** Reconfigure opens with all steps previously completed
- **THEN** each step shows as completed with an "Edit" affordance and the operator can jump straight to finishing

#### Scenario: Mid-flow cancel

- **WHEN** the operator cancels Reconfigure partway through
- **THEN** no partial changes are committed and the app returns to Settings in its prior working state

#### Scenario: Guided provisioning renders pre-completed

- **WHEN** the operator opens Reconfigure
- **THEN** the guided IAM provisioning step renders collapsed with an "Edit" affordance rather than requiring the operator to re-provision a deploy principal
