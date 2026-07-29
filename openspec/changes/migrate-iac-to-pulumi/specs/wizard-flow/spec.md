## MODIFIED Requirements

### Requirement: Reconfigure entry point in Settings

The Settings page SHALL surface a "Reconfigure" button that relaunches the wizard against the existing electron-store state, re-running every step in the flow (cloud, credentials, bootstrap, stack initialization). Because prerequisite detection no longer exists as a step, there is no step excluded from Reconfigure and no special-casing in the step list. Steps already satisfied by existing state SHALL render as completed with a per-step "Edit" affordance rather than forcing re-entry. Reconfigure MUST preserve existing configuration except the fields the operator changes, and cancelling mid-flow MUST leave the pre-reconfigure configuration intact and the app usable.

#### Scenario: Reconfigure with one change

- **WHEN** the operator opens Reconfigure and edits only the region in the credentials step
- **THEN** the region updates while every other stored setting is preserved

#### Scenario: Completed steps are skippable

- **WHEN** Reconfigure opens with all steps previously completed
- **THEN** each step shows as completed with an "Edit" affordance and the operator can jump straight to finishing

#### Scenario: Reconfigure covers the whole flow

- **WHEN** Reconfigure opens
- **THEN** every wizard step is present in the flow, with no step filtered out of the reconfigure step list

#### Scenario: Mid-flow cancel

- **WHEN** the operator cancels Reconfigure partway through
- **THEN** no partial changes are committed and the app returns to Settings in its prior working state

## ADDED Requirements

### Requirement: Stack initialization step with live log

The final configuration step SHALL provision the infrastructure engine (per `pulumi-engine-runtime`) and select or create the stack against the bootstrapped self-managed backend, streaming progress live into a wizard log pane over a streaming IPC channel exposed as an async iterable, following the same shape the previous init step used. ANSI escape sequences in the output MUST render as styled HTML. Because the first run downloads both the engine and the cloud provider plugin, the step MUST report "provisioning the engine", "downloading provider plugins", and "initializing the stack" as distinct phases so a multi-minute first run is not mistaken for a hang. The step MUST also set the stack's secrets provider at creation time, because it cannot be changed afterwards through the automation interface and a stack created without one would have to be recreated to correct it. The completion control SHALL enable only on success; a failure SHALL surface an error state with the captured log and allow retry.

#### Scenario: Successful initialization on a clean machine

- **WHEN** the step runs on a machine with no engine cached and the stack does not yet exist
- **THEN** the pane reports engine provisioning, then provider plugin download, then stack initialization, the stack is created against the operator's own S3 backend with its secrets provider set, and the completion button becomes enabled

#### Scenario: Engine already cached

- **WHEN** the step runs on a machine where the pinned engine version is already cached
- **THEN** no download is reported and the step proceeds directly to stack initialization

#### Scenario: Failed initialization

- **WHEN** engine provisioning or stack initialization fails
- **THEN** the step shows an error UI with the log and the failure cause, keeps the completion button disabled, and offers a retry

#### Scenario: ANSI output renders

- **WHEN** the streamed output contains ANSI color escapes
- **THEN** the log pane renders them as styled HTML rather than raw escape bytes

### Requirement: Resolved engine version in Settings

Settings SHALL display the infrastructure engine version the app resolved alongside the version it pins, so operators can confirm what their deployments run against. Because the app provisions the engine itself, these values normally match; a mismatch indicates a failed or pending provisioning and SHALL be shown as such rather than silently hidden.

#### Scenario: Settings shows the engine version

- **WHEN** the operator opens Settings after wizard completion
- **THEN** the resolved engine version and the pinned version are both visible

#### Scenario: Engine not yet provisioned

- **WHEN** the operator opens Settings before any infrastructure operation has run and no engine is cached
- **THEN** Settings reports the engine as not yet provisioned rather than showing a blank or stale version

## REMOVED Requirements

### Requirement: Terraform init step with live log

**Reason**: `TerraformService.init({ backendConfig: { bucket, region, dynamodbTable } })` no longer exists. There is no `terraform init` to run, no `.terraform` directory to populate, and no DynamoDB lock table to point a backend at.

**Migration**: Replaced by the "Stack initialization step with live log" requirement above. The streaming IPC shape and the ANSI log pane are reused; only the underlying operation and the backend-config inputs change.

### Requirement: Resolved Terraform version in Settings

**Reason**: There is no operator-installed Terraform binary whose version could be resolved, and no minimum-version gate to display it against.

**Migration**: Replaced by the "Resolved engine version in Settings" requirement above, sourced from the engine service rather than from prerequisite detection.
