## MODIFIED Requirements

### Requirement: Run listing API

The system SHALL provide a run-listing API spanning every layer: a `listRuns` method on the `RunRecordStore` contract (`@hyveon/shared/cloud.ts`) implemented by `AwsRunRecordStore` as a DynamoDB query, a `RunRecordService.listRuns` service method, an `iac.runs.list` IPC channel on `IacRunsController`, and a `hyveon.iac.runs.list` preload bridge with a typed mirror in `hyveon-api.ts`. Results MUST be returned newest-first as the `RunPageResult` page shape already defined in `@hyveon/shared/runs.ts` (records plus an optional `nextBefore` cursor), and the API MUST support a page-size limit, cursor-based continuation, and optional filtering by run status (served by the runs table's `status-index` GSI on status + `startedAt`). The runs table name SHALL be resolved from the infrastructure stack's outputs.

#### Scenario: First page of runs, newest first

- **WHEN** a caller invokes `hyveon.iac.runs.list({ limit: 20 })`
- **THEN** it resolves a `RunPageResult` whose records are the 20 most recent runs ordered newest-first, with `nextBefore` set when older runs exist

#### Scenario: Cursor fetches the next page

- **WHEN** a caller passes the previous page's `nextBefore` value as the `before` cursor
- **THEN** the resolved page contains only runs older than that cursor, still newest-first

#### Scenario: Status-filtered listing uses the GSI

- **WHEN** a caller lists runs filtered to a single status (e.g. `failed`)
- **THEN** only runs with that status are returned, newest-first, without scanning the whole table

#### Scenario: Runs table not configured

- **WHEN** the runs table name is not present in the stack outputs, including when the stack has never been deployed
- **THEN** `listRuns` resolves an empty page rather than throwing, matching `getByRunId`'s existing not-configured behavior

## ADDED Requirements

### Requirement: Structured change summary on run records

Persisted run records SHALL carry the structured change summary the engine reports for the run (counts by operation type), rather than counts recovered by pattern-matching the run's human-readable output. The summary field SHALL be optional on the `RunRecord` type so records written before this change, and runs that fail before producing a summary, remain readable. The history table and the read-only run-detail view SHALL render the summary when present and omit it when absent, without erroring.

#### Scenario: Completed run persists its summary

- **WHEN** a plan or apply run completes and the engine reports a change summary
- **THEN** the persisted run record carries that summary and the history view renders its counts

#### Scenario: Run with no summary renders cleanly

- **WHEN** a run record has no change summary, because it failed early or predates this change
- **THEN** the history table and run-detail view render the row without a summary and without throwing

#### Scenario: Summary is not derived from log text

- **WHEN** a run's output wording differs from what earlier engine versions produced
- **THEN** the persisted summary is unaffected, because it is taken from structured engine data rather than parsed from the log
