# cloud-bootstrap

## Purpose

Defines SDK-only backend bootstrap in the desktop main process: creating and configuring the state bucket and the configuration bucket idempotently via AWS SDK v3 (never shelling out to the `aws` CLI or Terraform, and never importable from the renderer), running a best-effort IAM permission simulation against `HyveonDeployAll`, and exposing each bootstrap operation over IPC with per-resource progress reporting.

## Requirements

### Requirement: SDK-only bootstrap in the main process

All backend bootstrap operations (state bucket, configuration bucket, IAM simulation) SHALL be performed via AWS SDK v3 clients in the desktop main process — never by shelling out to the `aws` CLI or Terraform. The renderer MUST NOT import any `@aws-sdk/*` package; an ESLint rule SHALL enforce this ban for `@hyveon/web`. SDK clients MUST be constructed with the credentials and region selected in the credentials step (profile via the SDK credential chain, or paste-flow values decrypted in the main process).

#### Scenario: Bootstrap uses SDK clients only

- **WHEN** any wizard bootstrap step runs
- **THEN** the work is done through `@aws-sdk/client-s3` / `@aws-sdk/client-dynamodb` / `@aws-sdk/client-iam` calls in the main process, with no child-process shell-out

#### Scenario: Renderer AWS SDK import is a lint error

- **WHEN** a file under `app/packages/web/` imports from `@aws-sdk/*`
- **THEN** `npm run app:lint` fails on that import

### Requirement: State bucket bootstrap

The bootstrap service SHALL create the S3 bucket backing the self-managed infrastructure state backend (`BootstrapService.ensureStateBucket`) when it does not exist, then enable bucket versioning (`PutBucketVersioning`) and default server-side encryption (`PutBucketEncryption`). The operation MUST be idempotent: an already-existing bucket owned by the caller (`BucketAlreadyOwnedByYou`, or a successful existence check) is a success no-op, while a bucket owned by another account surfaces a clear error.

#### Scenario: Fresh bucket

- **WHEN** the state bucket does not exist
- **THEN** the service creates it and enables versioning and SSE, and the step reports success

#### Scenario: Bucket already exists and is owned by the caller

- **WHEN** the state bucket already exists in the caller's account
- **THEN** the step succeeds without error and versioning/SSE are ensured

#### Scenario: Bucket name taken by another account

- **WHEN** `CreateBucket` fails because the name is owned elsewhere
- **THEN** the wizard surfaces an actionable error and does not mark the step complete

### Requirement: Configuration bucket bootstrap

The bootstrap service SHALL create the versioned configuration bucket (`BootstrapService.ensureConfigurationBucket`) when missing, enable versioning, and apply a lifecycle configuration expiring noncurrent object versions after 90 days, so the bucket is usable as the canonical `RemoteFileStore` holding the JSON deployment-config object. The operation MUST be idempotent.

#### Scenario: Fresh configuration bucket

- **WHEN** the configuration bucket does not exist
- **THEN** the service creates it with versioning enabled and a 90-day noncurrent-version-expiration lifecycle rule

#### Scenario: Configuration bucket already exists

- **WHEN** the configuration bucket already exists in the caller's account
- **THEN** the step succeeds and versioning plus the lifecycle rule are ensured

### Requirement: Default encryption on the configuration bucket

The configuration bucket `BootstrapService.ensureConfigurationBucket()` creates SHALL have AES256 default server-side encryption applied (`PutBucketEncryption`), matching what `ensureStateBucket()` already applies to the state bucket. The call MUST be idempotent, applying on the `exists` path as well as the `created` path so a bucket provisioned before this requirement is brought into line. Failure to apply encryption MUST surface as a bootstrap failure rather than being silently ignored.

Public-access-block hardening is **not** part of this requirement: both `ensureStateBucket()` and `ensureConfigurationBucket()` already call a shared `ensurePublicAccessBlock()` helper unconditionally (all four settings, on both the `created` and `exists` paths), so that hardening already exists for both buckets as a side effect of unrelated `migrate-iac-to-pulumi` work. Encryption is the one asymmetry that remains.

#### Scenario: New configuration bucket is encrypted

- **WHEN** `ensureConfigurationBucket()` creates a new bucket
- **THEN** AES256 default server-side encryption is enabled on it, matching what `ensureStateBucket()` already does for the state bucket

#### Scenario: Pre-existing configuration bucket brought into line

- **WHEN** bootstrap runs against a configuration bucket that already exists without default encryption
- **THEN** encryption is applied and the operation still reports `exists` rather than `created`

#### Scenario: Encryption application fails

- **WHEN** the `PutBucketEncryption` call is denied or errors
- **THEN** the bootstrap operation reports `failed` with the underlying error rather than reporting success

### Requirement: IAM permission simulation

After credentials are wired, the wizard SHALL run a dry-run via `iam:SimulatePrincipalPolicy` against the calling identity (resolved via `sts:GetCallerIdentity`) for the action set of the `HyveonDeployAll` policy, whose single source of truth is `HYVEON_DEPLOY_ALL_ACTIONS` in `@hyveon/shared`, mirrored in the policy JSON in `docs/docs/setup.md`. Simulation requests MUST be batched to stay within API limits and minimize false positives. Missing actions SHALL be surfaced in the wizard as a "Required IAM JSON" panel containing copy-paste-able policy JSON covering the denied actions. The wizard MUST NEVER attempt to grant permissions itself.

Simulation outcome SHALL gate differently depending on how credentials were obtained. On the guided IAM provisioning path the permission set is known by construction, so the check runs automatically after key rotation and a `missing` result MUST block progression, listing the denied actions with a re-run action — a failure there indicates a real fault such as the wrong account, a partially-failed stack, or a denying service control policy. On the profile-picker and paste paths the check remains advisory and MUST NOT block, since an operator may deliberately be running a narrower policy. Simulation failure (e.g. the caller lacks `iam:SimulatePrincipalPolicy` itself) MUST degrade to a warning with the full checklist shown on every path — it never blocks.

#### Scenario: All actions allowed

- **WHEN** the simulation reports every `HyveonDeployAll` action as allowed
- **THEN** the wizard shows the IAM check as passed with no JSON panel

#### Scenario: Missing actions surfaced as pasteable JSON

- **WHEN** the simulation reports one or more actions as denied
- **THEN** the wizard renders a "Required IAM JSON" panel whose policy JSON the operator can paste into the AWS console, and no auto-grant is attempted

#### Scenario: Simulation itself is not permitted

- **WHEN** the `SimulatePrincipalPolicy` call fails with an access error
- **THEN** the wizard shows a non-blocking warning with the full permission checklist instead of a hard failure

#### Scenario: Denied actions block the guided path

- **WHEN** the simulation reports denied actions and the active credentials came from guided IAM provisioning
- **THEN** the wizard blocks progression, lists the denied actions, and offers a re-run action

#### Scenario: Denied actions stay advisory on the manual paths

- **WHEN** the simulation reports denied actions and the active credentials came from a picked profile or pasted keys
- **THEN** the wizard surfaces the panel as a warning and the operator may continue

#### Scenario: Gate runs after rotation

- **WHEN** guided IAM provisioning completes
- **THEN** the simulation runs against the rotated key that the app retains, not against the bootstrap key issued by the stack

### Requirement: Bootstrap IPC and progress reporting

Each bootstrap resource (state bucket, configuration bucket, deployment config, runs table) SHALL be invocable from the renderer through IPC-only controller message patterns under a `wizard.bootstrap.*` namespace, mirrored in the typed preload API, reporting per-resource status (`pending` / `creating` / `exists` / `created` / `failed` with an error message) so the wizard step can render granular progress. IAM permission simulation is invoked separately, under `wizard.iam.simulate`.

#### Scenario: Renderer runs the bootstrap step

- **WHEN** the renderer invokes the bootstrap IPC methods for the four resources
- **THEN** each resolves with a per-resource status the step renders, and a failure in one resource reports `failed` with its error message without masking the others
