# iac-rollback

## Purpose

Defines rollback of an apply: complete (paginated) S3 version history so the correct prior configuration version can be found, a "Rollback" action in run history that resolves and confirms the target version, restoring that version as a new S3 head and queuing a plan tagged `rolledBackFrom`, routing that plan through the standard approve/apply gates, and failing clearly if the historic version no longer exists.

## Requirements

### Requirement: Complete remote file version listing

`AwsRemoteFileStore.listVersions()` SHALL return the complete version history for a key by paginating `ListObjectVersionsCommand`: while a response reports `IsTruncated: true`, the next request MUST pass the response's `NextKeyMarker`/`NextVersionIdMarker` as `KeyMarker`/`VersionIdMarker`, accumulating every page's `Versions` entries before the existing key-match filtering and newest-first sorting are applied. (Fixes issue #260 — rollback depends on complete version listing.)

#### Scenario: Key with more than one page of versions

- **WHEN** `listVersions` is called for a key whose versions span multiple S3 pages (first response `IsTruncated: true` with continuation markers, final response `IsTruncated: false`)
- **THEN** the returned array contains the versions from every page, filtered to the exact key and sorted newest-`lastModified`-first

#### Scenario: Single-page listing is unchanged

- **WHEN** `listVersions` is called for a key whose versions fit in one response (`IsTruncated` false or absent)
- **THEN** exactly one request is issued and the existing filtering/sorting behavior is preserved

### Requirement: Rollback initiation from history

The history view SHALL offer a "Rollback" action on apply runs that recorded the version identifier of the configuration object they ran against. Initiating a rollback MUST resolve the configuration version that was live before that run (using the complete version listing) and present it to the operator for confirmation before anything is written. The confirmation MUST identify the target version, and SHOULD summarize how the target configuration differs from the current one so the operator is not confirming an opaque version id.

#### Scenario: Operator starts a rollback

- **WHEN** the operator clicks "Rollback" on an apply run in history
- **THEN** the app resolves the prior configuration version and shows a confirmation identifying the target version before proceeding

#### Scenario: Runs without a configuration version offer no rollback

- **WHEN** a history row is a run with no recorded configuration version id (or not an apply run)
- **THEN** no Rollback action is offered for that row

### Requirement: Rollback restores the version and queues a tagged plan

Confirming a rollback SHALL restore the selected historic configuration version's content as the new head of the configuration object (a new S3 version — history is never rewritten) and then start a plan against that restored version.

The restore and the plan's creation SHALL be performed as one guarded unit. The shared operation lock MUST be acquired **before** the restore is written and held until the plan run's record is persisted, so no other operation can interleave between the two. If plan creation nevertheless fails — engine provisioning, network, or persistence — the rollback MUST NOT leave the restored configuration as the head with no plan attached: it either restores the previous head or records the orphaned restore explicitly and surfaces it to the operator. Silently leaving a changed head that no plan describes is the failure mode this exists to prevent, because the next apply would then deploy a configuration nobody reviewed. The resulting plan run's record MUST carry `rolledBackFrom: <applyRunId>` (an optional `RunRecord` field in `@hyveon/shared/runs.ts`, plumbed through run-record persistence), and the history view MUST display the tag on rollback runs. Because the configuration is stored as JSON, restoration MUST be a byte-for-byte rewrite of the historic object content, with no parse-and-re-emit step that could alter it.

#### Scenario: Rollback plan is tagged

- **WHEN** the operator confirms a rollback of apply run `R`
- **THEN** the historic configuration content is written as the new head version and a plan run starts whose persisted record has `rolledBackFrom: R`, visible as a tag in the history view

#### Scenario: Plan creation fails after the restore

- **WHEN** the historic content has been restored as the new head and the plan run then fails to start or persist
- **THEN** the rollback does not leave a restored head with no plan describing it — either the previous head is restored or the orphaned restore is recorded and surfaced to the operator

#### Scenario: No operation interleaves with a rollback

- **WHEN** another plan, apply, or destroy is requested between a rollback's restore and its plan-record persistence
- **THEN** it is refused as busy, because the rollback holds the shared operation lock across both steps

#### Scenario: Restored content is byte-identical

- **WHEN** a historic configuration version is restored as the new head
- **THEN** the new head's content is byte-for-byte identical to the historic version

### Requirement: Rollback goes through the standard approve and apply gates

A rollback plan SHALL be approved and applied through exactly the same flow as any other plan — explicit approval, the 15-minute approval window, the plan-hash gate, workspace/apply-lock checks. Rollback MUST NOT bypass or weaken any gate.

#### Scenario: Rollback apply requires approval

- **WHEN** a rollback plan completes successfully
- **THEN** its status is `awaiting_approval` and the apply remains blocked until the operator approves it, identically to a normal plan

### Requirement: Missing historic version is a clear error

If the historic configuration version no longer exists (e.g. removed by S3 lifecycle expiry after the 90-day noncurrent-version window), the rollback SHALL fail before any write occurs, surfacing an error that names the missing version, and MUST leave the current configuration head untouched.

#### Scenario: Historic version expired

- **WHEN** the operator confirms a rollback whose target version id no longer exists in S3
- **THEN** the app surfaces an error identifying the missing version, no new configuration head is written, and no plan run is started
