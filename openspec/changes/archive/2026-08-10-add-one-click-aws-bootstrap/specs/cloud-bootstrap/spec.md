## ADDED Requirements

### Requirement: Default encryption on the configuration bucket

The configuration bucket `BootstrapService.ensureConfigurationBucket()` creates SHALL have AES256 default server-side encryption applied (`PutBucketEncryption`), matching what `ensureStateBucket()` already applies to the state bucket. The call MUST be idempotent, applying on the `exists` path as well as the `created` path so a bucket provisioned before this requirement is brought into line. Failure to apply encryption MUST surface as a bootstrap failure rather than being silently ignored.

Public-access-block hardening is **not** part of this requirement — re-verified against the current `BootstrapService.ts`: both `ensureStateBucket()` and `ensureConfigurationBucket()` already call a shared `ensurePublicAccessBlock()` helper unconditionally (all four settings, on both the `created` and `exists` paths), so that hardening already exists for both buckets as a side effect of unrelated `migrate-iac-to-pulumi` work. Encryption is the one asymmetry that remains.

#### Scenario: New configuration bucket is encrypted

- **WHEN** `ensureConfigurationBucket()` creates a new bucket
- **THEN** AES256 default server-side encryption is enabled on it, matching what `ensureStateBucket()` already does for the state bucket

#### Scenario: Pre-existing configuration bucket brought into line

- **WHEN** bootstrap runs against a configuration bucket that already exists without default encryption
- **THEN** encryption is applied and the operation still reports `exists` rather than `created`

#### Scenario: Encryption application fails

- **WHEN** the `PutBucketEncryption` call is denied or errors
- **THEN** the bootstrap operation reports `failed` with the underlying error rather than reporting success

## MODIFIED Requirements

### Requirement: IAM permission simulation

After credentials are wired, the wizard SHALL run a dry-run via `iam:SimulatePrincipalPolicy` against the calling identity (resolved via `sts:GetCallerIdentity`) for the action set of the `HyveonDeployAll` policy, whose single source of truth is `HYVEON_DEPLOY_ALL_ACTIONS` in `@hyveon/shared`, mirrored in the policy JSON in `docs/docs/setup.md`. Simulation requests MUST be batched to stay within API limits and minimize false positives. Missing actions SHALL be surfaced in the wizard as a "Required IAM JSON" panel containing copy-paste-able policy JSON covering the denied actions. The wizard MUST NEVER attempt to grant permissions itself.

Re-verified against the current `IamCheckService.ts`: the check is purely advisory on every path today (no notion of credential-source origin exists yet), matching `docs/docs/setup.md`'s own description of it as "never blocks you from continuing" — the gating split below is still entirely greenfield, not partially built.

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
