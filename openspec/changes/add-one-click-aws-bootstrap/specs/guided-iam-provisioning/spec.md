## ADDED Requirements

### Requirement: CloudFormation template generated from the shared action set

The app SHALL ship a CloudFormation template that provisions the deploy principal: an `AWS::IAM::ManagedPolicy`, an `AWS::IAM::User` whose name comes from a stack parameter defaulting to `hyveon`, and an `AWS::IAM::AccessKey` carrying `DeletionPolicy: Retain`. The managed policy document MUST be generated from `HYVEON_DEPLOY_ALL_ACTIONS` in `@hyveon/shared`, preserving the `HyveonDeploy`, `HyveonIAM`, and `HyveonTfvarsBucket` statement structure, so the provisioned permissions cannot drift from the set `IamCheckService` verifies. The generated document MUST reproduce that action set exactly, neither narrowing nor widening it — tightening the policy is a separate change. The template SHALL expose the user name, policy ARN, access key ID, and secret access key as stack outputs.

#### Scenario: Generated policy matches the shared source of truth

- **WHEN** the template's managed policy document is generated
- **THEN** its action list is exactly `HYVEON_DEPLOY_ALL_ACTIONS`, with no action present in one and absent from the other

#### Scenario: Access key survives stack deletion

- **WHEN** the operator deletes the CloudFormation stack after the app has already revoked the bootstrap access key
- **THEN** stack deletion succeeds, because the access key resource carries `DeletionPolicy: Retain`

#### Scenario: Custom principal name

- **WHEN** the operator supplies a user name other than the default via the stack parameter
- **THEN** the stack creates the principal under that name and the app records it as the deploy principal

### Requirement: Console handoff for stack creation

The guided provisioning step SHALL write the rendered template to a known path under the app's `userData` directory and open the AWS CloudFormation "Create stack" console page in the operator's default browser, scoped to the region selected earlier in the wizard. The step MUST display the written file path with a copy-path action and a reveal-in-file-manager action, and instruct the operator to choose "Upload a template file". The console URL SHALL be constructed in exactly one place so its shape can be pinned by a unit test. The app MUST NOT require or request the operator's root credentials at any point; the console session is the operator's own and no credential from it reaches the app.

#### Scenario: Template written and console opened

- **WHEN** the operator starts guided provisioning with a region already selected
- **THEN** the template file is written to `userData`, the CloudFormation create-stack console page opens in the default browser scoped to that region, and the step shows the file path with copy and reveal actions

#### Scenario: Browser cannot be opened

- **WHEN** the app fails to launch the operator's default browser
- **THEN** the step displays the full console URL as selectable text alongside the template path, so the operator can complete the handoff manually

### Requirement: Bootstrap key intake

After the stack completes, the step SHALL accept the access key ID and secret access key from the stack outputs, validate them with `sts:GetCallerIdentity`, and record the resolved account ID. Invalid or unauthenticated keys MUST be rejected with the underlying AWS error surfaced, leaving the operator on the step. The pasted secret MUST NOT be written to disk unencrypted at any point, nor emitted to logs.

#### Scenario: Valid bootstrap key accepted

- **WHEN** the operator submits an access key ID and secret that authenticate successfully
- **THEN** `sts:GetCallerIdentity` resolves, the account ID is recorded, and the step advances to rotation

#### Scenario: Invalid key rejected

- **WHEN** the submitted credentials fail to authenticate
- **THEN** the step reports the AWS error, does not persist the credentials, and keeps the operator on the intake form

#### Scenario: Secret never logged

- **WHEN** any guided provisioning operation writes to the application log
- **THEN** the secret access key value does not appear in the log output

### Requirement: Mandatory bootstrap key rotation

Once a bootstrap key authenticates, the app SHALL mint a replacement access key via `iam:CreateAccessKey`, store it via the safeStorage keychain flow, verify the replacement with `sts:GetCallerIdentity`, and only then delete the bootstrap key via `iam:DeleteAccessKey`. Verification MUST precede deletion. If deletion fails, the app SHALL surface an explicit warning stating that the bootstrap key remains active and must be revoked manually, with a direct console link — it MUST NOT report rotation as successful. Rotation MUST run before the IAM permission gate so the credential being verified is the one the app retains.

#### Scenario: Successful rotation

- **WHEN** the bootstrap key authenticates
- **THEN** a new access key is created, stored in the OS keychain, verified via `sts:GetCallerIdentity`, and the bootstrap key is deleted, after which the value in the stack outputs authenticates nothing

#### Scenario: Verification fails before deletion

- **WHEN** the newly minted key fails `sts:GetCallerIdentity`
- **THEN** the bootstrap key is NOT deleted and the step reports the failure with a retry action

#### Scenario: Deletion denied

- **WHEN** `iam:DeleteAccessKey` fails for the bootstrap key
- **THEN** the step reports that the bootstrap key is still active, links to the IAM console to revoke it, and does not present rotation as complete

#### Scenario: Rotation pending across restarts

- **WHEN** the operator quits the app after intake but before rotation completes
- **THEN** the persisted wizard progress records rotation as pending and the next launch resumes into the rotation step rather than advancing past it

### Requirement: Keychain requirement for guided credentials

Guided provisioning SHALL depend on the OS keychain being available. When `SafeStorageService` reports encryption unavailable, the step MUST refuse to store any credential and direct the operator to the profile-picker or manual path instead of degrading to plaintext storage.

#### Scenario: Keychain unavailable

- **WHEN** the operator reaches rotation on a system where safeStorage encryption is unavailable
- **THEN** no credential is written to disk, the step reports the keychain as unavailable, and the operator is offered the alternative credential paths
