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
- `docs/intent/game-runtime/task-and-dns/task-and-dns-specs.md` (71 specs)

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

### OpenSpec sources
- `cost-visibility` capability (carried; the Cost Explorer removal and per-game cost tag work behind it are shipped).
- `in-task-tls-termination` capability (cited: requirement "HTTPS games use the Lambda-managed DNS lifecycle" only; the rest belongs to `iac/program`).
- No in-flight change maps to this leaf.

## Architecture

**Purpose:** Turn the operator's Start/Stop click into an ECS `RunTask`/`StopTask` against the game's `{game}-server` task definition (no persistent ECS Service), keep `{game}.{domain}` pointed at the running task's public IP through a Lambda rather than the infra program, poll status into the dashboard, and estimate Fargate cost from task-definition CPU/memory without ever calling Cost Explorer.

**Key Components:**
1. `AwsCloudProvider` (app/packages/cloud-aws/src/AwsCloudProvider.ts) — the `CloudProvider` implementation: `startWorkload` `:412` (guarded by a running-task check, `RunTask` with `propagateTags: 'TASK_DEFINITION'` `:441`), `stopWorkload` `:462`, `getWorkloadStatus` `:503` (running/starting/stopped/not_deployed/error plus public IP and hostname), `streamWorkloadLogs` `:548`, `getCostEstimate` `:603`; per-game in-process lock `withGameLock` `:328`.
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

| OpenSpec capability | requirements | scenarios | notes |
|---|---|---|---|
| cost-visibility | 6 | 15 | Carried. No Cost Explorer client or `GetCostAndUsage` anywhere in `app/packages`. Both RunTask paths set `propagateTags` (`AwsCloudProvider.ts:441`, `followup/handler.ts:136`). The `Game` tag scenarios are satisfied in `iac/program`, not here. The wizard live-estimate scenarios are satisfied in `game-server` (`estimateFargateHourlyCost`). |
| in-task-tls-termination | 1 of 6 cited | 2 | Cited: "HTTPS games use the Lambda-managed DNS lifecycle". update-dns has one path for every game (`handler.ts:217-240`); no `elasticloadbalancing`, `ALB_TARGET_GROUPS` or `HTTPS_GAMES` in Lambda or infra sources. |

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Start and Stop | `RT-TASK-LAUNCH-001` to `RT-TASK-LAUNCH-014` | 12 | 0 | 2 |
| Status | `RT-TASK-STATUS-001` to `RT-TASK-STATUS-008` | 7 | 0 | 1 |
| DNS Lifecycle | `RT-TASK-DNS-001` to `RT-TASK-DNS-015` | 12 | 0 | 3 |
| Discord Follow-up on Task State | `RT-TASK-NOTIFY-001` to `RT-TASK-NOTIFY-006` | 4 | 0 | 2 |
| Cost Estimates | `RT-TASK-COST-001` to `RT-TASK-COST-012` | 9 | 0 | 3 |
| Dashboard and Costs Page | `RT-TASK-UI-001` to `RT-TASK-UI-016` | 13 | 0 | 3 |

**Summary:** 57 of 71 active specs implemented; 0 deferred; 14 gaps.

## Key Findings

1. **Start, stop and status read the region from stack outputs.** `buildProviderConfig` gives the provider `outputs.awsRegion` (`EcsService.ts:72`), while `EcsService.getClient`, used by `getTaskDefinition` (the cost estimate) and every helper-task ECS call, uses `ConfigService.getRegion()` (`EcsService.ts:214`). An install has one region, resolved only through `getRegion()` (`docs/high-level-design.md`, decision 10; `IAC-ENGINE-REGION-002`, owned by `iac/engine`); the provider is the call site in this leaf that does not yet comply.
2. **DNS DELETE can orphan a record.** `deleteDns` reads the record's current IP but sends the Lambda's current `DNS_TTL` (`update-dns/handler.ts:141-170`). Route 53 DELETE must match the record exactly, so a `DNS_TTL` change between UPSERT and DELETE makes the delete fail; the failure is only logged as a warning (`:167-169`) and the stale A record stays.
3. **DNS DELETE has no owner check.** On any STOPPED event for a known family the record is deleted (`handler.ts:235-238`) without comparing its IP to the stopping task's; a stale STOPPED event for an old task arriving after a new task's RUNNING UPSERT would remove the live record [inferred from code; not reproduced].
4. **Pending Discord row is not cleared on STOPPED.** `notifyDiscordIfPending` runs only on RUNNING (`handler.ts:224-233`); a task that stops before reaching RUNNING leaves its `PENDING#{taskArn}` row behind.
5. **Per-game start/stop lock is in-process only.** `withGameLock` serialises calls within one `AwsCloudProvider` instance (`AwsCloudProvider.ts:328-336`); the Discord followup Lambda's independent `RunTask` (`followup/handler.ts:136`) is not covered, so a desktop Start and a Discord `/server-start` can race past the "already running" guard (`AwsCloudProvider.ts:424-425`).
6. **Fargate pricing arithmetic exists three times.** `estimateFargateHourlyCost` (`shared/src/gameServerValidator.ts:426-431`), `CostService.estimateForSpec` (`CostService.ts:31-42`) and `AwsCloudProvider.estimateHourlyCost` (`AwsCloudProvider.ts:312-317`) repeat the same formula; `CostService` imports the constants through the cloud-aws re-export (`CostService.ts:2`, `AwsCloudProvider.ts:32`).
7. **`CloudProvider.getCostEstimate` has no production caller.** It is declared in `shared/src/cloud.ts:55` and implemented at `AwsCloudProvider.ts:603-623`, but only tests call it; the Costs page goes through `costs.estimate`, which bypasses the provider and calls `EcsService.getTaskDefinition` directly (`costs.controller.ts:37-39`).
8. **Two different task-definition fallbacks.** When a definition omits `cpu`/`memory`, `EcsService.getTaskDefinition` defaults to 1024/2048 (`EcsService.ts:372-373`); when the describe fails, `costs.controller` defaults to 2048/8192 (`costs.controller.ts:39`), as does the provider (`AwsCloudProvider.ts:297-302`). The same missing data yields different estimates.
9. **Status and cost shapes are declared four and three times.** `GameStatus` in `shared/src/types.ts:61`, `EcsService.ts:148`, `desktop-preload/src/hyveon-api.ts:100`, `web/src/api.service.ts:121`; `StartResult` in three of those; `CostEstimates` in `CostService.ts:14`, `hyveon-api.ts:126`, `api.service.ts:147`.
10. **Dead and vestigial code in `EcsService`.** The null-on-failure `findRunningTask` (`EcsService.ts:281-287`) has no production caller; its fail-closed sibling `findRunningTaskOrThrow` (`EcsService.ts:242-268`) does, from the helper task (`FolderUploadService.ts:292`, `volumeFiles/fileOps.ts:116`). The `_ec2` constructor parameter is unused (`EcsService.ts:197-200`); `registerTaskDefinition` dynamically imports a command class from a package the file already imports (`EcsService.ts:388-390`).
11. **Raw error objects logged.** `EcsService.start`/`stop` log `{ err }` on the non-guard path (`EcsService.ts:330,352`), as do `getTaskDefinition` `:377` and `listTasksByStartedBy` `:477` (`findRunningTaskOrThrow` now normalises, `:264-266`), against the repo's logging rule to normalise to a message. update-dns logs the full EventBridge event (`handler.ts:252`).
12. **Stale references.** code comments at `CostService.ts:23`, `costs.controller.ts:13`, `costs.page.tsx:167,190`, `AwsCloudProvider.ts:183`, `shared/src/cloud.ts:35`, `kpi-strip.component.tsx:57` and `costs.spec.ts:18` cite the retired `remove-cost-explorer-calls` change name instead of stating the rationale (the app makes no Cost Explorer calls); `costs.controller.ts:25-27` says "tfstate" for stack outputs; `update-dns/handler.ts:69` cites the retired `update_dns.py`; `CostsPage.ts:12,22-23` says Costs is not in the sidebar, but `app-nav.component.tsx:22` links it.
13. **Renderer cost fetch failures are silent and duplicated.** `GameStatusProvider` swallows `costs.estimate` errors (`game-status-provider.component.tsx:85`) and the Costs page fetches the same channel again with its own silent catch (`costs.page.tsx:172-180`).
14. **`refreshGame` cannot add a game.** It maps over existing `statuses` only (`game-status-provider.component.tsx:88-91`), so a game absent from the last full poll stays absent until the next 20 s poll.
15. **Undo-after-Stop does not set `busy`.** The Undo action calls `api.start` without `setBusy(true)` (`use-game-actions.hook.ts:89-97`), so the card's buttons stay enabled during the restart; the clipboard copy promise on the card is not handled (`game-card.component.tsx:195`).

## Work Required

Spec IDs cite the open (`[ ]`) gap specs in `docs/intent/game-runtime/task-and-dns/task-and-dns-specs.md`; items with no matching gap spec carry none.

### Must Fix
1. Make update-dns DELETE robust: send the record's stored TTL (from `ListResourceRecordSets`) instead of the current `DNS_TTL`, and skip the delete when the record's IP does not belong to the stopping task (findings 2, 3). (specs: `RT-TASK-DNS-009`, `RT-TASK-DNS-010`)

### Should Fix
2. Give the provider its region from `ConfigService.getRegion()` instead of `outputs.awsRegion` in `buildProviderConfig` (finding 1). The spec is owned by `iac/engine` and tracked in `docs/arrows/iac/engine.md`, Work Required. (specs: `IAC-ENGINE-REGION-002`)
3. Clear the pending Discord row on STOPPED (finding 4). (specs: `RT-TASK-NOTIFY-005`)
4. Collapse the Fargate cost formula onto `estimateFargateHourlyCost` and unify the task-definition fallback values (findings 6, 8); either route `costs.estimate` through `CloudProvider.getCostEstimate` or drop that interface method (finding 7). (specs: `RT-TASK-COST-010`, `RT-TASK-COST-011`, `RT-TASK-COST-012`)
5. Normalise logged errors to messages in `EcsService` and stop logging the full event in update-dns (finding 11). (specs: `RT-TASK-LAUNCH-014`, `RT-TASK-DNS-014`)
6. Consolidate `GameStatus`/`StartResult`/`CostEstimates` onto the `@hyveon/shared` types (finding 9). (specs: `RT-TASK-STATUS-008`)
7. Decide whether the desktop and Discord start paths need a cross-process guard (finding 5). (specs: `RT-TASK-LAUNCH-010`)

### Nice to Have
8. Remove the caller-less `EcsService.findRunningTask` wrapper, the unused `_ec2` parameter and the dynamic import (finding 10).
9. Fix stale comments and the `CostsPage` page-object TODO (finding 12).
10. Surface cost-fetch failures, share one estimate fetch between dashboard and Costs page, let `refreshGame` add missing games, set `busy` on Undo (findings 13 to 15). (specs: `RT-TASK-UI-004`, `RT-TASK-UI-005`, `RT-TASK-UI-010`)
