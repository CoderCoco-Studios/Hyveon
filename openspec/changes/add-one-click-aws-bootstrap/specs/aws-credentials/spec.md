## ADDED Requirements

### Requirement: In-app access key rotation

`AwsProfileService` SHALL support replacing the stored access key for the active credential source: mint a new key via `iam:CreateAccessKey`, persist it through the safeStorage flow, verify it with `sts:GetCallerIdentity`, and delete the superseded key. Verification MUST precede deletion, and a failed deletion MUST be reported rather than swallowed.

#### Scenario: Rotation replaces the stored key

- **WHEN** rotation runs against the active credential source
- **THEN** the keychain holds the new key pair and subsequent AWS calls and infrastructure-engine invocations use it

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
