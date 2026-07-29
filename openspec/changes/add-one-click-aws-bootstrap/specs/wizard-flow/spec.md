## ADDED Requirements

### Requirement: Guided IAM provisioning step

The wizard SHALL include a guided IAM provisioning step positioned between the pick-cloud step and the credentials step. The step SHALL offer guided CloudFormation-based provisioning as the default path while keeping "I already have credentials" as an explicit alternative that skips ahead to the credentials step. Completing guided provisioning MUST record the resulting credential source as active, making the credentials step satisfied without further operator input. The step MUST participate in the wizard's resumable progress state, including the rotation-pending case.

#### Scenario: Guided path completes

- **WHEN** the operator completes guided provisioning end to end
- **THEN** the rotated key becomes the active credential source and the wizard advances past the credentials step without asking for a profile or pasted keys

#### Scenario: Operator already has credentials

- **WHEN** the operator chooses "I already have credentials"
- **THEN** the wizard advances to the credentials step with the profile-picker and paste paths unchanged

#### Scenario: Resume mid-provisioning

- **WHEN** the app is relaunched after guided provisioning was started but not finished
- **THEN** the wizard resumes at the guided step in the sub-state it was left in, rather than restarting the wizard or skipping the step

### Requirement: Deployment settings step

The wizard SHALL include a deployment settings step positioned between the bootstrap step and the terraform-init step, presenting the app-owned **top-level** Terraform variables and writing them through `TfvarsService`. The `game_servers` map is out of this step's scope and continues to be edited through the existing game UI. The step MUST block progression while validation fails, and MUST NOT be considered complete until a valid write has succeeded.

#### Scenario: Settings written before init

- **WHEN** the operator completes the deployment settings step
- **THEN** a validated `terraform.tfvars` exists before `terraform init` runs

#### Scenario: Validation blocks progression

- **WHEN** a required variable is missing or invalid
- **THEN** the step reports the offending field and the operator cannot advance to terraform init

#### Scenario: Pre-existing settings prefilled

- **WHEN** the step opens against a repository that already has a `terraform.tfvars`
- **THEN** the form is prefilled from that file rather than from defaults

## MODIFIED Requirements

### Requirement: Reconfigure entry point in Settings

The Settings page SHALL surface a "Reconfigure" button that relaunches the wizard against the existing electron-store state, re-running the cloud, credentials, bootstrap, deployment-settings, and init steps — prerequisite detection is the first step and is not repeated, and guided IAM provisioning is omitted because an existing install already has a deploy principal. Steps already satisfied by existing state SHALL render as completed with a per-step "Edit" affordance rather than forcing re-entry. Reconfigure MUST preserve existing configuration except the fields the operator changes, and cancelling mid-flow MUST leave the pre-reconfigure configuration intact and the app usable.

#### Scenario: Reconfigure with one change

- **WHEN** the operator opens Reconfigure and edits only the region in the credentials step
- **THEN** the region updates while every other stored setting is preserved

#### Scenario: Completed steps are skippable

- **WHEN** Reconfigure opens with all steps previously completed
- **THEN** each step shows as completed with an "Edit" affordance and the operator can jump straight to finishing

#### Scenario: Mid-flow cancel

- **WHEN** the operator cancels Reconfigure partway through
- **THEN** no partial changes are committed and the app returns to Settings in its prior working state

#### Scenario: Guided provisioning omitted

- **WHEN** the operator opens Reconfigure
- **THEN** the guided IAM provisioning step is not present in the step list, while the deployment-settings step is

#### Scenario: Terraform settings editable via Reconfigure

- **WHEN** the operator opens Reconfigure to change a Terraform variable
- **THEN** the deployment-settings step is reachable and its write path is the same one the first-run wizard uses
