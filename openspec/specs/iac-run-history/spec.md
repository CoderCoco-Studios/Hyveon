# iac-run-history

## Purpose

Defines the IaC run-history capability: a paginated, status-filterable run-listing API spanning the store, service, IPC, and preload layers; a `/iac/history` route rendering that data with kind/status filters; and a read-only run-detail view that resolves each run's log from the best available source (live replay, inline text, or a presigned S3 URL).

## Requirements

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

### Requirement: Run history route

The web app SHALL provide a `/iac/history` route rendering a table of past runs backed by `hyveon.iac.runs.list`. Each row MUST show at least the run's kind, status, started/completed timestamps, and — when present — the approver and the `rolledBackFrom` tag. The table MUST support loading older pages via the listing API's cursor.

#### Scenario: History table renders recent runs

- **WHEN** the operator opens `/iac/history`
- **THEN** the most recent runs are listed newest-first with kind, status, and timestamps visible for each row

#### Scenario: Loading older runs

- **WHEN** the operator requests more history and a `nextBefore` cursor was returned
- **THEN** the next, older page of runs is fetched and appended to the table

### Requirement: History filters

The history view SHALL let the operator filter the listed runs by run kind (`plan` / `apply` / `destroy`) and by status.

#### Scenario: Filter by kind

- **WHEN** the operator filters the history to `apply` runs
- **THEN** only apply runs are shown in the table

#### Scenario: Filter by status

- **WHEN** the operator filters the history to `failed` runs
- **THEN** only failed runs are shown in the table

### Requirement: Read-only run detail from history

Clicking a history row SHALL open a read-only run-detail view built from the same components as the live Plan/Apply run view, showing the run's status (via `hyveon.iac.runs.get`) and its captured log. The log MUST resolve from the best available source: replayed via `hyveon.iac.runs.streamLogs` when the local run artifacts exist, otherwise from the persisted record's `logInline` text, otherwise fetched via a presigned URL resolved server-side from the record's `logS3Key` (`RunRecordService.getLogUrl`, exposed over IPC). Approve/apply controls MUST NOT be offered from this read-only view for terminal runs.

#### Scenario: Detail replays a locally available log

- **WHEN** the operator opens a run whose local `<runsDir>/<runId>` log still exists
- **THEN** the detail view replays the persisted output through the same ANSI log viewer used by the live page

#### Scenario: Detail falls back to the offloaded S3 log

- **WHEN** the operator opens a run whose local artifacts are gone and whose record carries `logS3Key`
- **THEN** the detail view fetches the log via a presigned URL resolved in the main process and renders it read-only

#### Scenario: Terminal run offers no mutation controls

- **WHEN** the operator opens a run whose status is `success`, `failed`, or `aborted`
- **THEN** no Approve or Apply buttons are rendered in the detail view

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
