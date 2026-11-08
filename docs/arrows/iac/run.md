# Arrow: iac/run

Each plan / apply / destroy / rollback attempt as a durable record: who approved it, whether it was locked, what happened, and the history page that lists them.

## Status

**MAPPED** — mapped 2026-10-30 (git SHA `5c55a380`), not yet audited.
The run lifecycle works end to end through the IaC page and history, and `partialApply` round-trips through the DynamoDB store, and the durable run lock is held from the first apply on a fresh install.

## References

### HLD
- `docs/high-level-design.md`
- `docs/intent/iac/iac-design.md` (sub-HLD)

### LLD
- `docs/intent/iac/run/run-design.md`

### EARS
- `docs/intent/iac/run/run-specs.md` (133 specs)

### Tests
- **cloud-aws**: `app/packages/cloud-aws/src/AwsRunRecordStore.test.ts`
- **desktop-main**: `app/packages/desktop-main/src/controllers/iac-runs.controller.test.ts`, `app/packages/desktop-main/src/controllers/iac.controller.test.ts`, `app/packages/desktop-main/src/services/RunRecordService.test.ts`, `app/packages/desktop-main/src/services/RunService.test.ts`
- **shared**: `app/packages/shared/src/errors.test.ts`, `app/packages/shared/src/relativeTime.test.ts`, `app/packages/shared/src/runs.test.ts`
- **web (integration, Playwright tier 2)**: `app/packages/web/e2e/integration-specs/iac-apply-gates.spec.ts`, `iac-destroy-token.spec.ts`, `iac-plan.spec.ts`, `iac-run-records.spec.ts`, `iac-streaming-ansi.spec.ts`
- **web (e2e, Playwright tier 1)**: `app/packages/web/e2e/specs/iac.spec.ts`
- **web (vitest/jsdom)**: `app/packages/web/src/components/ansi-log-viewer.component.test.tsx`, `rollback-action.component.test.tsx`, `run-history-row.component.test.tsx`, `app/packages/web/src/hooks/use-run-history.hook.test.ts`, `app/packages/web/src/lib/rollback-diff.utils.test.ts`, `app/packages/web/src/pages/iac-history.page.test.tsx`, `iac-run-detail.page.test.tsx`, `iac.page.test.tsx`

### Code
- **cloud-aws**: `app/packages/cloud-aws/src/AwsRunRecordStore.ts`
- **desktop-main**: `app/packages/desktop-main/src/controllers/iac.controller.ts`, `app/packages/desktop-main/src/controllers/iac-runs.controller.ts`, `app/packages/desktop-main/src/modules/run-record.module.ts`, `app/packages/desktop-main/src/services/RunService.ts`, `app/packages/desktop-main/src/services/RunRecordService.ts`, `app/packages/desktop-main/src/services/LockClearConfirmationGate.ts`, `app/packages/desktop-main/src/services/runs-table-name.ts`, `app/packages/desktop-main/src/test-mocks/run-record-mock.ts`
- **shared**: `app/packages/shared/src/runs.ts`, `app/packages/shared/src/changeSummary.ts`, `app/packages/shared/src/errors.ts`, `app/packages/shared/src/relativeTime.ts`
- **web (pages, hooks, lib)**: `app/packages/web/src/pages/iac.page.tsx`, `iac-history.page.tsx`, `iac-run-detail.page.tsx`, `app/packages/web/src/hooks/use-iac-run.hook.ts`, `use-run-history.hook.ts`, `app/packages/web/src/lib/rollback-diff.utils.ts`
- **web (components)**: `app/packages/web/src/components/ansi-log-viewer.component.tsx`, `change-summary-status.component.tsx`, `iac-destroy-section.component.tsx`, `partial-apply-badge.component.tsx`, `rollback-action.component.tsx`, `rolled-back-from-link.component.tsx`, `run-history-row.component.tsx`, `run-status-badge.component.tsx`, `submission-banners.component.tsx`
- **web (test support)**: `app/packages/web/e2e/integration-specs/support/iac-ctx.ts`, `app/packages/web/e2e/pages/IacPage.ts`, `app/packages/web/e2e/pages/IacHistoryPage.ts`

### Cited from other leaves
- `app/packages/desktop-main/src/services/PulumiService.ts` (`iac/engine`): the 8-gate apply (`apply` at `:1968`), preview (`:1444`), pre-flight marker and partial-apply detection, destroy token (`mintDestroyConfirmationToken` at `:2734`), rollback (`resolveRollbackTarget` at `:3381`, `confirmRollback` at `:3580`), stale Pulumi-lock clear, and env redaction (`:1403`). Run's EARS will cite this file heavily.
- `app/packages/desktop-main/src/services/PulumiLockRecovery.ts` (`iac/engine`): Pulumi backend lock classification behind `iac.lock.clear`.
- `app/packages/shared/src/cloud.ts` (`game-runtime/task-and-dns`): the `RunRecordStore` interface `AwsRunRecordStore` implements.
- `app/packages/desktop-main/src/modules/cloud-provider.module.ts` (`operator-app/desktop-shell`): binds the run-record store; `:174-175` resolves the runs table with the pre-apply fallback.
- `app/packages/desktop-main/src/controllers/validation.ts` (`operator-app/ipc-bridge`): payload validation used by both IaC controllers.
- `app/packages/desktop-preload/src/*`, `ipc-main-bridge.ts` (`operator-app/ipc-bridge`): `window.hyveon.iac.*` bridge, `SELF_BRIDGED_PATTERNS` for the streaming channels.
- `app/packages/web/src/lib/ansi.utils.ts` (`operator-app/infra-logs`): ANSI-to-HTML used by `ansi-log-viewer`.
- `app/packages/desktop-main/src/services/DeploymentConfigService.ts` and `cloud-aws/src/AwsRemoteFileStore.ts` (`deployment-config`): `restoreRawConfig` and `listVersions` for the restore half of rollback; `shared/src/deploymentConfig.ts` `diffDeploymentConfig` feeds `rollback-diff.utils.ts`.
- `app/packages/desktop-main/src/services/AuditService.ts` (`operator-app/diagnostics`): audit entries written by `iac.controller.ts`.
- `app/packages/web/e2e/fixtures/ipc-harness.ts` (shared test harness): the integration seam the `orchestrator-integration-coverage` specs run through.

## Architecture

**Purpose:** Turn every Pulumi plan, apply, destroy and rollback into a tracked run: guard submissions with a single apply lock, gate apply behind approval and a plan hash, persist a record (with log) to the runs table, and give the operator the IaC page, run history and run detail to drive and inspect them.

**Key Components:**
1. `IacController` (`desktop-main/src/controllers/iac.controller.ts:506`): IPC channels `iac.plan` (`:715`), `iac.apply` (`:815`), `iac.destroy` (`:971`) plus `iac.destroy.mintToken` (`:941`), `iac.approve` (`:1104`), `iac.rollback.resolve`/`confirm` (`:1162`, `:1219`), `iac.lock.clear`(+`mintToken`) (`:953`, `:1332`); also hosts `iac.stack.initialize` (`:636`) and `iac.output` (`:1085`). Streaming channels are self-bridged with an immediate `{ started, runId, conflict }` ack.
2. `IacRunsController` (`desktop-main/src/controllers/iac-runs.controller.ts:145`): `iac.runs.get` (reads the local Pulumi run record and the durable lock), `iac.runs.logs`, `iac.runs.list`, `iac.runs.record` (one persisted record by `runId`), `iac.runs.logUrl`, `iac.runs.lock.clear.mintToken`/`clear` (`:373`, `:406`).
3. `RunService` (`desktop-main/src/services/RunService.ts:97`): owns the apply lock, an in-memory `RunLock` set synchronously, mirrored to DynamoDB via `acquireRunLock` (`createRun` at `:160`, durable mirror `:179-194`), 1 h TTL (`DEFAULT_LOCK_TTL_MS`, `:40`), token-gated clear (`mintLockClearConfirmationToken` `:312`, `clearLock` `:371`).
4. `RunRecordService` (`desktop-main/src/services/RunRecordService.ts:227`): `persist` (`:316`, log inline at or below 350 KiB `:103`, else S3), `writePreflightMarker` (`:439`), `getLogUrl` (`:489`), `listRuns` (`:555`), `approveRun` (`:604`); resolves the runs table through `runs-table-name.ts` (stack outputs, then the pre-apply fallback).
5. `AwsRunRecordStore` (`cloud-aws/src/AwsRunRecordStore.ts:85`): `pk = RUN` items keyed `<startedAt>#<runId>`, `status-index` GSI listing (`:295`), `LOCK/CURRENT` conditional-put lock (`:422-445`), S3 log offload and presign.
6. `LockClearConfirmationGate` (`desktop-main/src/services/LockClearConfirmationGate.ts:57`): generic mint/assert/consume single-use token bound to "what is locked now"; used by `RunService` and `PulumiService`'s Pulumi-lock clear.
7. `run-record.module.ts` (`desktop-main/src/modules/run-record.module.ts:44-52`): provides the two services and aliases them as `RUN_RECORD_PERSISTER` / `RUN_LOCK_SERVICE` for `PulumiService`.
8. `shared/src/runs.ts`: `RunRecord`, `RunKind` (`plan|apply|destroy`, `:14`), `RunStatus` (`success|failed|aborted`, `:24`), `deriveRunStatus` (`:205`), `APPROVAL_WINDOW_MS` and `isApprovalExpired` (`:261-277`), `RunDetailStatus`/`computeRunDetailStatus` (`:293`); plus `changeSummary.ts` (`ChangeSummary`, empty means "unavailable" `:46-54`) and `errors.ts` (`RunLockHeldError` `:57`, `OptimisticLockError` `:19`).
9. `IacPage` + `useIacRun` (`web/src/pages/iac.page.tsx:92`, `web/src/hooks/use-iac-run.hook.ts:181`): plan → stream → approve → plan-hash apply, approval countdown, partial-apply banner, busy / stale-lock / run-lock banners (`submission-banners.component.tsx:322`), destroy section (`iac-destroy-section.component.tsx:31`).
10. History and detail (`web/src/pages/iac-history.page.tsx:36`, `iac-run-detail.page.tsx:179`, `hooks/use-run-history.hook.ts:26`): paged list with server-side status filter and client-side kind filter, read-only detail with log ladder (replay → `logInline` → presigned S3 `fetch`), two-step rollback (`rollback-action.component.tsx:58`). Routes at `web/src/app.component.tsx:103-105`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Run record and status | `IAC-RUN-REC-001` to `IAC-RUN-REC-009` | 9 | 0 | 0 |
| Runs table and log storage | `IAC-RUN-STORE-001` to `IAC-RUN-STORE-009` | 9 | 0 | 0 |
| Apply lock | `IAC-RUN-LOCK-001` to `IAC-RUN-LOCK-010` | 10 | 0 | 0 |
| Run-lock recovery | `IAC-RUN-LCLR-001` to `IAC-RUN-LCLR-012` | 12 | 0 | 0 |
| Operator cancel | `IAC-RUN-CANCEL-001` | 0 | 1 | 0 |
| Plan submission and the IaC page | `IAC-RUN-PLAN-001` to `IAC-RUN-PLAN-010` | 10 | 0 | 0 |
| Approval | `IAC-RUN-APPR-001` to `IAC-RUN-APPR-007` | 7 | 0 | 0 |
| Apply gate | `IAC-RUN-GATE-001` to `IAC-RUN-GATE-015` | 15 | 0 | 0 |
| Partial apply | `IAC-RUN-PART-001` to `IAC-RUN-PART-005` | 5 | 0 | 0 |
| Destroy | `IAC-RUN-DSTR-001` to `IAC-RUN-DSTR-014` (no `-013`) | 13 | 0 | 0 |
| Run history and listing | `IAC-RUN-HIST-001` to `IAC-RUN-HIST-009` | 9 | 0 | 0 |
| Run detail | `IAC-RUN-DETL-001` to `IAC-RUN-DETL-004` | 4 | 0 | 0 |
| Rollback | `IAC-RUN-RBK-001` to `IAC-RUN-RBK-010` | 10 | 0 | 0 |
| IPC surface and streaming | `IAC-RUN-IPC-001` to `IAC-RUN-IPC-009` | 9 | 0 | 0 |
| Integration coverage | `IAC-RUN-ITEST-001` to `IAC-RUN-ITEST-010` | 8 | 2 | 0 |

**Summary:** 130 of 133 active specs implemented; 3 deferred; 0 gaps.

## Key Findings

1. **`partialApply` round-trips through the DynamoDB store**: `AwsRunRecordStore.putRecord` writes it (`AwsRunRecordStore.ts:209`) and `toRunRecord` reads it (`:377`), so a pre-flight marker reads back as `aborted` with `partialApply: true`. The apply gate refuses a retry on it with `PulumiPartialApplyRetryBlockedError` (`PulumiService.loadValidatedPlanRecord`, run once before and once after the apply lock is acquired, each reading the record with a strongly consistent `getRecordByRunId`), and history and run detail show the "partial" badge (`run-history-row.component.tsx:46`, `iac-run-detail.page.tsx:202`).
2. **The durable run lock resolves the runs table like the record service does**: `RunService` and `RunRecordService` both call `resolveRunsTableName` (`desktop-main/src/services/runs-table-name.ts`: stack outputs first, then the persisted deployment config), so the first apply on a fresh install holds the durable lock. `RunService.getHeldLock` reads the lock in memory then durably, so `iac.runs.get` still reports `running` for a run whose lock outlived an app restart, until the lock is cleared or its TTL passes.
3. **`listRuns` escapes the reserved word `status`**: the status-filtered query uses `KeyConditionExpression: '#status = :status'` with `ExpressionAttributeNames: { '#status': 'status' }` (`AwsRunRecordStore.ts`), since `status` is a DynamoDB reserved word; the store test asserts the escaped expression against a mocked client.
4. **`getRecordByRunId` is an unbounded filtered query**: it pages the whole `pk = RUN` partition with a `FilterExpression` on `runId` (`AwsRunRecordStore.ts:232-252`); acknowledged in its TSDoc as acceptable at current volume. Run detail resolves its record through `iac.runs.record` (`RunRecordService.getByRunId`), so no run is too old to open.
5. **Destroy output redaction**: `iac/engine` redacts destroy output, the persisted log and the failure message from the stack state and the configuration (`IAC-ENGINE-REDACT-002`).
6. **The destroy token runs on the shared gate**: `PulumiService` mints, supersedes, expires, binds and consumes its destroy token and its Pulumi lock-clear token through two `LockClearConfirmationGate` instances with one target binding and one rejection-logging helper. `LockClearConfirmationGate` has its own co-located test.
7. **The IaC page imports the approval window from `@hyveon/shared`**: `iac.page.tsx` uses the same `APPROVAL_WINDOW_MS` and `isApprovalExpired` the apply gate enforces.
8. **Rollback confirm acks only after the whole plan, with one plan per rollback**: `iac.rollback.confirm` drives `confirmRollback` to completion before returning `{ confirmed, versionId, planRunId }`, and the IaC page adopts that plan (`useIacRun.adopt`) rather than submitting a second one. Its chunk channel `iac.rollback.confirm.chunk` has no subscriber in `desktop-preload` or `web/src`.
9. **The plan, apply and destroy handlers share one streaming helper**: `IacController.trackRun` and `pumpRunStream` replace three copies of the loop. The matching chunk-streaming setups in `PulumiService` (preview, up and destroy) are still three near-identical blocks, owned by `iac/engine`.
10. **Integration coverage runs against a stubbed `PulumiService` by design**: `iac-apply-gates.spec.ts:30-41` states the DI stub fully replaces `PulumiService`, so the 8-step gate math and token bookkeeping are unit-tested (`PulumiService.apply.test.ts`, `PulumiService.destroy.test.ts`) and the integration specs check controller ack-shaping. `IAC-RUN-ITEST-005` and `IAC-RUN-ITEST-007` are deferred for that reason.
11. **`iac.output` ignores `force`**: documented as accepted-for-compatibility and ignored (`iac.controller.ts:1076-1078`, `:1088`).
12. **Stale vocabulary in run code**: `RunService.ts:3` cites issue #106; `runs.ts:4-13` explains the pre-Pulumi `plan/apply/destroy` naming; `errors.ts:53-55` refers to "the HTTP layer can respond `409 Conflict`" though the app has no HTTP transport.
13. **History kind filter is client-side over a server page**: `iac-history.page.tsx:29-30` filters `kind` after fetching a status-filtered page, so a kind-filtered view can show a short or empty page while older matching runs exist until "Load more" is used `[inferred]`. Sweep 3's claim that the status filter "omits other statuses" is refuted: the dropdown lists all three `RunStatus` values (`iac-history.page.tsx:82-84`, `runs.ts:24`).
14. **`formatLockAge` duplication already resolved**: sweep 3's note that `submission-banners.component.tsx:196-200` duplicates a desktop-main counterpart is stale; both it and `PulumiLockRecovery.ts:325` are adapters over `formatRelativeAge` (`shared/src/relativeTime.ts:16`).

## Work Required

Spec IDs cite the `docs/intent/iac/run/run-specs.md` lines each item closed; items with no spec carry none.

### Must Fix
None open.

### Should Fix
1. Done in `iac/engine`: redaction covers destroy output (finding 5).
2. Extract the matching chunk-streaming setups in `PulumiService` (finding 9, owned by `iac/engine`).
3. Decide whether rollback confirm should stream its plan or drop the unused chunk channel (finding 8).
4. Split `PulumiService.ts` along the run/engine seam so this leaf's run gates, locking and run lifecycle sit in files separate from `iac/engine`'s plumbing, as its own pure-refactor change with no behaviour change; this removes the `run` <-> `engine` cycle in `docs/arrows/index.yaml` (`iac-design.md`, decision 10). Tracked with the matching Should Fix item in `docs/arrows/iac/engine.md`.

### Nice to Have
5. Remove the stale issue number and HTTP references (finding 12).
6. Drop or honour the ignored `force` on `iac.output` (finding 11).
7. Server-side kind filter or a clearer empty state on history (finding 13).
