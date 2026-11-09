---
parent: game-runtime
prefix: RT-TASK
---

# Game Task Lifecycle and DNS

## Context and Design Philosophy

Hyveon only pays for a game server while it runs. This leaf is the part of the runtime that makes that true from the operator's side: a Start click becomes one ECS `RunTask` against the game's `{game}-server` task definition, a Stop click becomes one `StopTask`, and nothing keeps a task alive in between (`app/packages/cloud-aws/src/AwsCloudProvider.ts:437-522`). Because a Fargate task gets a fresh public IP every launch, the leaf also owns keeping `{game}.{domain}` pointed at whatever task is running, through the update-dns Lambda reacting to ECS task-state events (`app/packages/lambda/update-dns/src/handler.ts:251-268`). Finally it surfaces the result on the dashboard: a polled status per game and a cost estimate computed from task-definition CPU/memory, never from billed data.

What it owns:

- The `CloudProvider` contract for workloads (`app/packages/shared/src/cloud.ts:50-56`) and its AWS implementation: start, stop, status, log streaming and cost estimate (`AwsCloudProvider.ts:437-665`).
- The Nest facade `EcsService` that maps provider results onto the app's `GameStatus`/`StartResult` shapes (`app/packages/desktop-main/src/services/EcsService.ts:295-356`), plus raw ECS helpers it exposes to other leaves.
- The update-dns Lambda: UPSERT on `RUNNING`, DELETE on `STOPPED`, and the RUNNING-side Discord follow-up PATCH.
- The shared ENI helpers `getTaskEniId`, `getTaskPrivateIp`, `resolveEniPublicIp` (`app/packages/shared/src/aws/ecsTask.ts:53-107`).
- The `costs.estimate` channel and `CostService` arithmetic (`app/packages/desktop-main/src/controllers/costs.controller.ts:28-48`, `app/packages/desktop-main/src/services/CostService.ts:31-42`).
- The renderer side: `GameStatusProvider` polling, the dashboard cards and KPI strip, `useGameActions`, and the Costs page.

What it deliberately does not own:

- **The IPC channels for games.** `games.status`, `games.getStatus`, `games.start`, `games.stop` are declared in `GamesController` (`app/packages/desktop-main/src/controllers/games.controller.ts:71-122`), owned by `game-server`; they are thin calls into `EcsService`.
- **Provisioning.** The `{game}-server` task definitions, the dns-updater function, its env vars and the EventBridge rule are `iac/program` resources (`app/packages/infra/src/ecs.ts`, `app/packages/infra/src/lambdas.ts:625-696`).
- **Stack outputs and region.** `ConfigService.getStackOutputs()`/`getRegion()` belong to `iac/engine`; this leaf only reads them.
- **The Discord start path.** `/server-start` issues its own `RunTask` from the followup Lambda (`app/packages/lambda/followup/src/handler.ts:117-147`) and writes the `PENDING#{taskArn}` row; both are `discord-bot`. This leaf only consumes that row on RUNNING.
- **Idle shutdown.** The watchdog (`game-runtime/watchdog`) stops tasks; DNS cleanup then flows through this leaf's STOPPED path.
- **The wizard's live estimate.** The Resources step renders `estimateFargateHourlyCost` (`app/packages/shared/src/gameServerValidator.ts`), which is `game-server`'s; this leaf's `CostService` calls the same pricing function.

CLAUDE.md invariants that live here:

- **No persistent ECS Service.** Holds: the only launch is `RunTaskCommand` with `count: 1` (`AwsCloudProvider.ts:466-477`); the class doc restates it (`EcsService.ts:175-177`).
- **DNS records are Lambda-managed.** Holds: `stopWorkload` does no DNS work and defers to the STOPPED event (`AwsCloudProvider.ts:495-496`); the Lambda owns UPSERT/DELETE.
- **TLS terminates in-task; no ALB.** Holds: update-dns has one path for every game, HTTPS or not, as the in-task TLS invariant requires: an HTTPS game needs no load balancer registration or separate DNS step.
- **Lambda env vars use `AWS_REGION_`.** Holds: `region()` reads `AWS_REGION_` first (`update-dns/src/handler.ts:51-59`) and the infra program sets it (`lambdas.ts:646`).
- **`@hyveon/shared` stays free of SDK imports.** Holds for this leaf's shared code: `ecsTask.ts` uses hand-rolled structural types and a caller-supplied describe callback (`ecsTask.ts:1-16,68-107`).

## Start, Stop and Status

### Desktop call chain

The renderer calls `api.start(game)` / `api.stop(game)`; `GamesController` forwards to `EcsService.start`/`stop`, which call the injected `CLOUD_PROVIDER` (`EcsService.ts:316-356`). The provider is built once from `buildProviderConfig`, which returns `null` until stack outputs exist and otherwise takes the region from `ConfigService.getRegion()` (the install's one region, never `outputs.awsRegion`) and fills credentials, cluster, subnets, security group and domain from those outputs (`EcsService.ts:64-81,104-106`).

`startWorkload` runs inside `withGameLock(game)`, a promise chain keyed by game that serialises start/stop for one game within the process while leaving different games concurrent. Inside the lock it calls `startWithLease` (`shared/src/aws/startLease.ts`), the same helper the followup Lambda's `runStart` uses, so a desktop Start and a Discord `/server-start` are serialised across processes. The helper takes a start lease by a conditional put of `LAUNCH#{game}` / `LOCK` with an `expiresAt` 120 seconds out into the Discord single-table, accepted only when no row exists or the existing `expiresAt` has passed (`attribute_not_exists(pk) OR expiresAt < :now`). A held lease refuses with `WorkloadGuardError("A start for {game} is already in progress.")` (Discord shows the same text after the failure marker). With the lease held it re-checks for a non-stopped task with `ListTasks(family, desiredStatus: RUNNING)` plus `DescribeTasks` through a strict variant that propagates SDK errors, refuses with `WorkloadGuardError("{game} is already running.")` if one exists, then sends `RunTask` with `FARGATE`, the stack's subnets and security group, `assignPublicIp: ENABLED`, `propagateTags: 'TASK_DEFINITION'`, and the lease id as `clientToken`. An empty `tasks` array becomes `WorkloadLaunchError("Failed to start {game}: {reason}")`. The lease is left to expire after a successful launch and released (an unconditional put of an already-expired row, so no `DeleteItem` grant) only when the pre-check refuses or the launch fails. A DynamoDB or pre-check error fails the start closed without calling `RunTask`. `ListTasks` is eventually consistent, so the lease, not the read, is what prevents duplicate starts. The table name comes from the `TABLE_NAME` env var in the Lambda and from `outputs.discordTableName` through `buildProviderConfig` on the desktop; a stack without it refuses the Start with an "out of date" guard error. The lease is not watchdog state (that lives in ECS task tags); it is a short-lived row beside the Discord pending rows and relies on the table's existing `expiresAt` TTL.

`stopWorkload` mirrors it: lock, find the task, refuse with `"{game} is not currently running."` if none, `StopTask` with reason `Stopped via management app` (`:462-484`).

`EcsService` turns these into `StartResult` (declared once in `@hyveon/shared`, with `GameStatus`, `GameEstimate` and `CostEstimates`; the preload bridge and the renderer re-export them): success messages `"{game} is starting. It may take 2–5 minutes."` and `"{game} is stopping."`; on failure `describeError` returns the guard/launch message unprefixed and `String(err)` for everything else (`EcsService.ts:122-125,321-332,347-354`). Guard refusals log at `warn`, other errors at `error`, and every `EcsService` log carries the normalised message (`errMessage`) rather than the raw error object (`:327-331,349-353`). The provider's comments call these message strings part of the UI contract (`AwsCloudProvider.ts:429-430,494-495`).

### Status states

`getWorkloadStatus` returns a `WorkloadStatus` (`shared/src/cloud.ts:16-23`), which `EcsService.getStatus` maps to `GameStatus` by renaming `workloadId` to `taskArn` (`EcsService.ts:295-306`).

| State | Condition (`AwsCloudProvider.ts:543-568`) | Extra fields |
|---|---|---|
| `not_deployed` | `getConfig()` returns null (no stack outputs) | `message: "Run Apply on the IaC page first."` |
| `running` | a non-stopped task with `lastStatus === 'RUNNING'` | `workloadId`, `publicIp` if the ENI resolves, `hostname = {game}.{domain}` if a domain is set |
| `starting` | a non-stopped task in any other status | `workloadId` |
| `stopped` | no non-stopped task found | none |
| `error` | anything thrown, including config resolution | `message: String(err)` |

Two behaviours follow from this table. First, `running` reflects the ECS task status only; it does not wait for the update-dns UPSERT, so the card can show a hostname a few seconds before the record exists [inferred from the independent paths at `AwsCloudProvider.ts:551-561` and `update-dns/src/handler.ts:224-231`]. Second, `findRunningTask` and `getPublicIp` swallow their errors and return `null` (`AwsCloudProvider.ts:372-375,416-419`), so a `ListTasks` failure reads as `stopped` and an EC2 failure as "running, no IP"; the injected logger is the only trace (`EcsService.ts:92-94`). The try around `getConfig()` exists so one game's credential failure does not reject the whole `games.status` `Promise.all` (`AwsCloudProvider.ts:544-546`, `games.controller.ts:71-78`).

The Discord followup Lambda repeats this status assembly and the find-running-task query in its own module (`followup/src/handler.ts:79-115`) and builds an identical `RunTask` request (`:127-138`), so three code paths (provider, followup status, followup start) share no implementation.

### Region

Every ECS call this leaf makes in the desktop app resolves its region through `ConfigService.getRegion()`, the install's one region (`IAC-ENGINE-REGION-002`, owned by `iac/engine`; `docs/high-level-design.md`, decision 10). `EcsService.getClient`, used by `getTaskDefinition` and every helper-task ECS call, does, and so does `buildProviderConfig`, which gives the provider the same region for start, stop and status. The Lambdas in this leaf take their region from `AWS_REGION_`, which the program sets from its `awsRegion` input.

### Renderer polling and actions

`GameStatusProvider` sits above the router and registers the `status` poller at `GAME_STATUS_INTERVAL_MS` (20 s, overridable by `VITE_STATUS_POLL_MS` with a 1 s floor) so polling continues on every route (`app/packages/web/src/polling/game-status-provider.component.tsx:22-29,45-53,82`). A poll failure sets `error` and re-throws so the polling registry records it (`:66-80`). `refreshGame` replaces one entry in the list, or appends it when the last full poll did not return that game. The one-time `costs.estimate` fetch exposes its failure as `estimatesError` and toasts it once; the Costs page reads the provider's estimates and renders the failure as an inline banner, so neither screen silently shows empty estimates.

`useGameActions` sets `busy`, calls start or stop, toasts the result, and always schedules a single-game refresh 3 s later that also clears `busy` (`app/packages/web/src/hooks/use-game-actions.hook.ts:6,43-52,54-114`). A successful Stop shows a 5 s toast with an Undo action that calls `api.start` with `busy` set until that start settles and its refresh runs, so the card cannot launch or stop the game meanwhile.

## DNS Lifecycle (update-dns Lambda)

### Trigger and configuration

The EventBridge rule `${projectName}-task-state-change` matches `aws.ecs` / `ECS Task State Change` filtered to this cluster's ARN and `lastStatus` in `RUNNING`, `STOPPED` (`lambdas.ts:660-675`). The function has a 60 s timeout and default memory (`lambdas.ts:626-639`).

| Env var | Source (`lambdas.ts:641-650`) | Use in handler |
|---|---|---|
| `HOSTED_ZONE_ID` | hosted-zone lookup | target zone (`handler.ts:37`) |
| `DOMAIN_NAME` | hosted-zone name, trailing dot stripped | record name `{game}.{DOMAIN_NAME}` (`:38,265`) |
| `GAME_NAMES` | CSV of `gameServers` keys | family-to-game map (`:39,49`) |
| `DNS_TTL` | `DeploymentConfig.dnsTtl` (default 30, `shared/src/deploymentConfig.ts:80,239`) | TTL on UPSERT (a DELETE echoes the stored record's TTL) (`:40,110`) |
| `AWS_REGION_` | stack region | ECS/EC2 clients (`:51-62`) |
| `TABLE_NAME` | Discord DynamoDB table | pending-interaction lookup; empty disables it (`:41,181`) |
| `CONNECT_MESSAGES`, `GAME_PORTS` | per-game maps from `gameServers` | Discord connect message (`:44,47,187-191`) |

### Event handling

The handler strips `family:` from `detail.group` and looks it up in `FAMILY_TO_GAME` (`{game}-server` to `{game}`, `shared/src/env.ts:64-66`); unknown families, including the helper task's, return `skipped` (`handler.ts:257-263`).

On `RUNNING`, `resolvePublicIp` tries up to five times with 3 s sleeps: `DescribeTasks`, pull the ENI from the task's attachments, `DescribeNetworkInterfaces`, take the public IP. Each attempt's errors are caught and logged. If no IP is found the handler PATCHes any pending Discord interaction with an error message and returns `no_ip` without touching DNS. Otherwise it UPSERTs an A record with `DNS_TTL`, then PATCHes the pending interaction with the formatted running status and deletes the row. Discord failures are logged and swallowed. An UPSERT failure PATCHes any pending interaction with an error status, then fails the invocation so Lambda's asynchronous invoke retries run; the pending row is kept so a successful retry overwrites the error message and deletes the row.

On `STOPPED`, `deleteDns` reads the current A record with `ListResourceRecordSets`; if none exists it logs and returns. Otherwise it sends DELETE echoing the stored record's TTL and IP, because Route 53 requires a DELETE to match the existing record set exactly and a `dnsTtl` change between a task's start and stop must not leave the record behind; a failure is logged as a warning. The delete does not compare the record with the stopping task's identity, so a late STOPPED for an old task could remove a newer task's record (an open question below). After the DELETE it consults the `PENDING#{taskArn}` row: a row still present means the task stopped before reaching RUNNING, so the Lambda PATCHes the interaction with an error status and deletes the row.

Other statuses return `no_action` (`:239`), though the rule already filters them out. The handler logs the task ARN, family and `lastStatus` on every invocation, never the full event.

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

Missing data uses one fallback: a task definition without `cpu`/`memory`, or a failed describe, estimates at `FALLBACK_TASK_CPU` / `FALLBACK_TASK_MEMORY` (2048 CPU units, 8192 MiB) from `@hyveon/shared`, deliberately the conservative (higher) figure for a cost display. `CostService` derives every figure from `fargateHourlyCostRaw`, the one place the pricing formula lives; `estimateFargateHourlyCost` rounds the same value for the wizard.

The dashboard derives its KPI tiles from the same estimate: "Current run rate" sums `costPerHour` over `running` games and "Est. month cap" is `totalPerHourIfAllOn × 24 × days in the current month` (`app/packages/web/src/components/kpi-strip.component.tsx:58-69`), using only free data. The Costs page's "$/month" column is the 4 h/day projection, so the two "month" numbers measure different things by design. `GameStatusProvider` fetches the estimate once on mount because polling it would add steady ECS traffic (`game-status-provider.component.tsx`); the Costs page reads that same result rather than fetching again.

`CloudProvider` carries no cost-estimate method: `costs.estimate` is the only per-game estimate path, so there is one implementation to keep correct.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| How a game runs | One-off `RunTask` per Start, `StopTask` per Stop | Persistent ECS Service scaled 0/1 | Cost model: a long-running Service "destroys the cost model" (CLAUDE.md; `EcsService.ts:171-177`). |
| Who owns DNS records | update-dns Lambda on ECS state-change events | Pulumi-managed per-game records; desktop app writes DNS on start | Records follow ephemeral task IPs "without fighting state" (`update-dns/src/handler.ts:242-246`); the desktop path cannot see watchdog or Discord starts [inferred]. |
| HTTPS games and DNS | Same A-record path as every game | ALB with target registration | TLS terminates in-task via a Caddy sidecar, so there is no ALB, target group or ACM certificate to register against; the same A-record lifecycle serves every game. |
| DNS cleanup ordering | Delete on STOPPED event, never in `stopWorkload` | App or watchdog deletes before `StopTask` | Deleting first would orphan a running task if `StopTask` failed (watchdog header, cited in `docs/intent/game-runtime/watchdog/watchdog-design.md`); `AwsCloudProvider.ts:495-496`. |
| Duplicate-start prevention | DynamoDB start lease (`LAUNCH#{game}` / `LOCK`, 120 s TTL, conditional put) taken by both launch paths through one shared helper, a strict fail-closed `ListTasks` re-check, and the lease id as the ECS `clientToken`; the in-process `withGameLock` stays as the same-process queue | ECS `startedBy` token alone; in-process lock plus `ListTasks` only | `ListTasks` is eventually consistent, and the in-process lock cannot span the desktop and the Lambda. The lease reuses the Discord table, its `expiresAt` TTL, and the followup role's existing `PutItem`; release writes an expired row so no `DeleteItem` is needed. Scope is Start against Start only. After a successful launch the lease is kept for its TTL, so a Stop followed by a Start inside 120 s is refused as in progress until it expires. Expiry compares each caller's clock, so skew of a few seconds is tolerated. |
| Cloud abstraction | `CloudProvider` interface in `@hyveon/shared`, AWS impl in `@hyveon/cloud-aws`, `EcsService` as adapter | Calling the ECS SDK directly from `EcsService` | Interface excludes SDK shapes so providers are swappable (`shared/src/cloud.ts:45-49`; `EcsService.ts:179-186`). |
| Public IP lookup | ENI from task attachments, then `DescribeNetworkInterfaces`, via a shared callback helper | Each caller re-implements; `shared` imports the EC2 SDK | Keeps `shared` free of SDK dependencies and lets each caller choose error handling (`ecsTask.ts:1-16,82-100`). |
| ENI-lag handling in update-dns | 5 attempts, 3 s apart, then give up | Longer backoff; re-queue the event | ENI association lags the RUNNING event (`update-dns/src/handler.ts:67-70`); the budget fits the 60 s timeout [inferred]. |
| Cost data source | Task-definition CPU/memory times static Fargate prices | Cost Explorer `GetCostAndUsage` | The app makes no Cost Explorer calls, so it needs no billed-cost data and no Cost Explorer permission; real billed spend is one click away because the Costs page links out to the AWS console. Cost Explorer calls are billed per request [inferred]. |
| Estimate refresh cadence | At app start and each time the Costs page mounts | Every status poll | Avoids per-game `DescribeTaskDefinition` traffic every 20 s for data that only changes on apply (`GameStatusProvider`). |
| Status poll cadence | 20 s, build-time override, 1 s floor | Push via EventBridge to the app | The app has no inbound transport (desktop-only, no HTTP) [inferred]; override documented at `game-status-provider.component.tsx:16-21`. |
| Region for the provider | `ConfigService.getRegion()`, the install's one region | `outputs.awsRegion`; a game region from `DeploymentConfig.awsRegion` separate from the wizard region | One region per install (`docs/high-level-design.md`, decision 10); the outputs echo the same region because the program takes it from the wizard, so reading them would add a second source for one value (`IAC-ENGINE-REGION-002`). |
| Message strings as contract | Guard/launch errors carry operator-facing text, passed through unprefixed | Error codes mapped in the renderer | Preserves the pre-provider `EcsService` message contract (`EcsService.ts:108-125`; `AwsCloudProvider.ts:428-430`). |
| Where cost estimation lives | `costs.estimate` and `CostService` only, over one shared pricing function and one fallback pair | A `CloudProvider.getCostEstimate` method beside the IPC channel | The provider method had no production caller and its own copies of the formula and a second fallback; removing it leaves one path. A conservative 2048/8192 fallback was chosen over 1024/2048 so a missing task-definition value never understates cost. |
| Pending Discord row on STOPPED | After the DELETE, a surviving `PENDING#{taskArn}` row gets an error PATCH and is deleted | Leave the row to expire; clear it silently | A task that stopped before RUNNING otherwise leaves the user's message on "starting" until the 15-minute token lapses. The row is normally deleted on RUNNING, so a row on STOPPED usually means the task never ran; it can also survive a RUNNING whose Discord PATCH or row delete failed (logged and swallowed) or whose UPSERT failed, in which case the STOPPED message reports the task as stopped before reaching RUNNING. |
| UPSERT failure | Error PATCH to a pending interaction, keep the `PENDING#` row, then rethrow | Swallow the failure and retry silently; delete the row with the error PATCH | The invocation still fails so Lambda's asynchronous invoke retries can recover, and the operator who clicked `/server-start` is told the DNS record was not published rather than waiting. The row is kept so a successful retry overwrites the error message with the running status and deletes the row; deleting it would leave the user on the error message after the retry succeeds. |
| Late STOPPED and a newer task's record (`RT-TASK-DNS-010`, `RT-TASK-DNS-016` to `RT-TASK-DNS-019`) | A TXT ownership record `_hyveon-owner.{game}.{domain}` holding the task ARN, UPSERTed in the same change batch as the A record at RUNNING. At STOPPED the Lambda lists the TXT and deletes the A and TXT records in one batch only when the ARN matches the stopping task; a mismatch or an unreadable TXT changes nothing and logs a warning with identifiers only. A successful lookup that finds an A record but no TXT is a legacy record and is deleted. | (a) grant the update-dns role `ecs:ListTasks` and skip the DELETE while another non-stopped task of the family exists; (b) write the owning task ARN to DynamoDB at RUNNING and compare at STOPPED; (c) keep the race deferred | The STOPPED event carries no public IP and the stopped task's ENI is gone, so ownership has to be recorded when the record is written. The 120 s start lease is taken only on Start and not on Stop, and `ListTasks` drops a stopping task immediately, so neither bars a Start inside the window in which a late STOPPED can arrive, which is why the race is closed rather than deferred. The TXT lives in the zone the role already writes (`ChangeResourceRecordSets`, `ListResourceRecordSets`), so no IAM change is needed; (a) widens the role, (b) adds a second store and a read path. The underscore-prefixed sibling label cannot collide with the game's A record and keeps ownership beside the record it guards. The A and TXT UPSERT is one batch, so a record is never published without its owner. A mismatch fails safe (the live record survives); an unreadable TXT also fails safe, while an absent TXT is a pre-ownership record that must still be cleaned up. |
| DELETE shape | Echo the stored TTL and IP from `ListResourceRecordSets` | Send the current `DNS_TTL` | Route 53 rejects a DELETE that differs from the stored record set, so a changed `dnsTtl` would orphan a record pointing at a released IP. |
| Shared payload types | `GameStatus`, `StartResult`, `GameEstimate`, `CostEstimates` declared in `@hyveon/shared`; preload and web re-export | Per-package copies | Four copies had to be edited together for any field change and could drift silently. |

## Open Questions & Future Decisions

### Resolved

1. ✅ Cost Explorer is not used; estimates are static and the console link covers billed spend (the Costs page links out to the AWS console for billed spend).
2. ✅ Running tasks carry the `Game` tag through `propagateTags: 'TASK_DEFINITION'` on both start paths (`AwsCloudProvider.ts:476`, `followup/src/handler.ts:150`).
3. ✅ HTTPS games use the shared Lambda DNS lifecycle with no load balancer.
4. ✅ Every desktop ECS call, the provider's start, stop and status included, takes its region from `ConfigService.getRegion()`, not `outputs.awsRegion` (`IAC-ENGINE-REGION-002`; `docs/high-level-design.md`, decision 10).

### Open

1. A RUNNING invocation can spend up to 15 s on IP retries while a STOPPED event for the same task clears the pending row, after which RUNNING UPSERTs a record for a dead task. The window is small and the next STOPPED or start cycle replaces the record; it is not guarded.
2. Should the followup Lambda's `findRunningTask`/`getStatus`/`runStart` share code with `AwsCloudProvider` rather than duplicate it (`followup/src/handler.ts:79-147`)?
3. Remove `EcsService.findRunningTask` (no production caller; the helper task uses the fail-closed `findRunningTaskOrThrow`), the unused `_ec2` parameter and the dynamic import in `registerTaskDefinition`?
4. Should a status read that fails inside `findRunningTask` surface as `error` rather than `stopped` (`AwsCloudProvider.ts:372-375`)?
5. Fix stale references: the retired `remove-cost-explorer-calls` change name cited in code comments (`CostService.ts`, `costs.controller.ts`, `shared/src/cloud.ts`, `AwsCloudProvider.ts`, `kpi-strip.component.tsx`, `costs.page.tsx`, `costs.spec.ts`), "tfstate" in `costs.controller.ts`, `update_dns.py` in `update-dns/src/handler.ts`, and the `CostsPage` page object's sidebar note; and the game card's fire-and-forget clipboard write (`game-card.component.tsx:195`).

## References

- Arrow doc: `docs/arrows/game-runtime/task-and-dns.md`
- EARS specs: `docs/intent/game-runtime/task-and-dns/task-and-dns-specs.md`
- Docs pages: `docs/docs/architecture.md`, `docs/docs/components/lambdas.md`, `docs/docs/components/management-app.md`, `docs/docs/app/dashboard.md`, `docs/docs/app/costs.md`
- Neighbouring leaves: `docs/intent/game-runtime/watchdog/watchdog-design.md`, `docs/intent/game-runtime/health-check/health-check-design.md`, `docs/intent/iac/program/program-design.md`; `game-server`, `discord-bot`, `helper-task`, `iac/engine` design docs (paths per the tree-mirrored layout, not all written yet)
