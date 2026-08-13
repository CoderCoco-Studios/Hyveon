## MODIFIED Requirements

### Requirement: Automation API workspace seam

All infrastructure operations SHALL go through a single main-process seam that constructs the Pulumi workspace and stack, rather than each caller building its own. The seam MUST configure the self-managed state backend, the secrets provider, and the AWS credentials for every operation, and MUST NOT require a Pulumi Cloud account or access token. The state backend SHALL be the operator's own S3 bucket, provisioned by the existing bootstrap flow.

The workspace directory SHALL be a single stable location per stack under `userData`, reused across operations rather than created per operation. Creating one per operation would reproduce, in a new location, the unbounded temporary-directory growth that motivated setting an explicit path in the first place.

The secrets passphrase MUST be present in the engine environment before the first stack is created and for every operation thereafter. On a self-managed backend the engine has no interactive fallback under the non-interactive mode the automation interface always uses — a missing passphrase is a hard failure at stack creation, not a prompt — and there is no option to run without a secrets provider. The seam MUST derive the passphrase deterministically from the AWS account ID (via STS `GetCallerIdentity`) and the stack name, using a fixed app-level derivation constant, rather than generating and persisting a random per-machine value. The derived passphrase MUST NOT be stored; it SHALL be recomputed on every invocation. This makes the passphrase reproducible on any machine holding valid credentials for the same AWS account, so a second or replacement machine can operate against an existing stack without any locally-stored passphrase record. The passphrase MUST NOT be treated as a confidentiality boundary — the infrastructure program does not mark any Pulumi stack config or output as secret, so the passphrase gates access to non-sensitive state only, not encryption of real secrets.

For an install that still holds a legacy random passphrase in its OS-level encrypted store from before this behavior existed, the seam MUST perform a one-time, automatic migration the next time the workspace is constructed: read the legacy passphrase, re-encrypt the stack's secrets provider to the newly-derived passphrase, and remove the legacy passphrase from the encrypted store only after the re-encryption succeeds. This migration MUST require no user action and MUST be safely retryable — if re-encryption fails, the legacy passphrase MUST remain in place so the next launch retries with the same still-valid value.

Because the passphrase is no longer stored, the seam MUST record a separate, non-secret local marker — set after a stack has been successfully created or selected at least once on this install — for any caller that needs to distinguish "this install has never interacted with a stack" from "this install has, but is not currently holding a decrypted passphrase in memory." This marker MUST NOT be used as, or treated as equivalent to, a passphrase or any other secret value.

#### Scenario: Operations use the self-managed backend

- **WHEN** any infrastructure operation runs
- **THEN** it reads and writes state in the operator's own S3 bucket and no Pulumi Cloud login or access token is required

#### Scenario: Backend is not yet bootstrapped

- **WHEN** an infrastructure operation is attempted before the state bucket exists
- **THEN** the seam surfaces an actionable error directing the operator to the bootstrap step rather than creating the bucket implicitly

#### Scenario: Workspace is reused, not accumulated

- **WHEN** many operations run against the same stack over the app's lifetime
- **THEN** they share one stable workspace directory under `userData` rather than creating a new one per operation, and the number of workspace directories does not grow with the number of operations

#### Scenario: Passphrase is present before stack creation

- **WHEN** the stack is created for the first time
- **THEN** the passphrase is derived from the AWS account ID and stack name and supplied in the engine environment, so creation does not fail on a missing secrets provider, and no passphrase is written to local storage

#### Scenario: A second machine operates on an existing stack

- **WHEN** an infrastructure operation runs on a machine with valid credentials for the same AWS account as an existing stack, and that machine has no locally stored passphrase for the stack
- **THEN** the seam derives the same passphrase the stack was created with and completes the operation, without generating a new passphrase and without failing due to a missing local record

#### Scenario: A legacy per-machine passphrase is migrated automatically

- **WHEN** the workspace is constructed on an install whose encrypted store still holds a legacy randomly-generated passphrase for the stack
- **THEN** the seam re-encrypts the stack's secrets provider to the newly-derived passphrase, removes the legacy passphrase from the encrypted store, and completes the operation, with no user-facing action required

#### Scenario: Local initialization marker is set after a successful stack operation

- **WHEN** the seam successfully creates or selects the stack
- **THEN** it records a non-secret local marker that this install has interacted with a stack at least once, without writing the passphrase itself anywhere

#### Scenario: Local initialization marker is not set on failure

- **WHEN** stack creation or selection fails
- **THEN** the local initialization marker is not set (or, if already set from a prior success, is left unchanged)

#### Scenario: Legacy migration is retried after a failed re-encryption

- **WHEN** the one-time migration's re-encryption step fails partway (e.g. a network interruption)
- **THEN** the legacy passphrase is left in place in the encrypted store, and the next workspace construction attempts the migration again using that same legacy passphrase
