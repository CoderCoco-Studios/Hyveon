## MODIFIED Requirements

### Requirement: Lambdas run a supported AWS runtime
Every Lambda function declared by `app/packages/infra` SHALL use a `runtime` that appears in AWS's *Supported runtimes* table at the time of the change. A runtime listed under *Deprecated runtimes* SHALL NOT be introduced, and an existing runtime SHALL be moved off before AWS's "block function update" date for that runtime, after which code can no longer be deployed to it.

This applies to conditionally provisioned functions on the same terms as always-provisioned ones. A function that exists only for deployments meeting some condition is still a function the infra program declares, and a deployment that meets the condition SHALL NOT end up running a deprecated runtime because the function was overlooked while enumerating the set.

#### Scenario: Runtime is declared in the infra program

- **WHEN** `LAMBDA_RUNTIME` in `app/packages/infra/src/lambdas.ts` is inspected
- **THEN** its value is `nodejs24.x`
- **AND** no Lambda resource declares `nodejs20.x` or any other deprecated identifier

#### Scenario: Deployed functions are inspected after apply

- **WHEN** the deployed functions are described in AWS after the Pulumi stack is applied
- **THEN** the always-provisioned functions (`interactions`, `followup`, `update-dns`, `watchdog`, `efs-seeder`) each report the supported runtime and each still returns a successful invocation
- **AND** the health-check function, where the deployment's configuration causes it to exist, does the same
