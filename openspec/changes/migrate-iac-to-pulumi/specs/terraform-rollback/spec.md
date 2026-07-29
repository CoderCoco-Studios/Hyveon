## MODIFIED Requirements

### Requirement: Rollback initiation from history

The history view SHALL offer a "Rollback" action on apply runs that recorded the version identifier of the configuration object they ran against. Initiating a rollback MUST resolve the configuration version that was live before that run (using the complete version listing) and present it to the operator for confirmation before anything is written. The confirmation MUST identify the target version, and SHOULD summarize how the target configuration differs from the current one so the operator is not confirming an opaque version id.

#### Scenario: Operator starts a rollback

- **WHEN** the operator clicks "Rollback" on an apply run in history
- **THEN** the app resolves the prior configuration version and shows a confirmation identifying the target version before proceeding

#### Scenario: Runs without a configuration version offer no rollback

- **WHEN** a history row is a run with no recorded configuration version id (or not an apply run)
- **THEN** no Rollback action is offered for that row

### Requirement: Rollback restores the version and queues a tagged plan

Confirming a rollback SHALL restore the selected historic configuration version's content as the new head of the configuration object (a new S3 version — history is never rewritten) and then start a plan against that restored version. The resulting plan run's record MUST carry `rolledBackFrom: <applyRunId>` (an optional `RunRecord` field in `@hyveon/shared/runs.ts`, plumbed through run-record persistence), and the history view MUST display the tag on rollback runs. Because the configuration is stored as JSON, restoration MUST be a byte-for-byte rewrite of the historic object content, with no parse-and-re-emit step that could alter it.

#### Scenario: Rollback plan is tagged

- **WHEN** the operator confirms a rollback of apply run `R`
- **THEN** the historic configuration content is written as the new head version and a plan run starts whose persisted record has `rolledBackFrom: R`, visible as a tag in the history view

#### Scenario: Restored content is byte-identical

- **WHEN** a historic configuration version is restored as the new head
- **THEN** the new head's content is byte-for-byte identical to the historic version

### Requirement: Missing historic version is a clear error

If the historic configuration version no longer exists (e.g. removed by S3 lifecycle expiry after the 90-day noncurrent-version window), the rollback SHALL fail before any write occurs, surfacing an error that names the missing version, and MUST leave the current configuration head untouched.

#### Scenario: Historic version expired

- **WHEN** the operator confirms a rollback whose target version id no longer exists in S3
- **THEN** the app surfaces an error identifying the missing version, no new configuration head is written, and no plan run is started
