# Arrow: task-and-dns

Start and stop a game's container on demand, publish its address in DNS while it runs, and show its live status and estimated cost on the dashboard.

## Status

**MAPPED** — mapped 2026-10-30 (git SHA `5c55a380`), not yet audited. Core start/stop/status and the update-dns Lambda work as the cost model requires; the leaf carries a provider that reads its region from stack outputs instead of `ConfigService.getRegion()`, an orphaned-record risk in DNS DELETE, and cost/status types declared in several places.

## References

### HLD
- `docs/high-level-design.md`
- `docs/intent/game-runtime/game-runtime-design.md` (sub-HLD)

### LLD
- `docs/intent/game-runtime/task-and-dns/task-and-dns-design.md`

### EARS
- `docs/intent/game-runtime/task-and-dns/task-and-dns-specs.md` (78 specs)

### Tests
- app/packages/cloud-aws/src/AwsCloudProvider.test.ts
- app/packages/desktop-main/src/controllers/costs.controller.test.ts
- app/packages/desktop-main/src/services/CostService.test.ts
- app/packages/desktop-main/src/services/EcsService.test.ts
- app/packages/lambda/update-dns/src/handler.test.ts
- app/packages/shared/src/aws/ecsTask.test.ts
- app/packages/shared/src/cloud.test.ts
- app/packages/web/e2e/integration-specs/error-propagation.spec.ts
- app/packages/web/e2e/integration-specs/start-stop.spec.ts
- app/packages/web/e2e/integration-specs/status-polling.spec.ts
- app/packages/web/e2e/specs/costs.spec.ts
- app/packages/web/e2e/specs/dashboard.spec.ts
- app/packages/web/src/components/game-card.component.test.tsx
- app/packages/web/src/components/kpi-strip.component.test.tsx
- app/packages/web/src/pages/costs.page.test.tsx
- app/packages/web/src/pages/dashboard.page.test.tsx
- app/packages/web/src/polling/game-status-provider.component.test.tsx

### Code

**cloud-aws**
- app/packages/cloud-aws/src/AwsCloudProvider.ts

**desktop-main**
- app/packages/desktop-main/src/controllers/costs.controller.ts
- app/packages/desktop-main/src/modules/aws.module.ts
- app/packages/desktop-main/src/services/CostService.ts
- app/packages/desktop-main/src/services/EcsService.ts
- app/packages/desktop-main/src/test-mocks/ecs-mock.ts (test infra)

**lambda/update-dns**
- app/packages/lambda/update-dns/esbuild.config.mjs
- app/packages/lambda/update-dns/package.json
- app/packages/lambda/update-dns/src/handler.ts
- app/packages/lambda/update-dns/tsconfig.json

**shared**
- app/packages/shared/src/aws/ecsTask.ts
- app/packages/shared/src/cloud.ts
- app/packages/shared/src/types.ts

**web**
- app/packages/web/e2e/pages/CostsPage.ts (page object)
- app/packages/web/e2e/pages/DashboardPage.ts (page object)
- app/packages/web/src/components/game-card.component.tsx
- app/packages/web/src/components/kpi-strip.component.tsx
- app/packages/web/src/hooks/use-game-actions.hook.ts
- app/packages/web/src/pages/costs.page.tsx
- app/packages/web/src/pages/dashboard.page.tsx
- app/packages/web/src/polling/game-status-provider.component.tsx

### Cited from other leaves
- `game-server`: app/packages/desktop-main/src/controllers/games.controller.ts (channels `games.list/status/getStatus/start/stop`); app/packages/shared/src/gameServerValidator.ts (`FARGATE_VCPU_PER_HOUR`/`FARGATE_GB_PER_HOUR`, `estimateFargateHourlyCost`).
- `iac/program`: app/packages/infra/src/lambdas.ts (dns-updater function and its EventBridge rule); app/packages/infra/src/ecs.ts (the `{game}-server` task definitions RunTask targets).
- `iac/engine`: app/packages/desktop-main/src/services/ConfigService.ts (`getStackOutputs`, `getRegion`).
- `discord-bot`: app/packages/shared/src/formatStatus.ts, app/packages/shared/src/ddb/pendingStore.ts, app/packages/shared/src/discord/patchOriginal.ts; app/packages/lambda/followup/src/handler.ts (second RunTask path, `runStart`).
- `operator-app/desktop-shell`: app/packages/desktop-main/src/modules/cloud-provider.module.ts and cloud-provider.tokens.ts (`CLOUD_PROVIDER` binding; region resolvers calling `config.getRegion()`); app/packages/web/src/polling/polling-provider.component.tsx.
- `operator-app/wizard-and-bootstrap`: app/packages/desktop-main/src/services/awsCredentialSource.ts, awsClientCache.ts; app/packages/cloud-aws/src/cachedClient.ts.
- `helper-task`: app/packages/desktop-main/src/services/Ec2Service.ts (ENI and security-group ingress helper; injected into `EcsService`, unused there; `FileManagerService` is its real consumer), Ec2Service.test.ts.
- `operator-app/ipc-bridge`: app/packages/desktop-preload/src/hyveon-api.ts, app/packages/web/src/api.service.ts (renderer-side `GameStatus`/`CostEstimates` shapes).

## Architecture

**Purpose:** Turn the operator's Start/Stop click into an ECS `RunTask`/`StopTask` against the game's `{game}-server` task definition (no persistent ECS Service), keep `{game}.{domain}` pointed at the running task's public IP through a Lambda rather than the infra program, poll status into the dashboard, and estimate Fargate cost from task-definition CPU/memory without ever calling Cost Explorer.

**Key Components:**
1. `AwsCloudProvider` (app/packages/cloud-aws/src/AwsCloudProvider.ts) — the `CloudProvider` implementation: `startWorkload` (start lease and running-task pre-check through `startWithLease`, `RunTask` with the lease id as `clientToken` and `propagateTags: 'TASK_DEFINITION'`), `stopWorkload`, `getWorkloadStatus` (running/starting/stopped/not_deployed/error plus public IP and hostname), `streamWorkloadLogs`; per-game in-process lock `withGameLock`.
2. `EcsService` (app/packages/desktop-main/src/services/EcsService.ts) — Nest facade: `getStatus`/`start`/`stop` delegate to the injected `CLOUD_PROVIDER`; also raw ECS helpers (`getTaskDefinition`, `registerTaskDefinition`, `runTask`, `stopTask`, `tagTask`, `listTasksByStartedBy*`, `describeStoppedReason`, and the fail-closed `findRunningTaskOrThrow`) that the helper task uses. `buildProviderConfig` and `createAwsCloudProvider` build the provider from stack outputs.
3. `Ec2Service` (app/packages/desktop-main/src/services/Ec2Service.ts) — ENI and security-group ingress helpers; injected into `EcsService` but unused there (the `_ec2` constructor parameter).
4. update-dns Lambda (app/packages/lambda/update-dns/src/handler.ts) — `handler` maps task family to game and calls `handleDirect`: on RUNNING `resolvePublicIp` (up to five ENI lookups) then `upsertDns`; the same call also UPSERTs the `_hyveon-owner` TXT with the task ARN; on STOPPED `deleteDns` (deleting A and TXT only when the TXT names the stopping task, echoing stored TTLs and values); then `notifyDiscordIfPending` PATCHes any pending Discord interaction (an UPSERT failure keeps the row for the retry). Triggered by the EventBridge rule in `infra/src/lambdas.ts` (the `-task-state-change` rule, filtered to this cluster and `RUNNING`/`STOPPED`).
5. `shared/src/aws/ecsTask.ts` — `getTaskEniId`, `getTaskPrivateIp`, `resolveEniPublicIp`; shared by the provider, update-dns and the health-check Lambda.
6. `shared/src/cloud.ts` — the `CloudProvider` interface and `WorkloadStatus`, plus store interfaces owned by other leaves.
7. `CostService` + `CostsController` (app/packages/desktop-main/src/services/CostService.ts, controllers/costs.controller.ts) — `costs.estimate` reads `gameNames` from stack outputs, describes each task definition, and returns `$/hour`, `$/day` (24 h), `$/month` (4 h × 30); the hourly figure comes from `estimateFargateHourlyCost` in `@hyveon/shared`.
8. `GameStatusProvider` (app/packages/web/src/polling/game-status-provider.component.tsx) — registers the app-wide `status` poller (20 s, overridable by `VITE_STATUS_POLL_MS`) and fetches `costs.estimate` on mount; `reloadEstimates` re-fetches it on demand.
9. Dashboard (app/packages/web/src/pages/dashboard.page.tsx, components/game-card.component.tsx, kpi-strip.component.tsx, hooks/use-game-actions.hook.ts) — game cards with Start/Stop, a 3 s refresh and an Undo toast on Stop (`useGameActions`), a Files action that navigates to the helper-task file browser at `/games/:game/files` with `autoStart` state, and the KPI tiles "Current run rate" and "Est. month cap".
10. Costs page (app/packages/web/src/pages/costs.page.tsx) — per-game estimate table, calls `reloadEstimates` on mount, and the static Cost Explorer console link (`AWS_COST_EXPLORER_URL`).
11. `AwsModule` (app/packages/desktop-main/src/modules/aws.module.ts) — provides `Ec2Service`, `EcsService`, `LogsService`, `CostService`, `SchedulerService`, `PublicIpService`, `FileManagerService`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Start and Stop | `RT-TASK-LAUNCH-001` to `RT-TASK-LAUNCH-017` | 17 | 0 | 0 |
| Status | `RT-TASK-STATUS-001` to `RT-TASK-STATUS-008` | 8 | 0 | 0 |
| DNS Lifecycle | `RT-TASK-DNS-001` to `RT-TASK-DNS-019` | 19 | 0 | 0 |
| Discord Follow-up on Task State | `RT-TASK-NOTIFY-001` to `RT-TASK-NOTIFY-006` | 6 | 0 | 0 |
| Cost Estimates | `RT-TASK-COST-001` to `RT-TASK-COST-012` | 12 | 0 | 0 |
| Dashboard and Costs Page | `RT-TASK-UI-001` to `RT-TASK-UI-016` | 16 | 0 | 0 |

**Summary:** 78 of 78 active specs implemented; 0 deferred; 0 gaps.

## Key Findings

3. **DNS DELETE owner check (resolved).** The A record carries a sibling TXT ownership record `_hyveon-owner.{game}.{domain}` holding the task ARN, UPSERTed in the same change batch at RUNNING; STOPPED deletes both only when the ARN matches the stopping task, so a late STOPPED for an old task cannot remove a newer task's record (`RT-TASK-DNS-010`, `RT-TASK-DNS-016` to `RT-TASK-DNS-019`, design doc Decisions). A pre-ownership A record with no TXT is still deleted.
5. **Per-game start/stop lock is in-process only (resolved).** `withGameLock` still serialises calls within one `AwsCloudProvider` instance, and both launch paths (`AwsCloudProvider.startWorkload`, `followup/handler.ts` `runStart`) now also take a 120 s DynamoDB start lease through `startWithLease` (`shared/src/aws/startLease.ts`), so a desktop Start and a Discord `/server-start` cannot both launch (`RT-TASK-LAUNCH-010`, `RT-TASK-LAUNCH-015`, `RT-TASK-LAUNCH-016`). Stop is not covered by the lease.
10. **Dead and vestigial code in `EcsService`.** The null-on-failure `findRunningTask` has no production caller; its fail-closed sibling `findRunningTaskOrThrow` does, from the helper task (`FolderUploadService`, `volumeFiles/fileOps.ts`). The `_ec2` constructor parameter is unused; `registerTaskDefinition` dynamically imports a command class from a package the file already imports .
12. **Stale references.** code comments in `CostService.ts`, `costs.controller.ts`, `costs.page.tsx`, `AwsCloudProvider.ts`, `shared/src/cloud.ts`, `kpi-strip.component.tsx` and `costs.spec.ts` cite the retired `remove-cost-explorer-calls` change name instead of stating the rationale (the app makes no Cost Explorer calls); `costs.controller.ts` says "tfstate" for stack outputs; `update-dns/handler.ts` cites the retired `update_dns.py`; the `CostsPage` page object says Costs is not in the sidebar, but `app-nav.component.tsx` links it.
15. **The card's clipboard write is fire-and-forget.** The clipboard copy promise on the game card is not handled (`game-card.component.tsx`).

## Work Required

Spec IDs cite the open (`[ ]`) gap specs in `docs/intent/game-runtime/task-and-dns/task-and-dns-specs.md`; items with no matching gap spec carry none.

### Must Fix
None open.

### Nice to Have
7. Remove the caller-less `EcsService.findRunningTask` wrapper, the unused `_ec2` parameter and the dynamic import (finding 10).
8. Fix stale comments and the `CostsPage` page-object TODO (finding 12).
9. Handle the game card's clipboard write promise (finding 15).
