## ADDED Requirements

### Requirement: Credentials exported to the Terraform subprocess

Every `terraform` child process the app spawns SHALL receive an explicitly constructed environment carrying the credential source the operator selected, rather than inheriting the ambient AWS resolution chain. A single resolver MUST produce that environment for all terraform invocations: `AWS_PROFILE` plus region for the profile path, and `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` plus region read from the keychain at spawn time for the pasted and guided paths. Credential values MUST NOT appear in the streamed terraform log output.

#### Scenario: Profile path

- **WHEN** the operator's active credential source is a discovered `~/.aws` profile and a terraform command is spawned
- **THEN** the child process environment carries `AWS_PROFILE` set to that profile and the active region

#### Scenario: Pasted or guided path

- **WHEN** the operator's active credential source is a keychain-stored key pair and a terraform command is spawned
- **THEN** the child process environment carries the access key ID, secret access key, and region resolved from the keychain at spawn time

#### Scenario: Credentials absent from logs

- **WHEN** terraform output is streamed to the UI and the application log
- **THEN** no access key ID or secret access key value appears in either stream

#### Scenario: No credential source configured

- **WHEN** a terraform command is spawned before any credential source has been selected
- **THEN** the invocation fails with an explicit "credentials not configured" error rather than silently falling back to the ambient environment

### Requirement: In-app access key rotation

`AwsProfileService` SHALL support replacing the stored access key for the active credential source: mint a new key via `iam:CreateAccessKey`, persist it through the safeStorage flow, verify it with `sts:GetCallerIdentity`, and delete the superseded key. Verification MUST precede deletion, and a failed deletion MUST be reported rather than swallowed.

#### Scenario: Rotation replaces the stored key

- **WHEN** rotation runs against the active credential source
- **THEN** the keychain holds the new key pair and subsequent AWS calls and terraform spawns use it

#### Scenario: Old key retained on verification failure

- **WHEN** the newly minted key fails verification
- **THEN** the previously stored key remains active and in the keychain, and the failure is surfaced

## MODIFIED Requirements

### Requirement: Pick-or-paste credentials wizard step

The credentials wizard step SHALL present a dropdown of discovered `~/.aws` profiles and a "paste keys instead" affordance that opens a form for access key ID, secret access key, and region. Submitting the paste form MUST invoke the safeStorage paste-flow. The region selector SHALL default from the selected profile's configured region while allowing override. The chosen credential source (profile name or pasted-profile reference, plus region) SHALL round-trip to the main process and persist for later wizard steps and normal app operation. When guided IAM provisioning has already established an active credential source, the step SHALL render as satisfied — showing the resolved principal and region with an affordance to switch to a different source — rather than requiring the operator to re-enter credentials.

#### Scenario: Selecting an existing profile

- **WHEN** the operator picks a profile from the dropdown and continues
- **THEN** the main process records that profile as the active credential source with the region defaulted from the profile

#### Scenario: Pasting keys instead

- **WHEN** the operator opens the paste form and submits key ID, secret, and region
- **THEN** the safeStorage encryption flow runs, the stored profile (`hyveon-pasted` by default) becomes the active credential source, and the wizard advances

#### Scenario: Region override

- **WHEN** the operator changes the region away from the profile default before continuing
- **THEN** the overridden region is what persists as the active region

#### Scenario: Satisfied by guided provisioning

- **WHEN** the step is reached after guided IAM provisioning completed successfully
- **THEN** it renders as satisfied, showing the resolved principal and region, with an affordance to switch to a profile or pasted key instead
