# Arrow: iac/run

Each plan / apply / destroy / rollback attempt as a durable record: who approved it, whether it was locked, what happened, and the history page that lists them.

## Status

**MAPPED** — mapped 2026-10-30 (git SHA `5c55a380`), not yet audited.
The run lifecycle works end to end through the IaC page and history, but `partialApply` is lost on the DynamoDB round trip and the durable run lock is skipped before the first apply.

## References

### HLD
- `docs/high-level-design.md`
- `docs/intent/iac/iac-design.md` (sub-HLD)

### LLD
- `docs/intent/iac/run/run-design.md`

### EARS
- `docs/intent/iac/run/run-specs.md` (129 specs)

### Tests
- **cloud-aws**: `app/packages/cloud-aws/src/AwsRunRecordStore.test.ts`
- **desktop-main**: `app/packages/desktop-main/src/controllers/iac-runs.controller.test.ts`, `app/packages/desktop-main/src/controllers/iac.controller.test.ts`, `app/packages/desktop-main/src/services/RunRecordService.test.ts`, `app/packages/desktop-main/src/services/RunService.test.ts`
- **shared**: `app/packages/shared/src/errors.test.ts`, `app/packages/shared/src/relativeTime.test.ts`, `app/packages/shared/src/runs.test.ts`
- **web (integration, Playwright tier 2)**: `app/packages/web/e2e/integration-specs/iac-apply-gates.spec.ts`, `iac-destroy-token.spec.ts`, `iac-plan.spec.ts`, `iac-run-records.spec.ts`, `iac-streaming-ansi.spec.ts`
- **web (e2e, Playwright tier 1)**: `app/packages/web/e2e/specs/iac.spec.ts`
- **web (vitest/jsdom)**: `app/packages/web/src/components/ansi-log-viewer.component.test.tsx`, `rollback-action.component.test.tsx`, `run-history-row.component.test.tsx`, `app/packages/web/src/hooks/use-run-history.hook.test.ts`, `app/packages/web/src/lib/rollback-diff.utils.test.ts`, `app/packages/web/src/pages/iac-history.page.test.tsx`, `iac-run-detail.page.test.tsx`, `iac.page.test.tsx`

### Code
- **cloud-aws**: `app/packages/cloud-aws/src/AwsRunRecordStore.ts`
- **desktop-main**: `app/packages/desktop-main/src/controllers/iac.controller.ts`, `app/packages/desktop-main/src/controllers/iac-runs.controller.ts`, `app/packages/desktop-main/src/modules/run-record.module.ts`, `app/packages/desktop-main/src/services/RunService.ts`, `app/packages/desktop-main/src/services/RunRecordService.ts`, `app/packages/desktop-main/src/services/LockClearConfirmationGate.ts`, `app/packages/desktop-main/src/test-mocks/run-record-mock.ts`
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

### OpenSpec sources
- `openspec/specs/iac-plan-apply-page/spec.md` (synced, main)
- `openspec/specs/iac-destroy-flow/spec.md` (synced, main)
- `openspec/specs/iac-run-history/spec.md` (synced, main)
- `openspec/specs/iac-rollback/spec.md` (synced, main; gates only, the restore half is cited from `deployment-config`)
- `openspec/specs/orchestrator-integration-coverage/spec.md` (synced, main)
- Active changes: none mapped to this leaf in `final-clustering.md` §7.

## Architecture

**Purpose:** Turn every Pulumi plan, apply, destroy and rollback into a tracked run: guard submissions with a single apply lock, gate apply behind approval and a plan hash, persist a record (with log) to the runs table, and give the operator the IaC page, run history and run detail to drive and inspect them.

**Key Components:**
1. `IacController` (`desktop-main/src/controllers/iac.controller.ts:506`): IPC channels `iac.plan` (`:715`), `iac.apply` (`:815`), `iac.destroy` (`:971`) plus `iac.destroy.mintToken` (`:941`), `iac.approve` (`:1104`), `iac.rollback.resolve`/`confirm` (`:1162`, `:1219`), `iac.lock.clear`(+`mintToken`) (`:953`, `:1332`); also hosts `iac.stack.initialize` (`:636`) and `iac.output` (`:1085`). Streaming channels are self-bridged with an immediate `{ started, runId, conflict }` ack.
2. `IacRunsController` (`desktop-main/src/controllers/iac-runs.controller.ts:145`): `iac.runs.get` (`:208`, reads the local Pulumi run record), `iac.runs.logs` (`:257`), `iac.runs.list` (`:316`), `iac.runs.logUrl` (`:337`), `iac.runs.lock.clear.mintToken`/`clear` (`:373`, `:406`).
3. `RunService` (`desktop-main/src/services/RunService.ts:97`): owns the apply lock, an in-memory `RunLock` set synchronously, mirrored to DynamoDB via `acquireRunLock` (`createRun` at `:160`, durable mirror `:179-194`), 1 h TTL (`DEFAULT_LOCK_TTL_MS`, `:40`), token-gated clear (`mintLockClearConfirmationToken` `:312`, `clearLock` `:371`).
4. `RunRecordService` (`desktop-main/src/services/RunRecordService.ts:227`): `persist` (`:316`, log inline at or below 350 KiB `:103`, else S3), `writePreflightMarker` (`:439`), `getLogUrl` (`:489`), `listRuns` (`:555`), `approveRun` (`:604`); resolves the runs table from stack outputs or the pre-apply fallback (`:267-271`).
5. `AwsRunRecordStore` (`cloud-aws/src/AwsRunRecordStore.ts:85`): `pk = RUN` items keyed `<startedAt>#<runId>`, `status-index` GSI listing (`:295`), `LOCK/CURRENT` conditional-put lock (`:422-445`), S3 log offload and presign.
6. `LockClearConfirmationGate` (`desktop-main/src/services/LockClearConfirmationGate.ts:57`): generic mint/assert/consume single-use token bound to "what is locked now"; used by `RunService` and `PulumiService`'s Pulumi-lock clear.
7. `run-record.module.ts` (`desktop-main/src/modules/run-record.module.ts:44-52`): provides the two services and aliases them as `RUN_RECORD_PERSISTER` / `RUN_LOCK_SERVICE` for `PulumiService`.
8. `shared/src/runs.ts`: `RunRecord`, `RunKind` (`plan|apply|destroy`, `:14`), `RunStatus` (`success|failed|aborted`, `:24`), `deriveRunStatus` (`:205`), `APPROVAL_WINDOW_MS` and `isApprovalExpired` (`:261-277`), `RunDetailStatus`/`computeRunDetailStatus` (`:293`); plus `changeSummary.ts` (`ChangeSummary`, empty means "unavailable" `:46-54`) and `errors.ts` (`RunLockHeldError` `:57`, `OptimisticLockError` `:19`).
9. `IacPage` + `useIacRun` (`web/src/pages/iac.page.tsx:92`, `web/src/hooks/use-iac-run.hook.ts:181`): plan → stream → approve → plan-hash apply, approval countdown, partial-apply banner, busy / stale-lock / run-lock banners (`submission-banners.component.tsx:322`), destroy section (`iac-destroy-section.component.tsx:31`).
10. History and detail (`web/src/pages/iac-history.page.tsx:36`, `iac-run-detail.page.tsx:179`, `hooks/use-run-history.hook.ts:26`): paged list with server-side status filter and client-side kind filter, read-only detail with log ladder (replay → `logInline` → presigned S3 `fetch`), two-step rollback (`rollback-action.component.tsx:58`). Routes at `web/src/app.component.tsx:103-105`.

## Spec Coverage

| OpenSpec capability | requirements | scenarios | notes |
|---|---|---|---|
| `iac-plan-apply-page` | 8 | 21 | Partial-apply scenario holds on the live page only (record read locally); history loses it (finding 1). Gate order and atomic lock live in `PulumiService` (`iac/engine`). |
| `iac-destroy-flow` | 4 | 12 | Token mint/consume implemented in `PulumiService`, not via `LockClearConfirmationGate` (finding 6). |
| `iac-run-history` | 5 | 14 | Status filter server-side, kind filter client-side; partial badge in history never renders (finding 1). |
| `iac-rollback` | 5 | 10 | Gates side only here; restore + version listing cited from `deployment-config`. Confirm ack waits for the whole tagged plan (finding 8). |
| `orchestrator-integration-coverage` | 7 | 27 | Integration specs replace `PulumiService` wholesale, so gate logic is unit-tested, not integration-tested (finding 10). |

**OpenSpec summary:** 29 requirements / 84 scenarios carried across 5 OpenSpec capabilities.

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Run record and status | `IAC-RUN-REC-001` to `IAC-RUN-REC-009` | 9 | 0 | 0 |
| Runs table and log storage | `IAC-RUN-STORE-001` to `IAC-RUN-STORE-009` | 6 | 0 | 3 |
| Apply lock | `IAC-RUN-LOCK-001` to `IAC-RUN-LOCK-010` | 8 | 0 | 2 |
| Run-lock recovery | `IAC-RUN-LCLR-001` to `IAC-RUN-LCLR-008` | 7 | 0 | 1 |
| Plan submission and the IaC page | `IAC-RUN-PLAN-001` to `IAC-RUN-PLAN-010` | 10 | 0 | 0 |
| Approval | `IAC-RUN-APPR-001` to `IAC-RUN-APPR-007` | 6 | 0 | 1 |
| Apply gate | `IAC-RUN-GATE-001` to `IAC-RUN-GATE-015` | 15 | 0 | 0 |
| Partial apply | `IAC-RUN-PART-001` to `IAC-RUN-PART-005` | 3 | 0 | 2 |
| Destroy | `IAC-RUN-DSTR-001` to `IAC-RUN-DSTR-014` | 11 | 0 | 3 |
| Run history and listing | `IAC-RUN-HIST-001` to `IAC-RUN-HIST-009` | 8 | 0 | 1 |
| Run detail | `IAC-RUN-DETL-001` to `IAC-RUN-DETL-004` | 3 | 0 | 1 |
| Rollback | `IAC-RUN-RBK-001` to `IAC-RUN-RBK-010` | 9 | 0 | 1 |
| IPC surface and streaming | `IAC-RUN-IPC-001` to `IAC-RUN-IPC-009` | 8 | 0 | 1 |
| Integration coverage | `IAC-RUN-ITEST-001` to `IAC-RUN-ITEST-010` | 8 | 0 | 2 |

**Summary:** 111 of 129 active specs implemented; 0 deferred; 18 gaps.

## Key Findings

1. **`partialApply` is dropped by the DynamoDB store**: `RunRecordService.persist` and `writePreflightMarker` set it (`RunRecordService.ts:374`, `:459`), but `AwsRunRecordStore.putRecord` never writes it (`AwsRunRecordStore.ts:185-208`) and `toRunRecord` never reads it (`:336-374`). The live IaC page still shows the partial banner because `iac.runs.get` reads the local Pulumi run record (`iac-runs.controller.ts:224`, `iac.page.tsx:190`), but history and run detail read DynamoDB via `iac.runs.list` (`run-history-row.component.tsx:45`, `iac-run-detail.page.tsx:201`), so their "partial" badge can never appear and a pre-flight marker reads back as a plain `aborted` run. Resolves the sweep 5/7 disagreement in favour of sweep 7 for the durable store.
2. **Durable run lock skipped before the first apply**: `RunService.createRun` mirrors the lock to DynamoDB only when `getStackOutputs().runsTableName` is set (`RunService.ts:179-194`), and `releaseRun` and the durable lock lookup likewise (`:231`, `:272`); it has no pre-apply fallback, whereas `RunRecordService.resolveRunsTableName` (`RunRecordService.ts:267-271`) and the store's own config (`cloud-provider.module.ts:174-175`) do. The store can reach the table (created at bootstrap) but `RunService` never asks it to, so the first apply on a fresh install is guarded by the in-memory lock only, while the pre-flight marker is written durably.
3. **`listRuns` status query uses a reserved word unescaped**: `KeyConditionExpression: 'status = :status'` with no `ExpressionAttributeNames` (`AwsRunRecordStore.ts:302`); `status` is a DynamoDB reserved word, so the status-filtered path would be rejected by real DynamoDB. `[unverified]` against live AWS; the tests use a mocked client only (sweep 7 cites `AwsRunRecordStore.test.ts:544-552`).
4. **`getRecordByRunId` is an unbounded filtered query**: it pages the whole `pk = RUN` partition with a `FilterExpression` on `runId` (`AwsRunRecordStore.ts:232-252`); acknowledged in its TSDoc as acceptable at current volume. The renderer's run-detail page does its own lookup by scanning the newest 200 records (`iac-run-detail.page.tsx:22`, `:49-53`), so runs older than that render as not found.
5. **Destroy output is not env-redacted**: preview and apply push chunks through `redactEnvironmentValues` (`PulumiService.ts:1648`, `:2297`) but destroy's chunk setup pushes raw lines (`PulumiService.ts:3026-3037`). Whether destroy output actually contains game env values is `[inferred]`, not observed.
6. **Destroy token is hand-rolled next to a generic gate**: `LockClearConfirmationGate` (`LockClearConfirmationGate.ts:1-12`, `:57`) was factored out for the Pulumi-lock and run-lock clears, but `mintDestroyConfirmationToken` (`PulumiService.ts:2734`) keeps its own single-use, target-bound token logic. `LockClearConfirmationGate` also has no co-located test.
7. **Approval window duplicated in the renderer with a contradicted reason**: `iac.page.tsx:41-53` copies `APPROVAL_WINDOW_MS` / `isApprovalExpired` "rather than importing `@hyveon/shared` into the renderer bundle", yet the same file imports `errMessage` from `@hyveon/shared` (`iac.page.tsx:6`) and `submission-banners.component.tsx:4` imports `formatRelativeAge` from it; both are exported from the barrel (`shared/src/index.ts:19,27`).
8. **Rollback confirm acks only after the whole plan**: `iac.rollback.confirm` drives `confirmRollback` to completion before returning `{ confirmed, versionId }` (`iac.controller.ts:1236-1293`), and its chunk channel `iac.rollback.confirm.chunk` (`iac.controller.ts:56`) has no subscriber in `desktop-preload` or `web/src`. The renderer then navigates to `/iac` and the page auto-submits a plan (`iac.page.tsx:134`, sweep 3); sweep 6 reports two run records per rollback (`iac.controller.ts:1205-1209`) `[unverified]`.
9. **`iac.controller.ts` carries three near-identical streaming loops**: plan, apply and destroy each hand-roll the ack + chunk + end loop (`iac.controller.ts:766-792`, `:890-921`, `:1032-1063` per sweep 6; `[unverified]` line-exact), mirrored by three chunk-streaming setups in `PulumiService` (`:1635-1713`, `:2285-2405`, `:3026-3140`). Meets the repo's duplication threshold (≥3 occurrences).
10. **Integration coverage does not exercise the gate it names**: `iac-apply-gates.spec.ts:30-41` states the DI stub fully replaces `PulumiService`, so the 8-step gate math is only unit-tested (`PulumiService.apply.test.ts`, owned by `iac/engine`) and the spec checks controller ack-shaping. `orchestrator-integration-coverage` requires the suite to "verify `iac.apply`'s pre-spawn gates", including the atomic-lock ordering scenario; this is a spec/test-shape mismatch to resolve in EARS.
11. **`iac.output` ignores `force`**: documented as accepted-for-compatibility and ignored (`iac.controller.ts:1076-1078`, `:1088`).
12. **Stale vocabulary in run code**: `RunService.ts:3` cites issue #106 and `:139,144` say `runs_table_name` (the field is `runsTableName`); `runs.ts:4-13` explains the pre-Pulumi `plan/apply/destroy` naming; `errors.ts:53-55` refers to "the HTTP layer can respond `409 Conflict`" though the app has no HTTP transport.
13. **History kind filter is client-side over a server page**: `iac-history.page.tsx:29-30` filters `kind` after fetching a status-filtered page, so a kind-filtered view can show a short or empty page while older matching runs exist until "Load more" is used `[inferred]`. Sweep 3's claim that the status filter "omits other statuses" is refuted: the dropdown lists all three `RunStatus` values (`iac-history.page.tsx:82-84`, `runs.ts:24`).
14. **`formatLockAge` duplication already resolved**: sweep 3's note that `submission-banners.component.tsx:196-200` duplicates a desktop-main counterpart is stale; both it and `PulumiLockRecovery.ts:325` are adapters over `formatRelativeAge` (`shared/src/relativeTime.ts:16`).

## Work Required

Spec IDs cite the open (`[ ]`) gap specs in `docs/intent/iac/run/run-specs.md`; items with no matching gap spec carry none.

### Must Fix
1. Persist and restore `partialApply` in `AwsRunRecordStore.putRecord`/`toRunRecord`, with a store test (finding 1). (specs: `IAC-RUN-STORE-007`, `IAC-RUN-STORE-008`, `IAC-RUN-PART-005`)
2. Give `RunService.createRun`, `releaseRun` and the durable lock lookup the same pre-apply runs-table fallback `RunRecordService` uses, so the first apply on a fresh install holds the durable lock (finding 2; `iac-design.md`, decision 4). (specs: `IAC-RUN-LOCK-009`)
3. Escape `status` with `ExpressionAttributeNames` in the status-filtered `listRuns` query and verify against real DynamoDB (finding 3). (specs: `IAC-RUN-HIST-004`)

### Should Fix
4. Redact env values in destroy output and add a test (finding 5). (specs: `IAC-ENGINE-REDACT-002`, owned by `iac/engine`)
5. Move the destroy token onto `LockClearConfirmationGate` and add a gate test (finding 6). (specs: `IAC-RUN-DSTR-014`, `IAC-RUN-LCLR-008`)
6. Import `APPROVAL_WINDOW_MS`/`isApprovalExpired` from `@hyveon/shared` in `iac.page.tsx` (finding 7). (specs: `IAC-RUN-APPR-006`)
7. Extract the shared streaming loop in `iac.controller.ts` and the chunk setup in `PulumiService` (finding 9). (specs: `IAC-RUN-IPC-008`)
8. Decide whether rollback confirm should stream its plan or drop the unused chunk channel (finding 8). (specs: `IAC-RUN-RBK-010`)
9. Reconcile `orchestrator-integration-coverage` with the stub-replaces-`PulumiService` harness (finding 10). (specs: `IAC-RUN-ITEST-005`, `IAC-RUN-ITEST-007`)
10. Replace the 200-record client-side lookup in run detail with a get-by-id call (finding 4). (specs: `IAC-RUN-DETL-004`)
11. Split `PulumiService.ts` along the run/engine seam so this leaf's run gates, locking and run lifecycle sit in files separate from `iac/engine`'s plumbing, as its own pure-refactor change with no behaviour change; this removes the `run` <-> `engine` cycle in `docs/arrows/index.yaml` (`iac-design.md`, decision 10). Tracked with the matching Should Fix item in `docs/arrows/iac/engine.md`.

### Nice to Have
12. Remove stale issue numbers, `runs_table_name` and HTTP references (finding 12). (specs: `IAC-RUN-STORE-009`)
13. Drop or honour the ignored `force` on `iac.output` (finding 11).
14. Server-side kind filter or a clearer empty state on history (finding 13).
