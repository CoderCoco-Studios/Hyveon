# cloud-bootstrap

## Purpose

Defines SDK-only backend bootstrap in the desktop main process: creating and configuring the state bucket and the configuration bucket idempotently via AWS SDK v3 (never shelling out to the `aws` CLI or Terraform, and never importable from the renderer), running a best-effort IAM permission simulation against `HyveonDeployAll`, and exposing each bootstrap operation over IPC with per-resource progress reporting.

## Requirements

### Requirement: SDK-only bootstrap in the main process

All backend bootstrap operations (state bucket, configuration bucket, IAM simulation) SHALL be performed via AWS SDK v3 clients in the desktop main process — never by shelling out to a CLI and never by invoking the infrastructure engine, which cannot provision the backend it is configured to read from. The renderer MUST NOT import any `@aws-sdk/*` package; an ESLint rule SHALL enforce this ban for `@hyveon/web`. SDK clients MUST be constructed with the credentials and region selected in the credentials step (profile via the SDK credential chain, or paste-flow values decrypted in the main process).

#### Scenario: Bootstrap uses SDK clients only

- **WHEN** any wizard bootstrap step runs
- **THEN** the work is done through `@aws-sdk/client-s3` / `@aws-sdk/client-iam` calls in the main process, with no child-process shell-out and no engine invocation

#### Scenario: Renderer AWS SDK import is a lint error

- **WHEN** a file under `app/packages/web/` imports from `@aws-sdk/*`
- **THEN** `npm run app:lint` fails on that import

### Requirement: State backend bucket bootstrap

The bootstrap service SHALL create the S3 bucket that backs the self-managed infrastructure state backend when it does not exist, then enable bucket versioning and default server-side encryption. The operation MUST be idempotent: an already-existing bucket owned by the caller (`BucketAlreadyOwnedByYou`, or a successful existence check) is a success no-op, while a bucket owned by another account surfaces a clear error. Versioning is required so a corrupted or unwanted state write can be recovered.

#### Scenario: Fresh state bucket

- **WHEN** the state bucket does not exist
- **THEN** the service creates it and enables versioning and SSE, and the step reports success

#### Scenario: Bucket already exists and is owned by the caller

- **WHEN** the state bucket already exists in the caller's account
- **THEN** the step succeeds without error and versioning and SSE are ensured

#### Scenario: Bucket name taken by another account

- **WHEN** `CreateBucket` fails because the name is owned elsewhere
- **THEN** the wizard surfaces an actionable error and does not mark the step complete

### Requirement: Configuration bucket bootstrap

The bootstrap service SHALL create the versioned configuration bucket when missing, enable versioning, and apply a lifecycle configuration expiring noncurrent object versions after 90 days, so the bucket is usable as the canonical `RemoteFileStore` holding the JSON game-server configuration. The operation MUST be idempotent. Noncurrent-version retention is what the rollback flow depends on.

#### Scenario: Fresh configuration bucket

- **WHEN** the configuration bucket does not exist
- **THEN** the service creates it with versioning enabled and a 90-day noncurrent-version-expiration lifecycle rule

#### Scenario: Configuration bucket already exists

- **WHEN** the configuration bucket already exists in the caller's account
- **THEN** the step succeeds and versioning plus the lifecycle rule are ensured

### Requirement: Buckets block public access

Every bucket the bootstrap service creates SHALL have all four S3 public-access-block settings applied — `BlockPublicAcls`, `IgnorePublicAcls`, `BlockPublicPolicy`, `RestrictPublicBuckets`. This applies to the state backend bucket and the configuration bucket alike. The SDK bootstrap path MUST NOT be weaker than the infrastructure-defined path it replaces, and both buckets hold data an operator would never want publicly reachable: infrastructure state and deployment configuration.

#### Scenario: New bucket blocks public access

- **WHEN** the bootstrap service creates either bucket
- **THEN** all four public-access-block settings are applied before the step reports success

#### Scenario: Existing bucket is hardened too

- **WHEN** the bootstrap service encounters a bucket that already exists
- **THEN** the public-access-block settings are still applied, so a bucket created by an earlier version is brought up to the current standard

### Requirement: IAM permission simulation

After credentials are wired, the wizard SHALL run a best-effort dry-run via `iam:SimulatePrincipalPolicy` against the calling identity (resolved via `sts:GetCallerIdentity`) for the action set of the `HyveonDeployAll` policy, whose single source of truth is the policy JSON in `docs/docs/setup.md`. Simulation requests MUST be batched to stay within API limits and minimize false positives. Missing actions SHALL be surfaced in the wizard as a "Required IAM JSON" panel containing copy-paste-able policy JSON covering the denied actions. The wizard MUST NEVER attempt to grant permissions itself, and simulation failure (e.g. the caller lacks `iam:SimulatePrincipalPolicy` itself) MUST degrade to a warning with the full checklist shown — it does not block wizard progression.

#### Scenario: All actions allowed

- **WHEN** the simulation reports every `HyveonDeployAll` action as allowed
- **THEN** the wizard shows the IAM check as passed with no JSON panel

#### Scenario: Missing actions surfaced as pasteable JSON

- **WHEN** the simulation reports one or more actions as denied
- **THEN** the wizard renders a "Required IAM JSON" panel whose policy JSON the operator can paste into the AWS console, and no auto-grant is attempted

#### Scenario: Simulation itself is not permitted

- **WHEN** the `SimulatePrincipalPolicy` call fails with an access error
- **THEN** the wizard shows a non-blocking warning with the full permission checklist instead of a hard failure

### Requirement: Bootstrap IPC and progress reporting

Each bootstrap operation (state bucket, configuration bucket, IAM check) SHALL be invocable from the renderer through IPC-only controller message patterns under a `wizard.bootstrap.*` namespace, mirrored in the typed preload API, reporting per-resource status (`pending` / `creating` / `exists` / `created` / `failed` with an error message) so the wizard step can render granular progress.

#### Scenario: Renderer runs the bootstrap step

- **WHEN** the renderer invokes the bootstrap IPC methods for the two buckets and the IAM check
- **THEN** each resolves with a per-resource status the step renders, and a failure in one resource reports `failed` with its error message without masking the others
