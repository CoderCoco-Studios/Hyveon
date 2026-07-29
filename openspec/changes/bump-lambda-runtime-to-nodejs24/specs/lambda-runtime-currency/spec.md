## ADDED Requirements

### Requirement: Lambdas run a supported AWS runtime
Every Lambda function provisioned by this project SHALL declare a `runtime` that appears in AWS's *Supported runtimes* table at the time of the change. A runtime listed under *Deprecated runtimes* SHALL NOT be introduced, and an existing runtime SHALL be moved off before AWS's "block function update" date for that runtime, after which code can no longer be deployed to it.

#### Scenario: Runtime is declared in Terraform
- **WHEN** any `aws_lambda_function` resource in `terraform/aws/` is inspected
- **THEN** its `runtime` is `nodejs24.x`
- **AND** no Lambda declares `nodejs20.x` or any other deprecated identifier

#### Scenario: Deployed functions are inspected after apply
- **WHEN** the five functions (`interactions`, `followup`, `update-dns`, `watchdog`, `efs-seeder`) are described in AWS after `terraform apply`
- **THEN** each reports the supported runtime, and each still returns a successful invocation

### Requirement: Bundle target matches the executing runtime
The esbuild `target` used to produce each Lambda bundle SHALL name the same Node major as the `runtime` that executes it. The two SHALL be changed together in a single change, because a bundle emitted for a newer target can use syntax an older runtime cannot parse, and a bundle emitted for an older target silently forgoes the runtime's capabilities.

#### Scenario: A Lambda's build config is inspected
- **WHEN** any `app/packages/lambda/*/esbuild.config.mjs` is read
- **THEN** its `target` names the same Node major as the `runtime` declared for that function in `terraform/aws/`

#### Scenario: Either side is changed alone
- **WHEN** a change modifies only the Terraform `runtime` or only the esbuild `target`
- **THEN** it is incomplete and MUST NOT be merged until the other side moves with it

### Requirement: Provider constraint can express the chosen runtime
The Terraform AWS provider constraint SHALL permit a provider version that accepts the declared runtime identifier. Because the provider validates `runtime` against a fixed list compiled into it, a runtime released after the pinned provider major is rejected at `terraform validate`, before any AWS call is made.

#### Scenario: Configuration is validated
- **WHEN** `terraform init -backend=false && terraform validate` runs against `terraform/`
- **THEN** validation succeeds with the declared runtime and the declared provider constraint

#### Scenario: A future runtime postdates the pinned provider
- **WHEN** a newer runtime identifier is rejected by the currently pinned provider major
- **THEN** raising the provider constraint is treated as part of that runtime change, and the resulting `terraform plan` is reviewed for unrelated resource diffs introduced by the provider upgrade

### Requirement: Runtime-provided SDK is treated as a dependency
Lambda bundles that mark the AWS SDK as `external` SHALL be understood to execute against the SDK version shipped inside the Lambda runtime image. A runtime change therefore also changes that SDK version, and the change SHALL verify the affected Lambdas against their real AWS calls rather than assuming the bundle pins the SDK.

#### Scenario: Runtime version changes
- **WHEN** the Lambda runtime is moved to a different Node major
- **THEN** each Lambda's AWS SDK calls (ECS `RunTask`/`StopTask`/`DescribeTasks`, Route 53 `ChangeResourceRecordSets`, DynamoDB reads and writes, Secrets Manager reads, CloudWatch `GetMetricStatistics`, ECS tag reads and writes) are exercised against the deployed functions before the change is considered complete
