## ADDED Requirements

### Requirement: Public access block on bootstrap-created buckets

Every S3 bucket `BootstrapService` creates — the Terraform state bucket and the tfvars bucket — SHALL have a public access block applied with all four settings enabled (`BlockPublicAcls`, `BlockPublicPolicy`, `IgnorePublicAcls`, `RestrictPublicBuckets`), matching what `terraform/bootstrap/main.tf` applies to the tfvars bucket it creates. The call MUST be idempotent, applying on the `exists` path as well as the `created` path so buckets provisioned before this requirement are brought into line. Failure to apply the block MUST surface as a bootstrap failure rather than being silently ignored.

#### Scenario: New state bucket is blocked from public access

- **WHEN** `ensureStateBucket()` creates a new bucket
- **THEN** all four public access block settings are enabled on it

#### Scenario: New tfvars bucket is blocked from public access

- **WHEN** `ensureTfvarsBucket()` creates a new bucket
- **THEN** all four public access block settings are enabled on it, matching the Terraform fallback module

#### Scenario: Pre-existing bucket brought into line

- **WHEN** bootstrap runs against a bucket that already exists without a public access block
- **THEN** the block is applied and the operation still reports `exists` rather than `created`

#### Scenario: Block application fails

- **WHEN** the `PutPublicAccessBlock` call is denied or errors
- **THEN** the bootstrap operation reports `failed` with the underlying error rather than reporting success

## MODIFIED Requirements

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
