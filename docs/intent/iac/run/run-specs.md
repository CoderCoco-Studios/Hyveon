# IaC Run Lifecycle Specs

EARS requirements for prefix `IAC-RUN`, the run-lifecycle leaf described in `docs/intent/iac/run/run-design.md`.

## Run record and status

- [x] **IAC-RUN-REC-001**: The system shall record every Pulumi preview as a run of kind `plan`, every `up` as kind `apply`, and every destroy as kind `destroy`, with no other `RunKind` values. (observed: `shared/src/runs.ts:3-14`)
- [x] **IAC-RUN-REC-002**: The system shall derive a run record's `status` from its `exitCode` alone, `0` mapping to `success`, any other number to `failed`, and `null` to `aborted`, and shall never set `status` directly at a call site. (observed: `shared/src/runs.ts:194-210`, `RunRecordService.ts:364`)
- [x] **IAC-RUN-REC-003**: The system shall write a run record to the runs table only once a run has settled, so the runs table holds no `pending` status, with the apply pre-flight marker (see IAC-RUN-PART-002) as the only record written before settlement. (observed: `shared/src/runs.ts:16-24`, `RunRecordService.ts:392-475`)
- [x] **IAC-RUN-REC-004**: When a run record is persisted to the runs table, the system shall key it `pk = RUN`, `sk = <startedAt>#<runId>`, so that a partition query in `sk` order is a newest-first listing. (observed: `shared/src/runs.ts:190-192`, `AwsRunRecordStore.ts:23`, `RunRecordService.ts:361`)
- [x] **IAC-RUN-REC-005**: When a plan, apply or destroy run is persisted, the system shall carry `configVersionId`, `planHash`, `engineVersion`, `rolledBackFrom` and `changeSummary` on the record whenever the settling run supplied them, and omit each field otherwise.
- [x] **IAC-RUN-REC-006**: The system shall treat a run record's `changeSummary` as optional, so records written before the field existed and runs that failed before producing a summary remain readable by history and run detail.
- [x] **IAC-RUN-REC-007**: When a plan or apply run settles, the system shall take the persisted `changeSummary` counts from the engine's structured summary event, never from pattern-matching the run's human-readable log.
- [x] **IAC-RUN-REC-008**: The system shall define the `ChangeSummary` shape exactly once, in `@hyveon/shared`, and the renderer shall read counts from that shape without re-deriving them from the stream.
- [x] **IAC-RUN-REC-009**: The system shall keep `shared/src/runs.ts`, `changeSummary.ts` and `errors.ts` free of AWS SDK imports, with all SDK use for run records confined to `AwsRunRecordStore`. (observed: CLAUDE.md shared-barrel invariant; `shared/src/runs.ts`, `cloud-aws/src/AwsRunRecordStore.ts`)

## Runs table and log storage

- [x] **IAC-RUN-STORE-001**: When resolving the runs table name for persisting, approving, reading or listing run records, `RunRecordService` shall use the stack outputs' `runsTableName` first and fall back to the runs table name in the persisted deployment config, so the first plan/apply cycle on a fresh install can persist records. (observed: `RunRecordService.ts:243-271`)
- [x] **IAC-RUN-STORE-002**: When a settled run's captured log is at or below 350 KiB, `RunRecordService.persist` shall store it inline as `logInline`; when it exceeds 350 KiB, it shall offload it to `runs/<runId>.log` in the configuration bucket and store `logS3Key`, never both. (observed: `RunRecordService.ts:103`, `:328-357`, `AwsRunRecordStore.ts:57-59`)
- [x] **IAC-RUN-STORE-003**: If reading the captured log file, offloading it to S3, or writing the record fails during `RunRecordService.persist`, then the system shall log a warning and swallow the failure so a history write never fails a settled Pulumi run. (observed: `RunRecordService.ts:14-18`, `:330-386`)
- [x] **IAC-RUN-STORE-004**: When `RunRecordService.persist` returns by any path, the system shall release the apply lock held under the persisted `runId`. (observed: `RunRecordService.ts:387-389`)
- [x] **IAC-RUN-STORE-005**: If the runs table name cannot be resolved, then `RunRecordService.persist` shall skip persistence with a warning, `listRuns` shall resolve an empty page, `getByRunId` shall resolve `undefined`, and `approveRun` and `writePreflightMarker` shall throw.
- [x] **IAC-RUN-STORE-006**: When the renderer requests a run log URL over `iac.runs.logUrl`, the system shall return a presigned S3 GET URL for the record's `logS3Key` resolved in the main process, defaulting to a one-hour expiry, so no AWS credential crosses the bridge.
- [x] **IAC-RUN-STORE-007**: When a run record carrying `partialApply` is written to or read from the runs table, `AwsRunRecordStore` shall round-trip the `partialApply` field unchanged. (observed: `AwsRunRecordStore.ts` `putRecord` and `toRunRecord`)
- [ ] **IAC-RUN-STORE-008**: When `RunRecordService.approveRun` writes an approval, the system shall preserve every other field of the stored record, including `partialApply`. (observed; gap: whole-item `PutCommand` at `RunRecordService.ts:640-641` loses any field the store does not round-trip, `AwsRunRecordStore.ts:185-208`)
- [ ] **IAC-RUN-STORE-009**: When a run-record service method in `RunRecordService` or `RunService` logs a caught store, S3 or file-system failure, the system shall log the normalised error message rather than the raw error object. (observed: `.claude/rules/logging.md` rule 2; gap: raw `err` logged at `RunRecordService.ts:336`, `:351`, `:382`, `RunService.ts:241`)

## Apply lock

- [x] **IAC-RUN-LOCK-001**: The system shall hold at most one apply lock at a time, as a `RunLock` carrying `runId`, `kind`, `initiator`, `acquiredAt` and `expiresAt`. (observed: `RunService.ts:160-177`, `shared/src/runs.ts:212-252`)
- [x] **IAC-RUN-LOCK-002**: When `RunService.createRun` is called, the system shall check and set the in-memory lock synchronously before its first `await`, so two calls in the same process are serialised by the event loop without a mutex. (observed: `RunService.ts:160-177`)
- [x] **IAC-RUN-LOCK-003**: When `RunService.createRun` mirrors the lock to the runs table, the system shall write the `LOCK/CURRENT` item with a single conditional put (`attribute_not_exists(pk) OR expiresAt < :now`) whose conflict result decides the outcome.
- [x] **IAC-RUN-LOCK-004**: If the conditional put of the `LOCK/CURRENT` item fails because an unexpired lock exists, then the system shall throw `RunLockHeldError` carrying the current holder and roll back the in-memory lock it had just set. (observed: `AwsRunRecordStore.ts:440-445`, `RunService.ts:181-193`)
- [x] **IAC-RUN-LOCK-005**: The system shall give every apply lock a time-to-live of one hour (`DEFAULT_LOCK_TTL_MS`), evaluated lazily on read, after which the lock is treated as released without any sweeper. (observed: `RunService.ts:32-40`, `shared/src/runs.ts:250-252`)
- [x] **IAC-RUN-LOCK-006**: When `RunService.releaseRun(runId)` is called, the system shall clear the in-memory lock and conditionally delete the `LOCK/CURRENT` item only if each is held by that same `runId`, and shall never throw. (observed: `RunService.ts:225-246`, `AwsRunRecordStore.ts:485-501`)
- [x] **IAC-RUN-LOCK-007**: The system shall acquire the durable apply lock for apply and destroy runs only; plan (preview) and rollback-confirm runs shall be guarded by the in-process workspace guard alone. (observed: `PulumiService.ts:1461`, `:2106`, `:2960`, `:3596`; `docs/docs/app/iac.md:200-201`)
- [x] **IAC-RUN-LOCK-008**: The `LOCK/CURRENT` item shall carry no `status` attribute, so it never appears in the `status-index` GSI or in the `pk = RUN` partition listing. (observed: `AwsRunRecordStore.ts:428-436`)
- [ ] **IAC-RUN-LOCK-009**: When `RunService.createRun`, `releaseRun` or the durable lock lookup run before the first successful apply on a fresh install, the system shall use the same pre-apply runs-table fallback as `RunRecordService`, so the first apply holds the durable lock. (observed; gap: `RunService.ts:179`, `:231`, `:272` consult only `getStackOutputs().runsTableName`)
- [ ] **IAC-RUN-LOCK-010**: While a run holds the durable apply lock across an app restart, `iac.runs.get` shall report that run as `running`. (observed; gap: `iac-runs.controller.ts:219` checks only the in-memory lock)

## Run-lock recovery

- [x] **IAC-RUN-LCLR-001**: When an apply or destroy submission is refused with `RunLockHeldError`, the system shall return the holder in the ack as `runLock` alongside `conflict`, and the busy banner shall offer a "Clear lock and retry" action behind a confirmation dialog.
- [x] **IAC-RUN-LCLR-002**: When a plan, apply or destroy submission is refused because this process's own operation is in flight (`PulumiOperationInFlightError` or the plan busy check), the system shall show the busy banner with no "Clear lock and retry" action.
- [x] **IAC-RUN-LCLR-003**: When the operator confirms "Clear lock and retry", the renderer shall mint a token over `iac.runs.lock.clear.mintToken` bound to the `runId` of the lock it was shown, then pass that token to `iac.runs.lock.clear`.
- [x] **IAC-RUN-LCLR-004**: If a run-lock clear token is minted for a `runId` that is not the currently held lock, then `RunService.mintLockClearConfirmationToken` shall refuse with `RunLockChangedError`.
- [x] **IAC-RUN-LCLR-005**: If a run-lock clear token is missing, older than five minutes, already consumed, superseded by a later mint, or bound to a `runId` other than the currently held lock, then `RunService.clearLock` shall refuse with `RunLockClearNotConfirmedError` and leave the held lock intact.
- [x] **IAC-RUN-LCLR-006**: When a run-lock or Pulumi-lock clear token is asserted, `LockClearConfirmationGate` shall consume it only on a successful assert, keep it on a failed assert, and hold at most one pending token per gate. (observed: `LockClearConfirmationGate.ts:57-110`)
- [x] **IAC-RUN-LCLR-007**: When a run-lock clear succeeds, the renderer shall show a success toast and return to the ready-to-submit state without resubmitting the original operation.
- [x] **IAC-RUN-LCLR-008**: `LockClearConfirmationGate` shall have a co-located unit test covering mint, supersede, expiry, binding and single-use consumption. (observed)
- [x] **IAC-RUN-LCLR-009**: When an apply or destroy is refused because a Pulumi backend lock cannot be proven this installation's own orphan (`PulumiUnrecognizedLockError`), the submission ack shall carry the lock's holder details as `staleLock` so the renderer can offer a confirmed clear. (observed: `iac.controller.ts:268-278`, `:427-438`, `:482-490`)
- [x] **IAC-RUN-LCLR-010**: When the operator confirms clearing an unrecognized Pulumi backend lock, the renderer shall mint a single-use token over `iac.lock.clear.mintToken` and pass it to `iac.lock.clear`, and `PulumiService.clearStaleLock` shall clear the lock only when that token is fresh, unconsumed and bound to the same target, never retrying the operation that hit the conflict. (observed: `iac.controller.ts:953-957`, `:1332-1348`, `PulumiService.ts:3651-3701`)
- [x] **IAC-RUN-LCLR-011**: If `PulumiService.clearStaleLock` is called while a preview, apply, destroy, rollback or stack initialization is in flight in this app instance, then it shall refuse without touching the Pulumi backend lock. (observed: `PulumiService.ts:3701-3706`)
- [x] **IAC-RUN-LCLR-012**: If the Pulumi backend lock clear fails, then `iac.lock.clear` shall resolve `{ cleared: false, error }` with the normalised message, shall not report the lock cleared, and shall not retry the clear or the operation that hit the conflict. (observed: `PulumiService.ts` `PulumiLockClearError`, `iac.controller.ts:1341-1347`)

## Operator cancel

- [D] **IAC-RUN-CANCEL-001**: When the operator cancels an in-flight plan, apply or destroy, the system shall abort that run through the engine's cancellation path and settle its run record as `aborted`. (deferred: no `iac.*.cancel` channel exists; `IacController` keeps per-run maps for one at `iac.controller.ts:525-545`, and an engine call can be aborted today only by closing the window)

## Plan submission and the IaC page

- [x] **IAC-RUN-PLAN-001**: The web app shall provide an `/iac` route rendering the IaC page, reachable from the primary navigation, inside the `PollingProvider` → `GameStatusProvider` → router stack.
- [x] **IAC-RUN-PLAN-002**: When the operator clicks "Plan", the IaC page shall call `hyveon.iac.plan()` and, on a `{ started: true, runId }` ack, show the run view for that `runId` and stream its output.
- [x] **IAC-RUN-PLAN-003**: If `iac.plan` is invoked while a workspace operation is in flight, then the system shall resolve `{ started: false, error, conflict }` naming that operation without starting a preview, and the IaC page shall stay on the trigger view showing the busy banner.
- [x] **IAC-RUN-PLAN-004**: When a plan, apply or destroy run view is shown, the IaC page shall stream the run's output by consuming `hyveon.iac.runs.streamLogs(runId)`, which replays buffered output and then follows it live.
- [x] **IAC-RUN-PLAN-005**: When a run log chunk containing ANSI escape sequences reaches the renderer, the log viewer shall append it in arrival order and render the escapes as styled HTML, with neither the main process nor the preload stripping them.
- [x] **IAC-RUN-PLAN-006**: When the run log stream ends, the IaC page shall stop following, call `iac.runs.get` once, and render the run's terminal status, treating `found: false` as an error.
- [x] **IAC-RUN-PLAN-007**: When a plan run completes successfully, the IaC page shall display its create/update/replace/delete counts from the structured change summary, with the full plan log rendered alongside.
- [x] **IAC-RUN-PLAN-008**: If a run's change summary is absent or empty, then the IaC page, history and run detail shall show "Change summary unavailable" rather than "no changes".
- [x] **IAC-RUN-PLAN-009**: When a new plan, apply or destroy submission starts, `useIacRun` shall reset that operation's `runId`, status, record and banner state before calling the channel, so a stale `partialApply` cannot flash. (observed: `use-iac-run.hook.ts:146-174`)
- [x] **IAC-RUN-PLAN-010**: The game-edit and remove-game flows shall direct the operator to the `/iac` page to plan and apply a change, with no instruction to run a terminal command.

## Approval

- [x] **IAC-RUN-APPR-001**: While a plan run's `RunDetailStatus` is `awaiting_approval`, the IaC page shall offer an enabled "Approve plan" action that calls `hyveon.iac.approve({ planRunId })`.
- [x] **IAC-RUN-APPR-002**: When `iac.approve` is handled, the system shall resolve the approver as the local OS username in the main process and never accept an approver identity from the caller.
- [x] **IAC-RUN-APPR-003**: When `RunRecordService.approveRun` is called, the system shall refuse unless the record exists, is of kind `plan` and has status `success`, and otherwise write `approvedBy` and `approvedAt` onto it. (observed: `RunRecordService.ts:604-651`)
- [x] **IAC-RUN-APPR-004**: Until a plan run has been approved, the IaC page shall not render an enabled "Apply" action, and once approved it shall show who approved and when, with the approval's expiry time.
- [x] **IAC-RUN-APPR-005**: The system shall treat an approval as valid for 15 minutes (`APPROVAL_WINDOW_MS`), and the IaC page shall show "approval expired, re-approve to apply" with a "Re-approve" action once the window has passed.
- [ ] **IAC-RUN-APPR-006**: The IaC page shall import `APPROVAL_WINDOW_MS` and `isApprovalExpired` from `@hyveon/shared` rather than keeping a renderer-local copy. (observed: duplication rule; gap: local copy at `iac.page.tsx:41-53` while the same file imports `errMessage` from `@hyveon/shared` at `:6`)
- [x] **IAC-RUN-APPR-007**: When a plan run is approved, the system shall record an `approve` audit entry. (observed: `iac.controller.ts:1127-1132`)

## Apply gate

- [x] **IAC-RUN-GATE-001**: When the operator clicks "Apply", the IaC page shall call `hyveon.iac.apply({ planRunId, planHash })` with the hash returned by the approved plan run.
- [x] **IAC-RUN-GATE-002**: When a preview succeeds, the system shall save the engine's update plan as `<runsDir>/<runId>/<runId>.plan.json` and compute `planHash` over that artifact plus the configuration object's version id.
- [x] **IAC-RUN-GATE-003**: If an apply names a `planRunId` with no run record, then the system shall refuse it with `PulumiPlanRunNotFoundError` before invoking the engine.
- [x] **IAC-RUN-GATE-004**: If an apply names a run record whose kind is not `plan`, then the system shall refuse it before invoking the engine.
- [x] **IAC-RUN-GATE-005**: If an apply names a plan record with no `approvedBy`/`approvedAt`, then the system shall refuse it with `PulumiPlanNotApprovedError` before invoking the engine.
- [x] **IAC-RUN-GATE-006**: If an apply names a plan whose approval is older than 15 minutes, then the system shall refuse it with `PulumiApprovalExpiredError` before invoking the engine, and the IaC page shall surface the error and prompt re-approval.
- [x] **IAC-RUN-GATE-007**: If an apply's supplied `planHash` does not equal the plan record's stored `planHash`, then the system shall refuse it with `PulumiPlanHashMismatchError` before invoking the engine.
- [x] **IAC-RUN-GATE-008**: If the plan record carries a `configVersionId` and the configuration object's current head version differs from it, then the system shall refuse the apply with `StalePlanError` and direct the operator to re-plan.
- [x] **IAC-RUN-GATE-009**: If the on-disk plan artifact is missing or its re-computed hash no longer equals the plan record's `planHash`, then the system shall refuse the apply with `PulumiPlanArtifactStaleError` before invoking the engine.
- [x] **IAC-RUN-GATE-010**: If the engine version recorded on the plan differs from the currently resolved engine version, then the system shall refuse the apply with `PulumiEngineVersionMismatchError` naming both versions and direct the operator to re-plan.
- [x] **IAC-RUN-GATE-011**: When an apply has passed gate steps 1 to 7, the system shall acquire the durable apply lock through `RunService.createRun` as the final and authoritative gate step, with no preceding "is the workspace free" observation relied on to order two applies.
- [x] **IAC-RUN-GATE-012**: When two applies for the same approved plan are submitted close enough that both pass gate steps 1 to 7, the system shall let exactly one acquire the durable apply lock and refuse the other with `{ started: false, conflict: 'up', runLock }`.
- [x] **IAC-RUN-GATE-013**: If, after an apply or destroy acquires the durable apply lock, the in-process workspace guard shows another operation or a stack initialization in flight, then the system shall release the just-acquired lock and refuse the submission. (observed: `PulumiService.ts:2129-2161`, `:2981-3001`)
- [x] **IAC-RUN-GATE-014**: If an apply submission is refused by any gate step, then `iac.apply` shall resolve `{ started: false, error }` (plus `conflict`, `runLock` or `staleLock` where applicable) and the IaC page shall surface the error without streaming apply output.
- [x] **IAC-RUN-GATE-015**: When an apply settles successfully, the IaC page shall show an "Apply complete" banner with a link to the dashboard.

## Partial apply

- [x] **IAC-RUN-PART-001**: If a plan-constrained apply fails or is aborted after at least one resource step was applied, then the system shall settle the apply run with `partialApply: true` in addition to its `failed` or `aborted` status, rather than a fourth `RunStatus`.
- [x] **IAC-RUN-PART-002**: Before `stack.up()` runs, the system shall write a pre-flight marker record (`kind: 'apply'`, `status: 'aborted'`, `exitCode: null`, `partialApply: true`) under the same `sk` the settlement will overwrite, and if that write fails, shall abort the apply instead of running unmarked. (observed: `PulumiService.ts:2213`, `RunRecordService.ts:392-475`)
- [x] **IAC-RUN-PART-003**: When the live IaC page shows an apply run whose record has `partialApply: true`, the page shall show the partial-apply banner directing the operator to start over and re-plan, in place of a plain failure banner or retry.
- [x] **IAC-RUN-PART-004**: If an apply names a `planRunId` whose newest record is an apply with `partialApply: true`, then the system shall refuse it with `PulumiPartialApplyRetryBlockedError`.
- [x] **IAC-RUN-PART-005**: When history or run detail renders an apply record with `partialApply: true`, the system shall show a "partial" badge next to its status.

## Destroy

- [x] **IAC-RUN-DSTR-001**: The `/iac` page shall offer a destroy entry point that opens a type-to-confirm dialog stating that all managed infrastructure will be destroyed, and the destructive confirm button shall stay disabled until the operator types exactly `destroy infrastructure`.
- [x] **IAC-RUN-DSTR-002**: When the operator confirms the destroy dialog, the renderer shall mint a token through `hyveon.iac.mintDestroyToken()` and immediately submit `hyveon.iac.destroy({ confirmationToken })`, minting no token before confirmation.
- [x] **IAC-RUN-DSTR-003**: When a destroy confirmation token is minted, the system shall bind it to the current state bucket, state-bucket region, Pulumi project and stack, give it an expiry, and supersede any previously minted unconsumed destroy token.
- [x] **IAC-RUN-DSTR-004**: If a destroy is submitted with a missing, unknown, superseded, expired or already-consumed token, or a token bound to a different state bucket, region, project or stack, then the system shall refuse it with `DestroyNotConfirmedError` and not invoke the engine.
- [x] **IAC-RUN-DSTR-005**: When a destroy token passes validation, the system shall consume it synchronously before any `await`, so of two concurrent submissions carrying the same token at most one proceeds.
- [x] **IAC-RUN-DSTR-006**: The system shall reach the engine's `stack.destroy()` only through the token-gated `PulumiService.destroy`.
- [x] **IAC-RUN-DSTR-007**: When a destroy token has been consumed, the system shall acquire the durable apply lock through `RunService.createRun` before invoking the engine, and shall release it through run-record persistence on every settled exit path.
- [x] **IAC-RUN-DSTR-008**: If `iac.destroy` is invoked while a workspace operation is in flight, then the system shall resolve `{ started: false, error, conflict }` without starting the engine, writing an audit entry, or persisting a run record.
- [x] **IAC-RUN-DSTR-009**: When a destroy submission is accepted, the system shall resolve `{ started: true, runId }`, record a `destroy` audit entry, and persist a `kind: 'destroy'` run record once it settles.
- [x] **IAC-RUN-DSTR-010**: If an accepted destroy run is cancelled (its renderer is destroyed or the abort signal fires) before it settles, then the system shall release the durable apply lock and settle the run record as `aborted`.
- [ ] **IAC-RUN-DSTR-011**: When the app shuts down while a destroy or apply run is in flight, the system shall release the durable apply lock as part of shutdown.
- [x] **IAC-RUN-DSTR-012**: If a destroy run fails or completes, then the system shall require a newly minted token for the next destroy attempt.
- [ ] **IAC-RUN-DSTR-014**: The destroy confirmation token shall be implemented on `LockClearConfirmationGate` rather than a separate hand-rolled single-use token. (observed: duplication rule; gap: `PulumiService.ts:2734`, `:3798-3837`)

## Run history and listing

- [x] **IAC-RUN-HIST-001**: The system shall expose run listing across every layer as `RunRecordStore.listRuns`, `RunRecordService.listRuns`, the `iac.runs.list` IPC channel and `hyveon.iac.runs.list`, returning a newest-first `RunPageResult` with an optional `nextBefore` cursor.
- [x] **IAC-RUN-HIST-002**: When `RunRecordService.listRuns` is called, the system shall clamp the page size to between 1 and 100, defaulting to 25 for an omitted or invalid limit. (observed: `RunRecordService.ts:105-131`)
- [x] **IAC-RUN-HIST-003**: When an unfiltered run listing is requested with a `before` cursor, the system shall return only runs whose `sk` is older than that cursor, newest-first.
- [ ] **IAC-RUN-HIST-004**: When a run listing is filtered to one status, the system shall query the `status-index` GSI (hash `status`, range `startedAt`) newest-first, escaping the reserved word `status` in the key condition, without scanning the table.
- [x] **IAC-RUN-HIST-005**: The web app shall provide an `/iac/history` route listing runs newest-first, each row showing kind, status, change summary, started and completed timestamps, the approver when present, and a "rollback" tag when `rolledBackFrom` is set.
- [x] **IAC-RUN-HIST-006**: When the history page has a `nextBefore` cursor and the operator clicks "Load more", the page shall fetch the next older page and append it.
- [x] **IAC-RUN-HIST-007**: When the operator filters history by status, the history page shall request a server-side status-filtered listing offering all three `RunStatus` values.
- [x] **IAC-RUN-HIST-008**: When the operator filters history by kind (`plan`, `apply` or `destroy`), the history page shall filter the already-fetched records client-side.
- [x] **IAC-RUN-HIST-009**: When history renders a record with no change summary, the row shall render without a summary and without throwing.

## Run detail

- [x] **IAC-RUN-DETL-001**: When the operator opens a history row, the system shall show a read-only run-detail page at `/iac/history/:runId` with the run's status, change summary, approver and captured log, using the same log viewer as the live IaC page.
- [x] **IAC-RUN-DETL-002**: When run detail resolves a run's log, the system shall replay it through `iac.runs.streamLogs` when local run artifacts exist, otherwise use the record's `logInline`, otherwise fetch it from the presigned URL returned by `iac.runs.logUrl` for the record's `logS3Key`.
- [x] **IAC-RUN-DETL-003**: The run-detail page shall never render Approve or Apply controls.
- [ ] **IAC-RUN-DETL-004**: When run detail is opened for any persisted run, the system shall resolve that run's record by `runId`, regardless of how many newer runs exist. (observed; gap: `iac-run-detail.page.tsx:22`, `:49-53` scans only the newest 200 records from `iac.runs.list`)

## Rollback

- [x] **IAC-RUN-RBK-001**: The history page shall offer a "Rollback" action only on apply rows whose record carries a `configVersionId`.
- [x] **IAC-RUN-RBK-002**: When the operator clicks "Rollback", the system shall call `iac.rollback.resolve`, which returns the configuration version that preceded the apply's `configVersionId` without writing anything, and the renderer shall show a confirmation identifying that target version.
- [x] **IAC-RUN-RBK-003**: Where `iac.rollback.resolve` can compute a diff between the target and current configuration, the rollback confirmation shall summarise that diff, and shall identify the target version alone when it cannot.
- [x] **IAC-RUN-RBK-004**: If a rollback names a run that does not exist, is not an apply, has no `configVersionId`, or whose preceding version no longer exists, then the system shall fail with an error naming the cause before any configuration write.
- [x] **IAC-RUN-RBK-005**: When a rollback is confirmed, the system shall re-resolve the target, restore the historic configuration as a new head version, and run a preview against that restored version whose record carries `rolledBackFrom: <applyRunId>`.
- [x] **IAC-RUN-RBK-006**: While a rollback confirm runs, from before the restore write until its plan record is persisted, the system shall hold the in-process workspace guard (`operationInFlight = 'rollback'`), so a plan, apply or destroy submitted in this process in that window is refused as busy.
- [x] **IAC-RUN-RBK-007**: If the rollback plan fails after the restore was written, then the system shall record the orphaned restore durably and return `{ confirmed: false, error }` carrying the restored version id, rather than leaving an unreported head.
- [x] **IAC-RUN-RBK-008**: When a rollback plan completes successfully, the system shall leave it in `awaiting_approval` and require the same approval, approval window, plan-hash, configuration-version, engine-version and apply-lock gates as any other plan.
- [x] **IAC-RUN-RBK-009**: When a rollback is confirmed, the system shall record a `rollback` audit entry carrying the restored version id. (observed: `iac.controller.ts:1276-1282`)
- [ ] **IAC-RUN-RBK-010**: When a rollback is confirmed, the system shall produce exactly one tagged plan run for the operator to approve. (observed; gap: `confirmRollback` runs a tagged preview (`PulumiService.ts:3631`) and the IaC page then auto-submits a second tagged plan on arrival (`iac.page.tsx:130-135`))

## IPC surface and streaming

- [x] **IAC-RUN-IPC-001**: The system shall expose every run operation as an Electron IPC `@MessagePattern` on `IacController` or `IacRunsController`, with no HTTP transport. (observed: CLAUDE.md no-HTTP invariant; `iac.controller.ts:506`, `iac-runs.controller.ts:145`)
- [x] **IAC-RUN-IPC-002**: Every IPC handler on `IacController` and `IacRunsController` shall log a `debug` line naming the controller and pattern as its first statement, with no payload contents. (observed: `.claude/rules/logging.md` rule 1; `iac.controller.ts:720`, `:976`, `:1106`, `:1224`, `iac-runs.controller.ts:210`)
- [x] **IAC-RUN-IPC-003**: When `iac.plan`, `iac.apply` or `iac.destroy` accepts or refuses a submission, the system shall resolve an immediate ack modelling refusal as `started: false` with `error` plus `conflict`, `staleLock` or `runLock`, never by throwing. (observed: `iac.controller.ts:715-795`, `:815-923`, `:971-1065`)
- [x] **IAC-RUN-IPC-004**: When an `iac.plan`, `iac.apply` or `iac.destroy` run is accepted, the controller shall drive the service generator to completion, sending each chunk tagged with the `runId` on `iac.<op>.chunk` and exactly one terminal message on `iac.<op>.end`.
- [x] **IAC-RUN-IPC-005**: The `iac.plan`, `iac.apply`, `iac.destroy`, `iac.runs.logs` and `iac.rollback.confirm` handlers shall be self-bridged and excluded from the generic `ipcMain.handle` bridge.
- [x] **IAC-RUN-IPC-006**: The preload shall expose `mintDestroyToken`, `destroy`, `plan`, `approve`, `apply`, `runs.get`, `runs.streamLogs`, `runs.list`, `runs.logUrl`, `runs.lock.mintToken`, `runs.lock.clear`, `rollback.resolve` and `rollback.confirm` on `hyveon.iac`, with typed mirrors in `hyveon-api.ts`.
- [x] **IAC-RUN-IPC-007**: When the WebContents that submitted a plan, apply, destroy or rollback confirm is destroyed, the controller shall abort that run's `AbortController`. (observed: `iac.controller.ts:740`, `:870`, `:1020`, `:1233`)
- [ ] **IAC-RUN-IPC-008**: The plan, apply and destroy streaming loops in `IacController` shall share one extracted implementation. (observed: duplication rule (three occurrences); gap: `iac.controller.ts:766-792`, `:890-921`, `:1032-1063`)
- [x] **IAC-RUN-IPC-009**: When `iac.runs.get` is called for a run not holding the lock, the system shall read the local `run.json` and report `RunDetailStatus` computed from its kind, exit code and, for plans, whether the plan artifact exists. (observed: `iac-runs.controller.ts:224-237`, `shared/src/runs.ts:280-346`)

## Integration coverage

- [x] **IAC-RUN-ITEST-001**: The integration harness shall substitute a scriptable `PulumiServiceStub` for `PulumiService` through the real DI container (`overrideProvider(PulumiService).useValue(...)`), spawning no subprocess and patching no `PulumiService` internals.
- [x] **IAC-RUN-ITEST-002**: No integration spec shall invoke the real Pulumi engine, download the engine binary, or reach real AWS.
- [x] **IAC-RUN-ITEST-003**: The integration suite shall verify that `IacController.plan`, dispatched through the real controller wiring, reports the stub's scripted success (with a plan artifact and `planHash`), its exact change-summary counts, and a failed preview with no `planHash`.
- [x] **IAC-RUN-ITEST-004**: The integration suite shall verify that `IacController.apply` maps each apply-gate error class (missing plan, unapproved, expired approval, hash mismatch, stale artifact, moved configuration, engine version change, held lock) to a `{ started: false }` ack with no engine output, and runs the stub to completion for a fresh approved plan.
- [ ] **IAC-RUN-ITEST-005**: The integration suite shall exercise the real `PulumiService.apply` gate arithmetic, including the atomic-lock ordering of two competing applies, through the real controller wiring.
- [x] **IAC-RUN-ITEST-006**: The integration suite shall verify that `IacController.destroy` maps `DestroyNotConfirmedError` for missing, consumed, wrong-target, expired, superseded and concurrently reused tokens to a refused ack with no engine output, and runs the stub's destroy for a fresh token.
- [ ] **IAC-RUN-ITEST-007**: The integration suite shall exercise the real `PulumiService.destroy` token bookkeeping (minting, binding, expiry, supersession, atomic consumption).
- [x] **IAC-RUN-ITEST-008**: The integration suite shall verify that ANSI escape sequences on stdout and stderr pass byte-for-byte, with stream attribution, through the streamed chunks and the persisted run log.
- [x] **IAC-RUN-ITEST-009**: The integration suite shall verify that successful and failed runs persist a run record (with `planHash` only on success), that a log under 350 KiB is embedded inline with no S3 key, and that the persisted run is returned by `iac.runs.list` both with a page-size limit and with a matching status filter.
- [x] **IAC-RUN-ITEST-010**: The integration suite shall verify that the stack-outputs channel returns the stub's scripted outputs and resolves a "not deployed yet" result rather than throwing for a never-deployed stack.
