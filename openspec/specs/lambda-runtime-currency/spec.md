# lambda-runtime-currency Specification

## Purpose
Keeps every Lambda function on a supported AWS Node.js runtime, with the
esbuild bundle target and the runtime-provided AWS SDK version tracked as
dependencies of that runtime choice rather than changed independently.

## Requirements
### Requirement: Lambdas run a supported AWS runtime
Every Lambda function declared by `app/packages/infra` SHALL use a `runtime` that appears in AWS's *Supported runtimes* table at the time of the change. A runtime listed under *Deprecated runtimes* SHALL NOT be introduced, and an existing runtime SHALL be moved off before AWS's "block function update" date for that runtime, after which code can no longer be deployed to it.

#### Scenario: Runtime is declared in the infra program
- **WHEN** `LAMBDA_RUNTIME` in `app/packages/infra/src/lambdas.ts` is inspected
- **THEN** its value is `nodejs24.x`
- **AND** no Lambda resource declares `nodejs20.x` or any other deprecated identifier

#### Scenario: Deployed functions are inspected after apply
- **WHEN** the five functions (`interactions`, `followup`, `update-dns`, `watchdog`, `efs-seeder`) are described in AWS after the Pulumi stack is applied
- **THEN** each reports the supported runtime, and each still returns a successful invocation

### Requirement: Bundle target matches the executing runtime
The esbuild `target` used to produce each Lambda bundle SHALL name the same Node major as the `runtime` that executes it. The two SHALL be changed together in a single change, because a bundle emitted for a newer target can use syntax an older runtime cannot parse, and a bundle emitted for an older target silently forgoes the runtime's capabilities.

#### Scenario: A Lambda's build config is inspected
- **WHEN** any `app/packages/lambda/*/esbuild.config.mjs` is read
- **THEN** its `target` names the same Node major as `LAMBDA_RUNTIME` in `app/packages/infra/src/lambdas.ts`

#### Scenario: Either side is changed alone
- **WHEN** a change modifies only the infra program's `LAMBDA_RUNTIME` or only an esbuild `target`
- **THEN** it is incomplete and MUST NOT be merged until the other side moves with it

### Requirement: Runtime-provided SDK is treated as a dependency
Lambda bundles that mark the AWS SDK as `external` SHALL be understood to execute against the SDK version shipped inside the Lambda runtime image. A runtime change therefore also changes that SDK version, and the change SHALL verify the affected Lambdas against their real AWS calls rather than assuming the bundle pins the SDK.

#### Scenario: Runtime version changes
- **WHEN** the Lambda runtime is moved to a different Node major
- **THEN** each Lambda's AWS SDK calls (ECS `RunTask`/`StopTask`/`DescribeTasks`, Route 53 `ChangeResourceRecordSets`, DynamoDB reads and writes, Secrets Manager reads, CloudWatch `GetMetricStatistics`, ECS tag reads and writes) are exercised against the deployed functions before the change is considered complete
