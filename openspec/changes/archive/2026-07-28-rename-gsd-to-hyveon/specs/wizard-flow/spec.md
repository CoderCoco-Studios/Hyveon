## MODIFIED Requirements

### Requirement: Terraform init step with live log

The final configuration step SHALL invoke `TerraformService.init({ backendConfig: { bucket, region, dynamodbTable } })` using the bootstrapped backend resources, streaming stdout/stderr live into a wizard log pane via the existing `terraform.init` streaming IPC channel (`hyveon.terraform.init` async iterable). ANSI colors in the output MUST render correctly. The completion control SHALL enable only when the run exits with code 0; a non-zero exit SHALL surface an error state with the captured log and allow retry.

#### Scenario: Successful init

- **WHEN** `terraform init` streams output and exits 0
- **THEN** the log pane shows the live output with ANSI colors rendered and the completion button becomes enabled

#### Scenario: Failed init

- **WHEN** `terraform init` exits non-zero
- **THEN** the step shows an error UI with the log, keeps the completion button disabled, and offers a retry
