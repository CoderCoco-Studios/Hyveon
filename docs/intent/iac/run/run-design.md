---
parent: iac
prefix: IAC-RUN
---

# IaC Run Lifecycle

## Context and Design Philosophy

Every Pulumi preview, up and destroy the operator starts from the desktop app is tracked as a *run*: a `runId`, a durable `RunRecord` in the runs table, a captured log, and (for apply and destroy) a durable apply lock that keeps two runs from mutating the same stack at once. This leaf owns that lifecycle and the operator screens that drive and inspect it: the IaC page (plan, approve, apply, destroy), Run History, and run detail with rollback.

The run vocabulary predates Pulumi. `RunKind` is still `plan | apply | destroy` and a Pulumi `preview` is recorded as `plan`, an `up` as `apply` (`app/packages/shared/src/runs.ts:3-14`). `RunStatus` is `success | failed | aborted` and is never set directly: it is derived from the exit code by `deriveRunStatus` (`runs.ts:205-210`). There is no `pending` status because a record is only written once a run has finished (`runs.ts:16-24`); the one exception is the apply pre-flight marker described below.

What this leaf owns:

- The run-record and apply-lock contract (`shared/src/runs.ts`, `shared/src/errors.ts`, `shared/src/changeSummary.ts`) and its DynamoDB + S3 implementation (`cloud-aws/src/AwsRunRecordStore.ts`).
- The desktop-main services that write and read it (`RunService`, `RunRecordService`, `LockClearConfirmationGate`) and the two IPC controllers that expose it (`iac.controller.ts`, `iac-runs.controller.ts`).
- The renderer pages, hooks and components for plan/apply/destroy, history, run detail and rollback.

What it deliberately does not own:

- **The gates themselves.** The 8-step apply gate, preview, destroy token, rollback restore-then-plan, partial-apply detection, env redaction and Pulumi backend lock recovery physically live in `PulumiService.ts`, owned by `iac/engine`. This leaf specifies what those gates must guarantee to a run; `iac/engine` specifies how Pulumi is driven.
- **The resources being deployed.** That is `iac/program`.
- **The configuration being rolled back to.** Version listing and `restoreRawConfig` belong to `deployment-config`; this leaf only owns the rollback gates and the `rolledBackFrom` provenance.
- **The bridge and the composition root.** `window.hyveon.iac.*`, `SELF_BRIDGED_PATTERNS` and payload validation belong to `operator-app/ipc-bridge`; binding `RUN_RECORD_STORE` (with its pre-apply table-name fallback, `cloud-provider.module.ts:174-175`) belongs to `operator-app/desktop-shell`.

CLAUDE.md invariants that live here:

- **The desktop app has no HTTP transport.** Every run channel is an Electron IPC `@MessagePattern`; streaming channels are self-bridged (`desktop-main/src/ipc-main-bridge.ts:27-37`). `errors.ts:53-55` still speaks of an "HTTP layer" returning `409 Conflict`; that comment is stale.
- **Every IPC handler logs on entry** (`.claude/rules/logging.md`): each handler in both controllers starts with `logger.debug('IacController: <pattern> invoked')` (for example `iac.controller.ts:720`).
- **`@hyveon/shared`'s barrel stays free of new AWS SDK imports.** `runs.ts` is pure types and pure functions; all SDK use is in `AwsRunRecordStore`.

## Run Record and Storage

A run exists in two places with different lifetimes, and the code reads from each deliberately.

| Store | Where | Written by | Read by |
|---|---|---|---|
| Local `run.json` + log | `<runsDir>/<runId>/` on the operator's machine | `PulumiService.writeRunRecord` (`iac/engine`) | `iac.runs.get` (`iac-runs.controller.ts:224`), `iac.runs.logs` replay (`:257-313`), rollback confirm's version lookup (`iac.controller.ts:1264`) |
| DynamoDB runs table | `pk = RUN`, `sk = <startedAt>#<runId>` (`runs.ts:190-192`, `AwsRunRecordStore.ts:23`) | `RunRecordService.persist` / `writePreflightMarker` / `approveRun` | apply gate lookup, `iac.runs.list`, history, run detail, rollback resolve |
| S3 run log | `runs/<runId>.log` in the configuration bucket (`AwsRunRecordStore.ts:57-59`) | `persist` when the log exceeds 350 KiB (`RunRecordService.ts:103`, `:343-356`) | `iac.runs.logUrl` presigned GET, 1 h default (`AwsRunRecordStore.ts:47`, `:401-407`) |

The runs table is created by the AWS SDK at wizard-bootstrap time, not by Pulumi (`RunRecordService.ts:1-6`). Its name is resolved per call: stack outputs first, then `resolvePreApplyRunsTableName` reading the persisted deployment config, so the very first plan/apply cycle on a fresh install can persist records (`RunRecordService.ts:243-271`).

### RunRecord fields

| Field | Set by | Notes |
|---|---|---|
| `sk`, `runId`, `kind`, `status`, `startedAt`, `completedAt`, `exitCode` | `persist` (`RunRecordService.ts:361-368`) | `status` always `deriveRunStatus(exitCode)`; `exitCode: null` means aborted. |
| `configVersionId`, `planHash`, `engineVersion` | `persist`, `writePreflightMarker` | The apply gate compares all three against reality (`PulumiService.ts:1857-1872`). |
| `approvedBy`, `approvedAt` | `approveRun` only (`RunRecordService.ts:634-638`) | Plan records only; approver is the local OS username, resolved server-side (`iac.controller.ts:1359-1361`). |
| `logInline` xor `logS3Key` | `persist` | Mutually exclusive by construction (`RunRecordService.ts:328-357`). |
| `rolledBackFrom` | `persist` from the rollback plan | Provenance only; no separate run kind (`runs.ts:88-97`). |
| `changeSummary` | `persist` | `{}` means "summary event missed", not "no changes" (`changeSummary.ts:46-54`). |
| `partialApply` | `persist`, `writePreflightMarker` | Additive flag instead of a fourth `RunStatus`, because `status` is the `status-index` GSI hash key (`runs.ts:128-161`). **Not persisted by the AWS store today**: `putRecord` omits it (`AwsRunRecordStore.ts:185-208`) and `toRunRecord` never reads it (`:336-374`). |

The partialApply gap has a concrete consequence. The local `run.json` keeps the flag, so the live IaC page's partial banner works (`iac.page.tsx:190` via `iac.runs.get`). Everything reading DynamoDB loses it: the history and detail "partial" badge (`run-history-row.component.tsx:45`, `iac-run-detail.page.tsx:201`) can never render, contradicting `docs/docs/app/iac.md:155` and `:283`, and the pre-flight marker reads back as a plain `aborted` apply. The apply gate still blocks a retry because the record's `kind` is `apply`, not `plan`, but it throws the generic `PulumiPlanRunWrongKindError` instead of `PulumiPartialApplyRetryBlockedError` (`PulumiService.ts:2026-2041`); `docs/docs/app/iac.md:176-178` documents that fallback as if it were a rare case.

### Persistence semantics

`persist` is best-effort by design: every failure (unreadable log file, S3 offload, `putRecord`) is logged at `warn` and swallowed so a history write can never fail a Pulumi run that succeeded (`RunRecordService.ts:14-18`, `:330-386`). Its `finally` always releases the apply lock for the same `runId` (`:387-389`), which is how apply and destroy release their lock. Plan never acquires the durable lock, so its `persist` call performs a harmless release: the in-memory check misses and the conditional delete on `runId` is swallowed (`RunService.ts:225-246`, `AwsRunRecordStore.ts:485-501`).

`writePreflightMarker` is the opposite: fail-closed. It writes `kind: 'apply', status: 'aborted', exitCode: null, partialApply: true` under the same `sk` the settlement will later use, before `stack.up()`, and throws on any failure so the apply aborts instead of running unmarked (`RunRecordService.ts:392-475`). It bypasses `persist` on purpose, because `persist`'s `finally` would release the lock the apply has just taken (`:426-432`).

`approveRun` reads the record by `runId`, requires `kind === 'plan'` and `status === 'success'`, and rewrites the whole item with `approvedBy`/`approvedAt` via an unconditional `PutCommand` (`RunRecordService.ts:604-651`, `AwsRunRecordStore.ts:185-209`). Because that put rebuilds the item from the in-memory record and the store drops `partialApply`, any field the store does not round-trip is lost on approval too.

### Lookup and listing

`getRecordByRunId` queries the whole `pk = RUN` partition newest-first with a `FilterExpression` on `runId`, paging until a match (`AwsRunRecordStore.ts:232-252`). Because an apply shares its plan's `runId` (`PulumiService.ts:2106`) and is started later, the newest match for an applied plan is the apply record; this is what makes the gate see `kind !== 'plan'` after an apply attempt.

`listRuns` clamps `limit` to `[1, 100]`, default 25 (`RunRecordService.ts:105-131`). Unfiltered it queries the base table with an `sk < before` cursor; with a status filter it queries the `status-index` GSI (hash `status`, range `startedAt`) and rebuilds the GSI `ExclusiveStartKey` from the cursor `sk` (`AwsRunRecordStore.ts:295-326`). The GSI condition is written `status = :status` with no `ExpressionAttributeNames` (`:302`); `status` is a DynamoDB reserved word, so this path would appear to be rejected by real DynamoDB. The unit tests use a mocked client only. Kind filtering is applied client-side to the fetched page (`iac-history.page.tsx:29-30`), an accepted trade-off at this project's run volume (`openspec/changes/archive/2026-07-26-add-terraform-run-ui/design.md:50`). Run detail finds its record by scanning the newest 200 records client-side (`iac-run-detail.page.tsx:22`, `:49-53`), so older runs render as not found.

## Apply Lock

`RunService` owns one apply lock with two layers (`RunService.ts:1-22`).

1. **In-memory `currentLock`.** `createRun` checks and sets it synchronously, before its first `await`, so two calls in the same process are serialised by the JS event loop without a mutex (`RunService.ts:160-177`).
2. **Durable `LOCK/CURRENT` item** in the runs table, acquired with `attribute_not_exists(pk) OR expiresAt < :now` (`AwsRunRecordStore.ts:422-447`). On `ConditionalCheckFailedException` the store reads the holder and throws `RunLockHeldError(holder)`; `createRun` rolls back its in-memory lock and rethrows (`RunService.ts:181-193`). The lock item has no `status` attribute, so it stays out of the `status-index` GSI.

The lock lives `DEFAULT_LOCK_TTL_MS` = 1 h (`RunService.ts:40`), long enough for the longest expected apply while bounding how long a crashed run can wedge it (`RunService.ts:32-39`). Expiry is evaluated lazily by `isRunLockExpired` (`runs.ts:250-252`); nothing sweeps the item.

Which operations take which lock:

| Operation | Workspace guard (`operationInFlight`, in-process) | Durable apply lock (`RunService.createRun`) |
|---|---|---|
| plan (`preview`) | yes (`PulumiService.ts:1451-1466`) | no |
| apply (`up`) | yes, set only after gate step 8 (`:2165`) | yes, gate step 8 (`:2105`) |
| destroy | yes (`:3007`) | yes, after the token check (`:2959`) |
| rollback confirm | yes, `'rollback'` (`:3595`) | no |

`RunService`'s file comment and `runs.ts:212-224` both say the lock guards plan/apply/destroy; the code and `docs/docs/app/iac.md:200-201` agree that plan does not take it. The `iac-rollback` spec requires "the shared operation lock" to be held across restore and plan (`openspec/specs/iac-rollback/spec.md:41`); today that is only the in-process `operationInFlight` guard.

**Fresh-install gap.** `createRun`, `releaseRun` and `resolveCurrentLock` consult the durable lock only when `getStackOutputs().runsTableName` is set (`RunService.ts:179`, `:231`, `:272`). They have no pre-apply fallback, whereas `RunRecordService.resolveRunsTableName` and the store's own config do. So before the first successful apply the durable lock is skipped and only the in-memory lock guards the run, while the pre-flight marker in the same apply is written durably. `RunService.ts:16-21` describes this skip as intentional, but the reason it gives ("table not deployed") is no longer true since the table is created at bootstrap.

### Operator lock recovery

A stuck lock surfaces reactively: only after an apply or destroy submission is refused with `RunLockHeldError`, whose holder the ack carries as `runLock` (`iac.controller.ts:838`, `:994`) and the busy banner renders with a "Clear lock and retry" action (`submission-banners.component.tsx:322`). Recovery is two calls:

| Channel | Service call | Contract |
|---|---|---|
| `iac.runs.lock.clear.mintToken` (`iac-runs.controller.ts:373`) | `RunService.mintLockClearConfirmationToken(expectedRunId)` (`RunService.ts:312-325`) | Refuses with `RunLockChangedError` if the held lock is no longer the one the operator saw. |
| `iac.runs.lock.clear` (`iac-runs.controller.ts:406`) | `RunService.clearLock(token)` (`RunService.ts:371-376`) | Token must be fresh (5 min, `:49`), unconsumed, and still bound to the current `runId`; then reuses `releaseRun`. |

The token logic is `LockClearConfirmationGate<string>` bound on `runId` (`RunService.ts:113-116`): one pending token per process, a new mint supersedes the old, a failed assert never consumes, a success consumes (`LockClearConfirmationGate.ts:57-110`). `PulumiService` uses the same gate for the Pulumi backend lock; its destroy token is a separate hand-rolled implementation (`PulumiService.ts:2734`).

## Run Submission and Streaming

### IPC surface

| Channel | Bridge | Ack / result | Owner |
|---|---|---|---|
| `iac.plan` | self-bridged | `{ started, runId? , error?, conflict?, staleLock? }` (`iac.controller.ts:715-795`) | `IacController` |
| `iac.approve` | generic | `{ approved, approvedBy?, approvedAt?, error? }` (`:1104-1141`) | `IacController` |
| `iac.apply` | self-bridged | as plan, plus `runLock` on `RunLockHeldError` (`:815-923`) | `IacController` |
| `iac.destroy.mintToken`, `iac.destroy` | generic, self-bridged | token string; ack as apply (`:941`, `:971-1065`) | `IacController` |
| `iac.rollback.resolve` | generic | target version + best-effort diff (`:1162`) | `IacController` |
| `iac.rollback.confirm` | self-bridged | `{ confirmed, versionId?, error? }` after the whole plan (`:1219-1300`) | `IacController` |
| `iac.lock.clear.mintToken`, `iac.lock.clear` | generic | Pulumi backend lock recovery (`:953`, `:1332`) | `IacController` (logic in `iac/engine`) |
| `iac.output` | generic | stack outputs; `force` accepted and ignored (`:1076-1088`) | `IacController` |
| `iac.runs.get` | generic | `{ found, status: RunDetailStatus, record }` from local `run.json` (`iac-runs.controller.ts:208-250`) | `IacRunsController` |
| `iac.runs.logs` | self-bridged | `{ streamId }`, then `iac.runs.logs.chunk` / `.end` (`:257-313`) | `IacRunsController` |
| `iac.runs.list`, `iac.runs.logUrl` | generic | `RunPageResult`; presigned URL (`:316`, `:337`) | `IacRunsController` |

Every mutating channel returns an immediate ack. A refused submission is modelled in the ack (`started: false` plus `conflict`, `staleLock` or `runLock`), not thrown, so the renderer can choose the right banner. `conflict` is populated identically for the in-process busy refusal and for `RunLockHeldError` (`iac.controller.ts:838-848`).

### Streaming as it actually works

The controller's plan, apply and destroy handlers each pull the service generator's first step before acking, then fire-and-forget a loop that sends every chunk on a fixed `iac.<op>.chunk` channel and a terminal message on `iac.<op>.end` (`iac.controller.ts:733-792`; apply and destroy repeat the same loop). **Nothing subscribes to those channels.** The preload says so (`desktop-preload/src/hyveon-api.ts:2333-2339`) and neither preload nor `web/src` references them. The loops therefore function only as the generator's driver; operator-visible output comes from `iac.runs.logs`, which replays the run's buffered output from `PulumiService.streamRunOutput` and follows it live, giving reattach-after-reload for free (`add-terraform-run-ui/design.md`, Decision 1). `iac.rollback.confirm.chunk` is likewise unsubscribed, which its own comment acknowledges (`iac.controller.ts:44-55`).

### Renderer state machine

`useIacRun(kind)` is instantiated three times on `IacPage`, once per operation (`use-iac-run.hook.ts:162-181`). Each instance holds `runId`, terminal `status`, `record`, and the `conflict` / `staleLock` / `runLock` / `submitError` banner state; `submit` resets all of them (including `record`, so a stale `partialApply` cannot flash) before calling the channel (`:146-158`, `:166-174`). When the log stream ends it calls `iac.runs.get` once and treats `found: false` as an error for every kind (`:199-215`).

The operator-visible lifecycle, with `RunDetailStatus` from `computeRunDetailStatus` (`runs.ts:280-346`):

```
plan submitted ── running ──▶ success ──▶ awaiting_approval ──approve──▶ approved (15 min window)
      │                        │                                              │
      │                        └▶ failed / aborted                            └─apply(planHash)──▶ running ──▶ success | failed | aborted (+partialApply)
      └▶ refused (conflict | staleLock)                                                 └▶ refused (gate error | conflict | runLock | staleLock)
```

`running` is computed from the in-memory lock only (`iac-runs.controller.ts:219`), so after an app restart a run still holding the durable lock does not show as running. `awaiting_approval` depends on `planArtifactExists`; `runs.ts:309-321` notes nothing deletes the artifact, so the transition out of it relies on the apply overwriting the local `run.json` with `kind: 'apply'`. The same comment still calls the artifact `.tfplan`.

The approval countdown uses a local copy of `APPROVAL_WINDOW_MS` / `isApprovalExpired` (`iac.page.tsx:41-53`). Its justification (avoid importing `@hyveon/shared` into the renderer) is contradicted by the same file importing `errMessage` from `@hyveon/shared` (`iac.page.tsx:6`). The authoritative check is server-side, gate step 4 (`PulumiService.ts:2046`).

### Rollback flow

Rollback is offered on apply rows in Run History (`run-history-row.component.tsx:56`). `iac.rollback.resolve` names the target version (read-only); `iac.rollback.confirm` runs `PulumiService.confirmRollback`, which under the `'rollback'` workspace guard restores the historic configuration as a new head and then runs a full preview tagged `rolledBackFrom: applyRunId` (`PulumiService.ts:3580-3651`). If that plan fails after the restore, the orphaned restore is recorded and surfaced (`:3632-3647`), meeting the spec's "never leave an unreviewed head" rule (`iac-rollback/spec.md:41`, `:48-51`).

On a confirmed ack the history page navigates to `/iac` with `{ configVersionId, rolledBackFrom }` (`iac-history.page.tsx:43-48`) and `IacPage` immediately submits **another** plan against the same restored version, also tagged (`iac.page.tsx:130-135`). A rollback therefore produces two tagged plan records; the operator approves the second, and the first stays `awaiting_approval`. This is a drift from the archived design, where the restore happened first and the renderer's plan was the only plan (`add-terraform-run-ui/design.md`, Decision 6); the in-service plan was added later to make restore and plan one guarded unit, and the renderer half was never removed `[inferred]`.

## Test Shape

Unit tests cover the services, store and controllers directly (`RunService.test.ts`, `RunRecordService.test.ts`, `AwsRunRecordStore.test.ts`, both controller tests). The Playwright tier-2 integration specs run the real controllers against a DI stub that replaces `PulumiService` wholesale (`web/e2e/integration-specs/iac-apply-gates.spec.ts:30-41`), so they verify ack shaping, not the gate arithmetic, which is unit-tested in `iac/engine`'s `PulumiService.apply.test.ts`. `orchestrator-integration-coverage` asks the integration suite to verify `iac.apply`'s pre-spawn gates including lock ordering; the harness as built cannot. `LockClearConfirmationGate` has no co-located test; it is exercised only through `RunService` and `PulumiService` tests.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Run vocabulary | Keep `plan/apply/destroy` after the Pulumi move | Rename to `preview/up/destroy` | Avoids a data migration of persisted records and GSI keys (`runs.ts:3-13`); `[inferred]` beyond the comment's statement that it was "deliberately not renamed". |
| Status source of truth | Derive `status` from `exitCode` | Set status explicitly per call site | `status` "can't drift out of sync" with the exit code (`runs.ts:194-197`). |
| Partial apply representation | Additive `partialApply` flag | A fourth `RunStatus` value | `RunStatus` is the GSI hash key, so widening it is an infra change (`runs.ts:135-139`). |
| Two-layer apply lock | Synchronous in-memory lock + conditional-put DynamoDB item | In-memory only; DynamoDB only | In-memory gives race-free same-process exclusion without a mutex; DynamoDB adds restart durability and multi-process safety (`RunService.ts:1-22`). |
| Lock expiry | 1 h TTL evaluated lazily | Heartbeat/renewal; DynamoDB TTL attribute | Bounds a crashed run's wedge without a background process (`RunService.ts:32-39`); alternatives `[inferred]`, none evidenced. |
| Persistence failure policy | `persist` best-effort, marker fail-closed | Both throw; both swallow | History must never fail a good run (`RunRecordService.ts:14-18`); the marker exists to block blind retries so it must not be skipped (`:392-438`). |
| Log storage | Inline at or below 350 KiB, else S3 | Always S3; always inline | Stays under DynamoDB's 400 KB item limit with headroom (`RunRecordService.ts:95-103`); always-S3 alternative `[inferred]`. |
| Run listing | Base-table partition for all, `status-index` GSI for status, kind client-side | Scan; a kind GSI | No scan and no new index at this run volume (`add-terraform-run-ui/design.md`, Decision 3 and risk at `:50`). |
| Renderer output path | `iac.runs.logs` replay+follow | Per-operation chunk bridges in preload | Reuses the service's buffering and survives reload (`add-terraform-run-ui/design.md`, Decision 1). The per-op channels were kept in the controller anyway. |
| Run-detail log ladder | Local replay, then `logInline`, then presigned S3 URL | Always read from DynamoDB/S3 | A wiped `runsDir` degrades gracefully; only a secret-free URL crosses the bridge (`add-terraform-run-ui/design.md`, Decision 4). |
| Rollback model | Restore as new head, then a normal tagged plan through all gates | Plan directly against the historic version; a `rollback` run kind | History stays append-only and the stale-config gate keeps working unchanged (`add-terraform-run-ui/design.md`, Decisions 6 and 7). |
| Destroy confirmation | Server-minted single-use token + typed phrase in UI | UI phrase only | The UI check is defence in depth, never the only barrier (`add-terraform-run-ui/design.md:52`, Decision 8). |
| Lock-clear discovery | Reactive, only after a `RunLockHeldError` refusal | Proactive `iac.runs.lockStatus` channel | Mirrors the Pulumi-lock banner precedent; proactive deferred (`add-run-lock-recovery/design.md`, D1). |
| Lock-clear token binding | Bound to the held `runId`, own 5 min TTL | Bound to "a lock exists"; share Pulumi's TTL constant | A delayed confirm must never clear a different run's lock; the two locks tune independently (`add-run-lock-recovery/design.md`, D2, D3). |
| Approver identity | Local OS username resolved server-side | Caller-supplied identity | An IPC caller cannot spoof the approver (`iac.controller.ts:1097-1099`). |

## Open Questions & Future Decisions

### Resolved

1. ✅ Rollback is restore-as-new-head plus a tagged plan, not a new run kind (`add-terraform-run-ui/design.md`, Decisions 6 and 7).
2. ✅ Stuck run locks are recovered reactively, with a `runId`-bound confirmation token reusing `releaseRun` (`add-run-lock-recovery/design.md`, D1 to D5).
3. ✅ Kind filtering stays client-side unless run volume grows (`add-terraform-run-ui/design.md:50`).

### Deferred

1. Should `AwsRunRecordStore.putRecord`/`toRunRecord` round-trip `partialApply` (`AwsRunRecordStore.ts:185-208`, `:336-374`)? Until they do, history and detail never show "partial", the marker reads as plain `aborted`, and the gate throws the generic wrong-kind error. Sweeps disagreed on durability; the code shows it is not durable.
2. Should `RunService` resolve the runs table with the same pre-apply fallback as `RunRecordService` (`RunService.ts:179`, `:231`, `:272` vs `RunRecordService.ts:267-271`), or should the spec state that the first apply on a fresh install is guarded in-memory only? Sweeps 5 and 6 disagreed; both are describing real code paths.
3. Does the status-filtered `listRuns` query fail against real DynamoDB because `status` is unescaped (`AwsRunRecordStore.ts:302`)? Needs a live check and an `ExpressionAttributeNames` fix.
4. Should plan and rollback confirm take the durable apply lock, as `RunService.ts:1-4`, `runs.ts:212-224` and `iac-rollback/spec.md:41` imply, or should those texts be corrected to match `docs/docs/app/iac.md:200-201`?
5. Should a rollback produce one plan or two (`PulumiService.ts:3631` plus `iac.page.tsx:130-135`)? Either drop the renderer's auto-submit and show the in-service plan, or drop the in-service plan.
6. Should `iac.rollback.confirm` stream its plan to the renderer, or should `iac.rollback.confirm.chunk` be removed (`iac.controller.ts:44-56`)?
7. The `iac.plan/apply/destroy` `.chunk`/`.end` sends have no subscriber (`hyveon-api.ts:2333-2339`). Remove them, or keep them and extract the three near-identical loops in `iac.controller.ts` (and the matching chunk setup in `PulumiService`) per the duplication rule?
8. Should destroy output pass through `redactEnvironmentValues` like preview and apply (`PulumiService.ts:1648`, `:2297` vs `:3026-3037`)? Whether destroy output carries env values is unobserved.
9. Should the destroy token move onto `LockClearConfirmationGate` (`PulumiService.ts:2734`), and should the gate get a co-located test?
10. Should `iac.page.tsx:41-53` import `APPROVAL_WINDOW_MS`/`isApprovalExpired` from `@hyveon/shared` instead of copying them?
11. Should run detail use a get-by-id channel instead of scanning the newest 200 records (`iac-run-detail.page.tsx:22`, `:49-53`), and should `getRecordByRunId` stop paging the whole partition with a filter (`AwsRunRecordStore.ts:232-252`)?
12. How should `orchestrator-integration-coverage`'s "verify `iac.apply`'s pre-spawn gates" requirement be reconciled with a harness that stubs `PulumiService` out (`iac-apply-gates.spec.ts:30-41`)? Resolve in EARS by either narrowing the requirement or pointing it at the unit tests.
13. `approveRun` rewrites the whole item unconditionally (`RunRecordService.ts:640-641`). Should it be a conditional update so a concurrent settlement or second approval cannot be overwritten?
14. Should `iac.runs.get` report `running` from the durable lock too, so a run held across an app restart is not shown as finished (`iac-runs.controller.ts:219`)?
15. Should `iac.output` drop its ignored `force` field (`iac.controller.ts:1076-1088`)?
16. Should `RunRecord` gain an initiator field for history (open in `add-terraform-run-ui/design.md`, Open Questions)?
17. Stale vocabulary to clean: issue number at `RunService.ts:3`, `runs_table_name` in `RunService.ts:139-144` and `RunRecordService.ts:54`, `.tfplan` in `runs.ts:310-315`, "HTTP layer ... 409" in `errors.ts:53-55`.

## References

- Arrow doc: `docs/arrows/iac/run.md`
- EARS specs (wave 3, not yet written): `docs/intent/iac/run/run-specs.md`
- OpenSpec: `openspec/specs/iac-plan-apply-page/spec.md`, `openspec/specs/iac-destroy-flow/spec.md`, `openspec/specs/iac-run-history/spec.md`, `openspec/specs/iac-rollback/spec.md`, `openspec/specs/orchestrator-integration-coverage/spec.md`
- Archived design rationale: `openspec/changes/archive/2026-07-26-add-terraform-run-ui/design.md`, `openspec/changes/archive/2026-08-10-add-run-lock-recovery/design.md`
- Operator docs: `docs/docs/app/iac.md`, `docs/docs/components/management-app.md`, `docs/docs/components/integration-tests.md`
- Neighbouring leaf designs (not yet written): `docs/intent/iac/engine/engine-design.md`, `docs/intent/iac/program/program-design.md`, `docs/intent/deployment-config/deployment-config-design.md`, `docs/intent/operator-app/ipc-bridge/ipc-bridge-design.md`, `docs/intent/operator-app/desktop-shell/desktop-shell-design.md`
