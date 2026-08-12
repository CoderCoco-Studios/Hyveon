# aws-cloud-health Specification

## Purpose
TBD - created by archiving change aws-cloud-health-checks. Update Purpose after archive.
## Requirements
### Requirement: Cloud Health checklist on Settings

The Settings page SHALL render an always-visible "Cloud Health" section
listing one row per registered `CloudHealthCheck`. Each row MUST display the
check's label and a status badge reflecting the most recent check result
(`ok`, `missing`, or `error`). The check list SHALL run once when the
Settings page mounts and SHALL provide a manual "Refresh" control that
re-runs every check on demand. The section MUST NOT poll automatically.

#### Scenario: Settings page mount runs all checks

- **WHEN** the operator navigates to the Settings page
- **THEN** the app invokes `cloudHealth.list` and renders one row per
  returned check with its current status badge

#### Scenario: Manual refresh re-runs checks

- **WHEN** the operator clicks the Refresh control
- **THEN** the app re-invokes `cloudHealth.list` and updates every row's
  status badge, without any automatic polling occurring between clicks

#### Scenario: Healthy check shows no Fix action

- **WHEN** a check's result status is `ok`
- **THEN** its row shows a green/positive badge and no Fix button

### Requirement: ECS service-linked role check

The app SHALL provide a `CloudHealthCheck` (id `ecs-service-linked-role`)
whose `check()` calls `iam:GetRole` for `AWSServiceRoleForECS` and reports
`missing` when the role does not exist (`NoSuchEntityException`), `ok` when
it does, and `error` for any other failure. This check MUST be included in
the app's registered `CLOUD_HEALTH_CHECKS` list without requiring any
Settings-page code change to add future checks to the same list.

#### Scenario: Service-linked role exists

- **WHEN** `iam:GetRole('AWSServiceRoleForECS')` succeeds
- **THEN** the check reports `ok`

#### Scenario: Service-linked role missing

- **WHEN** `iam:GetRole('AWSServiceRoleForECS')` fails with
  `NoSuchEntityException`
- **THEN** the check reports `missing` with a human-readable message

#### Scenario: Unexpected AWS error during check

- **WHEN** `iam:GetRole` fails with any error other than
  `NoSuchEntityException`
- **THEN** the check reports `error`, the underlying error is logged via
  `logger.warn`, and no raw SDK exception crosses the IPC boundary

### Requirement: Fix action with graceful degradation to policy instructions

Each broken (`missing` or `error`) row SHALL show a Fix action. For the ECS
service-linked-role check, clicking Fix SHALL invoke
`iam:CreateServiceLinkedRole` for `ecs.amazonaws.com` using the operator's
already-stored credentials. A successful creation, or an
`InvalidInputException` indicating the role already exists, MUST be treated
as a fixed outcome and re-run that row's check. An `AccessDeniedException`
MUST be treated as a `needsPolicyUpdate` outcome: the row MUST expand to
show the current `HyveonDeployAll` policy JSON (the same copyable-block
presentation already used by the wizard's IAM permission check) along with
an explanation that the operator's deploy policy needs updating via their
CloudFormation stack. Any other failure MUST be treated as `failed`, shown
inline with the error message, and MUST leave the Fix action available to
retry. The app MUST NEVER attempt to edit the operator's CloudFormation
stack or IAM policy itself.

#### Scenario: Fix succeeds directly

- **WHEN** the operator clicks Fix and `iam:CreateServiceLinkedRole`
  succeeds
- **THEN** the row's check re-runs and shows `ok`

#### Scenario: Fix finds the role already exists

- **WHEN** the operator clicks Fix and `iam:CreateServiceLinkedRole` fails
  with an "already exists" `InvalidInputException`
- **THEN** the outcome is treated as fixed and the row's check re-runs and
  shows `ok`

#### Scenario: Fix is denied by an outdated deploy policy

- **WHEN** the operator clicks Fix and `iam:CreateServiceLinkedRole` fails
  with `AccessDeniedException`
- **THEN** the row expands to show the current `HyveonDeployAll` policy JSON
  and an explanation to update the CloudFormation stack, and no automatic
  policy or stack change is attempted

#### Scenario: Fix fails for an unexpected reason

- **WHEN** the operator clicks Fix and the underlying call fails with an
  error other than "already exists" or `AccessDeniedException`
- **THEN** the row shows the failure message inline and the Fix action
  remains available to retry

