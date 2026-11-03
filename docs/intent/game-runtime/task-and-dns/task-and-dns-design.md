---
parent: game-runtime
prefix: RT-TASK
---

# Game Task Lifecycle and DNS

## Context and Design Philosophy

Hyveon only pays for a game server while it runs. This leaf is the part of the runtime that makes that true from the operator's side: a Start click becomes one ECS `RunTask` against the game's `{game}-server` task definition, a Stop click becomes one `StopTask`, and nothing keeps a task alive in between (`app/packages/cloud-aws/src/AwsCloudProvider.ts:412-484`). Because a Fargate task gets a fresh public IP every launch, the leaf also owns keeping `{game}.{domain}` pointed at whatever task is running, through the update-dns Lambda reacting to ECS task-state events (`app/packages/lambda/update-dns/src/handler.ts:251-268`). Finally it surfaces the result on the dashboard: a polled status per game and a cost estimate computed from task-definition CPU/memory, never from billed data.

What it owns:

- The `CloudProvider` contract for workloads (`app/packages/shared/src/cloud.ts:50-56`) and its AWS implementation: start, stop, status, log streaming and cost estimate (`AwsCloudProvider.ts:412-623`).
- The Nest facade `EcsService` that maps provider results onto the app's `GameStatus`/`StartResult` shapes (`app/packages/desktop-main/src/services/EcsService.ts:295-356`), plus raw ECS helpers it exposes to other leaves.
- The update-dns Lambda: UPSERT on `RUNNING`, DELETE on `STOPPED`, and the RUNNING-side Discord follow-up PATCH (`update-dns/src/handler.ts:71-240`).
- The shared ENI helpers `getTaskEniId`, `getTaskPrivateIp`, `resolveEniPublicIp` (`app/packages/shared/src/aws/ecsTask.ts:53-107`).
- The `costs.estimate` channel and `CostService` arithmetic (`app/packages/desktop-main/src/controllers/costs.controller.ts:28-48`, `app/packages/desktop-main/src/services/CostService.ts:31-42`).
- The renderer side: `GameStatusProvider` polling, the dashboard cards and KPI strip, `useGameActions`, and the Costs page.

What it deliberately does not own:

- **The IPC channels for games.** `games.status`, `games.getStatus`, `games.start`, `games.stop` are declared in `GamesController` (`app/packages/desktop-main/src/controllers/games.controller.ts:71-122`), owned by `game-server`; they are thin calls into `EcsService`.
- **Provisioning.** The `{game}-server` task definitions, the dns-updater function, its env vars and the EventBridge rule are `iac/program` resources (`app/packages/infra/src/ecs.ts`, `app/packages/infra/src/lambdas.ts:625-696`).
- **Stack outputs and region.** `ConfigService.getStackOutputs()`/`getRegion()` belong to `iac/engine`; this leaf only reads them.
- **The Discord start path.** `/server-start` issues its own `RunTask` from the followup Lambda (`app/packages/lambda/followup/src/handler.ts:117-147`) and writes the `PENDING#{taskArn}` row; both are `discord-bot`. This leaf only consumes that row on RUNNING.
- **Idle shutdown.** The watchdog (`game-runtime/watchdog`) stops tasks; DNS cleanup then flows through this leaf's STOPPED path.
- **The wizard's live estimate.** `estimateFargateHourlyCost` (`app/packages/shared/src/gameServerValidator.ts:426-431`) is `game-server`.

CLAUDE.md invariants that live here:

- **No persistent ECS Service.** Holds: the only launch is `RunTaskCommand` with `count: 1` (`AwsCloudProvider.ts:432-443`); the class doc restates it (`EcsService.ts:175-177`).
- **DNS records are Lambda-managed.** Holds: `stopWorkload` does no DNS work and defers to the STOPPED event (`AwsCloudProvider.ts:457-458`); the Lambda owns UPSERT/DELETE (`update-dns/src/handler.ts:98-170`).
- **TLS terminates in-task; no ALB.** Holds: update-dns has one path for every game, HTTPS or not (`update-dns/src/handler.ts:6-9,217-240`), as the in-task TLS invariant requires: an HTTPS game needs no load balancer registration or separate DNS step.
- **Lambda env vars use `AWS_REGION_`.** Holds: `region()` reads `AWS_REGION_` first (`update-dns/src/handler.ts:51-59`) and the infra program sets it (`lambdas.ts:646`).
- **`@hyveon/shared` stays free of SDK imports.** Holds for this leaf's shared code: `ecsTask.ts` uses hand-rolled structural types and a caller-supplied describe callback (`ecsTask.ts:1-16,68-107`).

## Start, Stop and Status

### Desktop call chain

The renderer calls `api.start(game)` / `api.stop(game)`; `GamesController` forwards to `EcsService.start`/`stop`, which call the injected `CLOUD_PROVIDER` (`EcsService.ts:316-356`). The provider is built once from `buildProviderConfig`, which returns `null` until stack outputs exist and otherwise fills region, credentials, cluster, subnets, security group, domain and game names from those outputs (`EcsService.ts:64-81,104-106`).

`startWorkload` runs inside `withGameLock(game)`, a promise chain keyed by game that serialises start/stop for one game within the process while leaving different games concurrent (`AwsCloudProvider.ts:328-336,423`). Inside the lock it looks up a non-stopped task with `ListTasks(family, desiredStatus: RUNNING)` plus `DescribeTasks` (`:349-375`), refuses with `WorkloadGuardError("{game} is already running.")` if one exists (`:424-425`), then sends `RunTask` with `FARGATE`, the stack's subnets and security group, `assignPublicIp: ENABLED`, and `propagateTags: 'TASK_DEFINITION'` (`:432-443`). An empty `tasks` array becomes `WorkloadLaunchError("Failed to start {game}: {reason}")` (`:448-449`). The provider's own comment says the lock, not the `ListTasks` read, is what prevents duplicate starts, because `ListTasks` is eventually consistent (`:344-347`).

`stopWorkload` mirrors it: lock, find the task, refuse with `"{game} is not currently running."` if none, `StopTask` with reason `Stopped via management app` (`:462-484`).

`EcsService` turns these into `StartResult`: success messages `"{game} is starting. It may take 2–5 minutes."` and `"{game} is stopping."`; on failure `describeError` returns the guard/launch message unprefixed and `String(err)` for everything else (`EcsService.ts:122-125,321-332,347-354`). Guard refusals log at `warn`, other errors at `error` (`:327-331,349-353`). The provider's comments call these message strings part of the UI contract (`AwsCloudProvider.ts:404-405,456-457`).

### Status states

`getWorkloadStatus` returns a `WorkloadStatus` (`shared/src/cloud.ts:16-23`), which `EcsService.getStatus` maps to `GameStatus` by renaming `workloadId` to `taskArn` (`EcsService.ts:295-306`).

| State | Condition (`AwsCloudProvider.ts:503-528`) | Extra fields |
|---|---|---|
| `not_deployed` | `getConfig()` returns null (no stack outputs) | `message: "Run Apply on the IaC page first."` |
| `running` | a non-stopped task with `lastStatus === 'RUNNING'` | `workloadId`, `publicIp` if the ENI resolves, `hostname = {game}.{domain}` if a domain is set |
| `starting` | a non-stopped task in any other status | `workloadId` |
| `stopped` | no non-stopped task found | none |
| `error` | anything thrown, including config resolution | `message: String(err)` |

Two behaviours follow from this table. First, `running` reflects the ECS task status only; it does not wait for the update-dns UPSERT, so the card can show a hostname a few seconds before the record exists [inferred from the independent paths at `AwsCloudProvider.ts:512-520` and `update-dns/src/handler.ts:224-231`]. Second, `findRunningTask` and `getPublicIp` swallow their errors and return `null` (`AwsCloudProvider.ts:371-374,394-397`), so a `ListTasks` failure reads as `stopped` and an EC2 failure as "running, no IP"; the injected logger is the only trace (`EcsService.ts:92-94`). The try around `getConfig()` exists so one game's credential failure does not reject the whole `games.status` `Promise.all` (`AwsCloudProvider.ts:494-499`, `games.controller.ts:71-78`).

The Discord followup Lambda repeats this status assembly and the find-running-task query in its own module (`followup/src/handler.ts:79-115`) and builds an identical `RunTask` request (`:127-138`), so three code paths (provider, followup status, followup start) share no implementation.

### Region

Every ECS call this leaf makes in the desktop app resolves its region through `ConfigService.getRegion()`, the install's one region (`IAC-ENGINE-REGION-002`, owned by `iac/engine`; `docs/high-level-design.md`, decision 10). `EcsService.getClient`, used by `getTaskDefinition` and every helper-task ECS call, already does (`EcsService.ts:213-217`). `buildProviderConfig` still gives the provider `outputs.awsRegion` (`EcsService.ts:72`), so start, stop and status read the region from the stack outputs; that is the open gap in `IAC-ENGINE-REGION-002`. The Lambdas in this leaf take their region from `AWS_REGION_`, which the program sets from its `awsRegion` input.

### Renderer polling and actions

`GameStatusProvider` sits above the router and registers the `status` poller at `GAME_STATUS_INTERVAL_MS` (20 s, overridable by `VITE_STATUS_POLL_MS` with a 1 s floor) so polling continues on every route (`app/packages/web/src/polling/game-status-provider.component.tsx:22-29,45-53,82`). A poll failure sets `error` and re-throws so the polling registry records it (`:66-80`). `refreshGame` replaces one entry in the existing list and cannot add a game that the last full poll did not return (`:88-91`).

`useGameActions` sets `busy`, calls start or stop, toasts the result, and always schedules a single-game refresh 3 s later that also clears `busy` (`app/packages/web/src/hooks/use-game-actions.hook.ts:6,43-52,54-114`). A successful Stop shows a 5 s toast with an Undo action that calls `api.start` without setting `busy` (`:85-104`).

## DNS Lifecycle (update-dns Lambda)

### Trigger and configuration

The EventBridge rule `${projectName}-task-state-change` matches `aws.ecs` / `ECS Task State Change` filtered to this cluster's ARN and `lastStatus` in `RUNNING`, `STOPPED` (`lambdas.ts:660-675`). The function has a 60 s timeout and default memory (`lambdas.ts:626-639`).

| Env var | Source (`lambdas.ts:641-650`) | Use in handler |
|---|---|---|
| `HOSTED_ZONE_ID` | hosted-zone lookup | target zone (`handler.ts:37`) |
| `DOMAIN_NAME` | hosted-zone name, trailing dot stripped | record name `{game}.{DOMAIN_NAME}` (`:38,265`) |
| `GAME_NAMES` | CSV of `gameServers` keys | family-to-game map (`:39,49`) |
| `DNS_TTL` | `DeploymentConfig.dnsTtl` (default 30, `shared/src/deploymentConfig.ts:80,239`) | TTL on UPSERT and DELETE (`:40,110,159`) |
| `AWS_REGION_` | stack region | ECS/EC2 clients (`:51-62`) |
| `TABLE_NAME` | Discord DynamoDB table | pending-interaction lookup; empty disables it (`:41,181`) |
| `CONNECT_MESSAGES`, `GAME_PORTS` | per-game maps from `gameServers` | Discord connect message (`:44,47,187-191`) |

### Event handling

The handler strips `family:` from `detail.group` and looks it up in `FAMILY_TO_GAME` (`{game}-server` to `{game}`, `shared/src/env.ts:64-66`); unknown families, including the helper task's, return `skipped` (`handler.ts:257-263`).

On `RUNNING`, `resolvePublicIp` tries up to five times with 3 s sleeps: `DescribeTasks`, pull the ENI from the task's attachments, `DescribeNetworkInterfaces`, take the public IP (`handler.ts:71-96`). Each attempt's errors are caught and logged. If no IP is found the handler PATCHes any pending Discord interaction with an error message and returns `no_ip` without touching DNS (`:224-230`). Otherwise it UPSERTs an A record with `DNS_TTL` (`:98-118,231`), then PATCHes the pending interaction with the formatted running status and deletes the row (`:176-198,232`). Discord failures are logged and swallowed (`:195-197`). An UPSERT failure is not caught and fails the invocation [inferred: no try at `:98-118` or `:231`].

On `STOPPED`, `deleteDns` reads the current A record with `ListResourceRecordSets` (`:120-139`); if none exists it logs and returns. Otherwise it sends DELETE with the current record's IP but the Lambda's current `DNS_TTL` (`:141-166`), and a failure is logged as a warning (`:167-169`). Route 53 requires a DELETE to match the existing record set exactly, so a `dnsTtl` change applied between a task's start and stop leaves the record in place [inferred from Route 53 DELETE semantics; not reproduced]. The delete also does not compare the record's IP with the stopping task's IP, so a late STOPPED for an old task could remove a newer task's record [inferred; not reproduced]. The pending Discord row is never consulted on STOPPED (`:235-238`).

Other statuses return `no_action` (`:239`), though the rule already filters them out. The handler logs the full event JSON on every invocation (`:252`).

## Cost Estimates

The app makes no AWS Cost Explorer calls; per-game estimates derive only from task-definition CPU/memory (via `DescribeTaskDefinition`, not a billed API) and static Fargate on-demand constants, so they need no billed-cost data. The same constants drive the live hourly estimate in the add-game wizard's Resources step. No Cost Explorer client exists in this leaf; the Costs page links out to the console instead (`app/packages/web/src/pages/costs.page.tsx:40`).

The live path is `costs.estimate`: read `gameNames` from stack outputs (zeros if none), call `EcsService.getTaskDefinition` per game sequentially, and feed `CostService.estimateForSpec` (`costs.controller.ts:28-48`). That function returns:

| Field | Formula (`CostService.ts:31-42`) |
|---|---|
| `vcpu`, `memoryGb` | `cpu / 1024`, `memory / 1024` |
| `costPerHour` | `vcpu × FARGATE_VCPU_PER_HOUR + memGb × FARGATE_GB_PER_HOUR`, 4 decimals |
| `costPerDay24h` | hourly × 24, 2 decimals |
| `costPerMonth4hpd` | hourly × 4 × 30, 2 decimals |
| `totalPerHourIfAllOn` | sum of `costPerHour` (`costs.controller.ts:42-47`) |

Missing data is handled at two levels with different numbers: a task definition without `cpu`/`memory` defaults to 1024/2048 (`EcsService.ts:372-373`), while a failed describe defaults to 2048/8192 in the controller (`costs.controller.ts:39`).

The dashboard derives its KPI tiles from the same estimate: "Current run rate" sums `costPerHour` over `running` games and "Est. month cap" is `totalPerHourIfAllOn × 24 × days in the current month` (`app/packages/web/src/components/kpi-strip.component.tsx:58-69`), using only free data. The Costs page's "$/month" column is the 4 h/day projection, so the two "month" numbers measure different things by design. `GameStatusProvider` fetches the estimate once on mount because polling it would add steady ECS traffic (`game-status-provider.component.tsx:54-58,84-86`); the Costs page fetches it again on its own mount (`costs.page.tsx:172-180`). Both swallow errors.

A second implementation exists on the provider: `getCostEstimate` describes each task definition with a 2048/8192 fallback and its own copy of the hourly formula (`AwsCloudProvider.ts:285-317,603-623`). It returns a `CostBreakdown` (`shared/src/cloud.ts:37-43`) and is not called by any production path; `costs.estimate` bypasses it.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| How a game runs | One-off `RunTask` per Start, `StopTask` per Stop | Persistent ECS Service scaled 0/1 | Cost model: a long-running Service "destroys the cost model" (CLAUDE.md; `EcsService.ts:171-177`). |
| Who owns DNS records | update-dns Lambda on ECS state-change events | Pulumi-managed per-game records; desktop app writes DNS on start | Records follow ephemeral task IPs "without fighting state" (`update-dns/src/handler.ts:242-246`); the desktop path cannot see watchdog or Discord starts [inferred]. |
| HTTPS games and DNS | Same A-record path as every game | ALB with target registration | TLS terminates in-task via a Caddy sidecar, so there is no ALB, target group or ACM certificate to register against; the same A-record lifecycle serves every game. |
| DNS cleanup ordering | Delete on STOPPED event, never in `stopWorkload` | App or watchdog deletes before `StopTask` | Deleting first would orphan a running task if `StopTask` failed (watchdog header, cited in `docs/intent/game-runtime/watchdog/watchdog-design.md`); `AwsCloudProvider.ts:457-458`. |
| Duplicate-start prevention | In-process per-game promise lock plus a `ListTasks` check | DynamoDB conditional lock; ECS `startedBy` idempotency token | Comment says `ListTasks` is eventually consistent and the lock is the real guard (`AwsCloudProvider.ts:319-347`); cross-process races not addressed [inferred]. |
| Cloud abstraction | `CloudProvider` interface in `@hyveon/shared`, AWS impl in `@hyveon/cloud-aws`, `EcsService` as adapter | Calling the ECS SDK directly from `EcsService` | Interface excludes SDK shapes so providers are swappable (`shared/src/cloud.ts:45-49`; `EcsService.ts:179-186`). |
| Public IP lookup | ENI from task attachments, then `DescribeNetworkInterfaces`, via a shared callback helper | Each caller re-implements; `shared` imports the EC2 SDK | Keeps `shared` free of SDK dependencies and lets each caller choose error handling (`ecsTask.ts:1-16,82-100`). |
| ENI-lag handling in update-dns | 5 attempts, 3 s apart, then give up | Longer backoff; re-queue the event | ENI association lags the RUNNING event (`update-dns/src/handler.ts:67-70`); the budget fits the 60 s timeout [inferred]. |
| Cost data source | Task-definition CPU/memory times static Fargate prices | Cost Explorer `GetCostAndUsage` | The app makes no Cost Explorer calls, so it needs no billed-cost data and no Cost Explorer permission; real billed spend is one click away because the Costs page links out to the AWS console. Cost Explorer calls are billed per request [inferred]. |
| Estimate refresh cadence | Once per mount | Every status poll | Avoids per-game `DescribeTaskDefinition` traffic every 20 s for data that only changes on apply (`game-status-provider.component.tsx:54-58`). |
| Status poll cadence | 20 s, build-time override, 1 s floor | Push via EventBridge to the app | The app has no inbound transport (desktop-only, no HTTP) [inferred]; override documented at `game-status-provider.component.tsx:16-21`. |
| Region for the provider | `ConfigService.getRegion()`, the install's one region | `outputs.awsRegion`; a game region from `DeploymentConfig.awsRegion` separate from the wizard region | One region per install (`docs/high-level-design.md`, decision 10); the outputs echo the same region once the program takes it from the wizard, so reading them adds a second source for one value. The provider still reads `outputs.awsRegion` (`EcsService.ts:72`, `IAC-ENGINE-REGION-002`). |
| Message strings as contract | Guard/launch errors carry operator-facing text, passed through unprefixed | Error codes mapped in the renderer | Preserves the pre-provider `EcsService` message contract (`EcsService.ts:108-125`; `AwsCloudProvider.ts:427-431`). |

## Open Questions & Future Decisions

### Resolved

1. ✅ Cost Explorer is not used; estimates are static and the console link covers billed spend (the Costs page links out to the AWS console for billed spend).
2. ✅ Running tasks carry the `Game` tag through `propagateTags: 'TASK_DEFINITION'` on both start paths (`AwsCloudProvider.ts:441`, `followup/src/handler.ts:136`).
3. ✅ HTTPS games use the shared Lambda DNS lifecycle with no load balancer (`update-dns/src/handler.ts:6-9,217-240`).
4. ✅ Every desktop ECS call, the provider's start, stop and status included, takes its region from `ConfigService.getRegion()`, not `outputs.awsRegion` (`IAC-ENGINE-REGION-002`; `docs/high-level-design.md`, decision 10).

### Deferred

1. Should update-dns DELETE send the stored record's TTL from `ListResourceRecordSets` rather than the current `DNS_TTL`, so an operator `dnsTtl` change cannot orphan a record (`update-dns/src/handler.ts:130-133,159`)?
2. Should DELETE skip when the record's IP is not the stopping task's IP, to protect a newer task's record from a late STOPPED event (`update-dns/src/handler.ts:141-166,235-238`)?
3. Should the STOPPED path clear, or PATCH with an error, a `PENDING#{taskArn}` row left by a task that never reached RUNNING (`update-dns/src/handler.ts:224-238`)?
4. Do the desktop and Discord start paths need a cross-process guard, given `withGameLock` covers only one process (`AwsCloudProvider.ts:328-336`, `followup/src/handler.ts:123-124`)?
5. Should the Fargate formula collapse onto `estimateFargateHourlyCost` (`gameServerValidator.ts:426-431`) instead of three copies (`CostService.ts:31-42`, `AwsCloudProvider.ts:312-317`)?
6. Should `costs.estimate` route through `CloudProvider.getCostEstimate`, or should that method be dropped from the interface (`shared/src/cloud.ts:55`, `costs.controller.ts:37-39`)?
7. Which fallback is correct for missing task-definition data: 1024/2048 (`EcsService.ts:372-373`) or 2048/8192 (`costs.controller.ts:39`, `AwsCloudProvider.ts:297-302`)?
8. Should `GameStatus`, `StartResult` and `CostEstimates` live only in `@hyveon/shared` instead of being redeclared in `EcsService.ts:148,162`, `CostService.ts:14`, `desktop-preload/src/hyveon-api.ts:100,126` and `web/src/api.service.ts:121,147`?
9. Should the followup Lambda's `findRunningTask`/`getStatus`/`runStart` share code with `AwsCloudProvider` rather than duplicate it (`followup/src/handler.ts:79-147`)?
10. `EcsService` logs raw `{ err }` objects (`EcsService.ts:330,352,377`) and update-dns logs the full event (`update-dns/src/handler.ts:252`), against `.claude/rules/logging.md`; normalise to messages?
11. Remove `EcsService.findRunningTask` (`EcsService.ts:281-287`, no production caller; the helper task uses the fail-closed `findRunningTaskOrThrow` at `:242-268`), the unused `_ec2` parameter (`:197-200`) and the dynamic import in `registerTaskDefinition` (`:388-390`)?
12. Should a status read that fails inside `findRunningTask` surface as `error` rather than `stopped` (`AwsCloudProvider.ts:371-374`)?
13. Should an UPSERT failure in update-dns be caught so the pending Discord message still gets an error PATCH (`update-dns/src/handler.ts:231-232`)?
14. Fix stale references: the retired `remove-cost-explorer-calls` change name cited in code comments at `CostService.ts:23`, `costs.controller.ts:13`, `shared/src/cloud.ts:35`, `AwsCloudProvider.ts:183`, `kpi-strip.component.tsx:57`, `costs.page.tsx:167,190` and `costs.spec.ts:18` (restate the rationale in the comment instead); "tfstate" in `costs.controller.ts:25-26`; `update_dns.py` in `update-dns/src/handler.ts:69`; the `CostsPage` page object's sidebar note (`app/packages/web/e2e/pages/CostsPage.ts:12,22-23`).
15. Renderer gaps: cost-fetch failures are silent and fetched twice (`game-status-provider.component.tsx:85`, `costs.page.tsx:172-180`); `refreshGame` cannot add a missing game (`game-status-provider.component.tsx:88-91`); Undo does not set `busy` (`use-game-actions.hook.ts:89-97`); the card's clipboard write is fire-and-forget (`game-card.component.tsx:195`).

## References

- Arrow doc: `docs/arrows/game-runtime/task-and-dns.md`
- EARS specs: `docs/intent/game-runtime/task-and-dns/task-and-dns-specs.md`
- Docs pages: `docs/docs/architecture.md`, `docs/docs/components/lambdas.md`, `docs/docs/components/management-app.md`, `docs/docs/app/dashboard.md`, `docs/docs/app/costs.md`
- Neighbouring leaves: `docs/intent/game-runtime/watchdog/watchdog-design.md`, `docs/intent/game-runtime/health-check/health-check-design.md`, `docs/intent/iac/program/program-design.md`; `game-server`, `discord-bot`, `helper-task`, `iac/engine` design docs (paths per the tree-mirrored layout, not all written yet)
