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
- `docs/intent/game-runtime/task-and-dns/task-and-dns-specs.md` (73 specs)

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
- `game-server`: app/packages/desktop-main/src/controllers/games.controller.ts (channels `games.list/status/getStatus/start/stop`, `:53-122`); app/packages/shared/src/gameServerValidator.ts (`FARGATE_VCPU_PER_HOUR`/`FARGATE_GB_PER_HOUR`, `estimateFargateHourlyCost` `:426`).
- `iac/program`: app/packages/infra/src/lambdas.ts (dns-updater function and its EventBridge rule, `:624-696`); app/packages/infra/src/ecs.ts (the `{game}-server` task definitions RunTask targets).
- `iac/engine`: app/packages/desktop-main/src/services/ConfigService.ts (`getStackOutputs`, `getRegion`).
- `discord-bot`: app/packages/shared/src/formatStatus.ts, app/packages/shared/src/ddb/pendingStore.ts, app/packages/shared/src/discord/patchOriginal.ts; app/packages/lambda/followup/src/handler.ts (second RunTask path, `:136`).
- `operator-app/desktop-shell`: app/packages/desktop-main/src/modules/cloud-provider.module.ts and cloud-provider.tokens.ts (`CLOUD_PROVIDER` binding; region resolvers `:80,109,131,180`); app/packages/web/src/polling/polling-provider.component.tsx.
- `operator-app/wizard-and-bootstrap`: app/packages/desktop-main/src/services/awsCredentialSource.ts, awsClientCache.ts; app/packages/cloud-aws/src/cachedClient.ts.
- `helper-task`: app/packages/desktop-main/src/services/Ec2Service.ts (ENI and security-group ingress helper; injected into `EcsService`, unused there; `FileManagerService` is its real consumer), Ec2Service.test.ts.
- `operator-app/ipc-bridge`: app/packages/desktop-preload/src/hyveon-api.ts, app/packages/web/src/api.service.ts (renderer-side `GameStatus`/`CostEstimates` shapes).

## Architecture

**Purpose:** Turn the operator's Start/Stop click into an ECS `RunTask`/`StopTask` against the game's `{game}-server` task definition (no persistent ECS Service), keep `{game}.{domain}` pointed at the running task's public IP through a Lambda rather than the infra program, poll status into the dashboard, and estimate Fargate cost from task-definition CPU/memory without ever calling Cost Explorer.

**Key Components:**
1. `AwsCloudProvider` (app/packages/cloud-aws/src/AwsCloudProvider.ts) — the `CloudProvider` implementation: `startWorkload` `:437` (start lease and running-task pre-check through `startWithLease`, `RunTask` with the lease id as `clientToken` `:472` and `propagateTags: 'TASK_DEFINITION'` `:476`), `stopWorkload` `:500`, `getWorkloadStatus` `:543` (running/starting/stopped/not_deployed/error plus public IP and hostname), `streamWorkloadLogs` `:590`; per-game in-process lock `withGameLock` `:342`.
2. `EcsService` (app/packages/desktop-main/src/services/EcsService.ts) — Nest facade: `getStatus`/`start`/`stop` `:295-356` delegate to the injected `CLOUD_PROVIDER`; also raw ECS helpers (`getTaskDefinition` `:363`, `registerTaskDefinition`, `runTask`, `stopTask`, `tagTask` `:490`, `listTasksByStartedBy*`, `describeStoppedReason`, and the fail-closed `findRunningTaskOrThrow` `:242`) that the helper task uses. `buildProviderConfig` `:64` and `createAwsCloudProvider` `:104` build the provider from stack outputs.
3. `Ec2Service` (app/packages/desktop-main/src/services/Ec2Service.ts) — ENI and security-group ingress helpers; injected into `EcsService` but unused there (`EcsService.ts:195-200`).
4. update-dns Lambda (app/packages/lambda/update-dns/src/handler.ts) — `handler` `:251` maps task family to game, UPSERTs the A record on RUNNING after up to five ENI lookups `:71-96`, DELETEs on STOPPED `:141-170`, then PATCHes any pending Discord interaction `:176-198`. Triggered by the EventBridge rule in `infra/src/lambdas.ts:660-675` (filtered to this cluster and `RUNNING`/`STOPPED`).
5. `shared/src/aws/ecsTask.ts` — `getTaskEniId` `:53`, `getTaskPrivateIp` `:64`, `resolveEniPublicIp` `:101`; shared by the provider, update-dns and the health-check Lambda.
6. `shared/src/cloud.ts` — the `CloudProvider` interface `:50` and `WorkloadStatus` `:16`, plus store interfaces owned by other leaves.
7. `CostService` + `CostsController` (app/packages/desktop-main/src/services/CostService.ts, controllers/costs.controller.ts) — `costs.estimate` `:28` reads `gameNames` from stack outputs, describes each task definition, and returns `$/hour`, `$/day` (24 h), `$/month` (4 h × 30).
8. `GameStatusProvider` (app/packages/web/src/polling/game-status-provider.component.tsx) — registers the app-wide `status` poller (20 s, overridable by `VITE_STATUS_POLL_MS`) `:22-29,82` and fetches `costs.estimate` once on mount `:84-86`.
9. Dashboard (app/packages/web/src/pages/dashboard.page.tsx, components/game-card.component.tsx, kpi-strip.component.tsx, hooks/use-game-actions.hook.ts) — game cards with Start/Stop, a 3 s refresh and an Undo toast on Stop (`use-game-actions.hook.ts:76-114`), a Files action that navigates to the helper-task file browser at `/games/:game/files` with `autoStart` state (`dashboard.page.tsx:80`), and the KPI tiles "Current run rate" and "Est. month cap" (`kpi-strip.component.tsx:56-70`).
10. Costs page (app/packages/web/src/pages/costs.page.tsx) — per-game estimate table and the static Cost Explorer console link `:40`.
11. `AwsModule` (app/packages/desktop-main/src/modules/aws.module.ts) — provides `Ec2Service`, `EcsService`, `LogsService`, `CostService`, `SchedulerService`, `PublicIpService`, `FileManagerService` `:48`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Start and Stop | `RT-TASK-LAUNCH-001` to `RT-TASK-LAUNCH-016` | 16 | 0 | 0 |
| Status | `RT-TASK-STATUS-001` to `RT-TASK-STATUS-008` | 8 | 0 | 0 |
| DNS Lifecycle | `RT-TASK-DNS-001` to `RT-TASK-DNS-015` | 14 | 0 | 1 |
| Discord Follow-up on Task State | `RT-TASK-NOTIFY-001` to `RT-TASK-NOTIFY-006` | 6 | 0 | 0 |
| Cost Estimates | `RT-TASK-COST-001` to `RT-TASK-COST-012` | 12 | 0 | 0 |
| Dashboard and Costs Page | `RT-TASK-UI-001` to `RT-TASK-UI-016` | 16 | 0 | 0 |

**Summary:** 72 of 73 active specs implemented; 0 deferred; 1 gap.

## Key Findings

3. **DNS DELETE has no owner check.** On any STOPPED event for a known family the record is deleted without proving the stopping task owns it; a stale STOPPED event for an old task arriving after a new task's RUNNING UPSERT would remove the live record [inferred from code; not reproduced]. The event carries no public IP and the stopped task's ENI is gone, so an owner check needs a new IAM grant (`RT-TASK-DNS-010`, design doc Open Questions).
5. **Per-game start/stop lock is in-process only (resolved).** `withGameLock` still serialises calls within one `AwsCloudProvider` instance, and both launch paths (`AwsCloudProvider.startWorkload`, `followup/handler.ts` `runStart`) now also take a 120 s DynamoDB start lease through `startWithLease` (`shared/src/aws/startLease.ts`), so a desktop Start and a Discord `/server-start` cannot both launch (`RT-TASK-LAUNCH-010`, `RT-TASK-LAUNCH-015`, `RT-TASK-LAUNCH-016`). Stop is not covered by the lease.
10. **Dead and vestigial code in `EcsService`.** The null-on-failure `findRunningTask` (`EcsService.ts:281-287`) has no production caller; its fail-closed sibling `findRunningTaskOrThrow` (`EcsService.ts:242-268`) does, from the helper task (`FolderUploadService.ts:292`, `volumeFiles/fileOps.ts:116`). The `_ec2` constructor parameter is unused (`EcsService.ts:197-200`); `registerTaskDefinition` dynamically imports a command class from a package the file already imports (`EcsService.ts:388-390`).
12. **Stale references.** code comments at `CostService.ts:23`, `costs.controller.ts:13`, `costs.page.tsx:167,190`, `AwsCloudProvider.ts:183`, `shared/src/cloud.ts:35`, `kpi-strip.component.tsx:57` and `costs.spec.ts:18` cite the retired `remove-cost-explorer-calls` change name instead of stating the rationale (the app makes no Cost Explorer calls); `costs.controller.ts:25-27` says "tfstate" for stack outputs; `update-dns/handler.ts:69` cites the retired `update_dns.py`; `CostsPage.ts:12,22-23` says Costs is not in the sidebar, but `app-nav.component.tsx:22` links it.
15. **The card's clipboard write is fire-and-forget.** The clipboard copy promise on the game card is not handled (`game-card.component.tsx:195`).

## Work Required

Spec IDs cite the open (`[ ]`) gap specs in `docs/intent/game-runtime/task-and-dns/task-and-dns-specs.md`; items with no matching gap spec carry none.

### Must Fix
1. Decide how update-dns proves a STOPPED task owns the record before deleting it (finding 3). (specs: `RT-TASK-DNS-010`)

### Nice to Have
7. Remove the caller-less `EcsService.findRunningTask` wrapper, the unused `_ec2` parameter and the dynamic import (finding 10).
8. Fix stale comments and the `CostsPage` page-object TODO (finding 12).
9. Handle the game card's clipboard write promise (finding 15).
