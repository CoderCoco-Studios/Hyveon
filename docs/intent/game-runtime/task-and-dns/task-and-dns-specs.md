# Game Task Lifecycle and DNS Specs

EARS requirements for prefix `RT-TASK`; design in `docs/intent/game-runtime/task-and-dns/task-and-dns-design.md`.

## Start and Stop

- [x] **RT-TASK-LAUNCH-001**: The desktop app shall start a game server only by issuing one ECS `RunTask` with `count: 1` against the game's `{game}-server` task definition, and shall never create or scale a persistent ECS Service. (observed: `AwsCloudProvider.ts:466-477`; CLAUDE.md invariant "No persistent ECS Service")
- [x] **RT-TASK-LAUNCH-002**: When the desktop app starts a game server, the `RunTask` request shall use the `FARGATE` launch type, the stack-output subnets and security group, and `assignPublicIp: ENABLED`. (observed: `AwsCloudProvider.ts:466-477`, `EcsService.ts:64-81`)
- [x] **RT-TASK-LAUNCH-003**: When the desktop app starts a game server via `AwsCloudProvider.startWorkload`, the `RunTask` request shall set `propagateTags: 'TASK_DEFINITION'` so the running task inherits the task definition's `Game` tag.
- [x] **RT-TASK-LAUNCH-004**: When the Discord followup Lambda starts a game server via `RunTask` in response to `/server-start`, the request shall set `propagateTags: 'TASK_DEFINITION'` so the running task inherits the task definition's `Game` tag.
- [x] **RT-TASK-LAUNCH-005**: If a desktop Start is requested for a game while a non-stopped task for that game's `{game}-server` family exists, then the desktop app shall refuse without calling `RunTask` and report `"{game} is already running."`. (observed: `AwsCloudProvider.ts:458-459,485`)
- [x] **RT-TASK-LAUNCH-006**: If a desktop Stop is requested for a game with no non-stopped task, then the desktop app shall refuse without calling `StopTask` and report `"{game} is not currently running."`. (observed: `AwsCloudProvider.ts:514`)
- [x] **RT-TASK-LAUNCH-007**: When the desktop app stops a game server, it shall call `StopTask` on the game's active task with reason `Stopped via management app` and shall perform no DNS change itself, leaving record cleanup to the update-dns Lambda's STOPPED path. (observed: `AwsCloudProvider.ts:500-522`; CLAUDE.md invariant "DNS records are Lambda-managed")
- [x] **RT-TASK-LAUNCH-008**: While no stack outputs exist, the desktop app shall refuse Start with `"Infrastructure is not deployed. Run Apply on the IaC page first."` and Stop with `"Infrastructure is not deployed."`. (observed: `AwsCloudProvider.ts:439,502`, `EcsService.ts:69`)
- [x] **RT-TASK-LAUNCH-009**: Within one desktop-app process, `AwsCloudProvider` shall serialise start and stop calls for the same game in call order, while calls for different games run concurrently, and a failed call shall not block the next queued call for that game. (observed: `AwsCloudProvider.ts:332-350`)
- [x] **RT-TASK-LAUNCH-010**: If a desktop Start and a Discord `/server-start` for the same game overlap, then the system shall launch at most one task for that game. (observed: `startWithLease` in `shared/src/aws/startLease.ts`, called from `AwsCloudProvider.startWorkload` and the followup Lambda's `runStart`)
- [x] **RT-TASK-LAUNCH-011**: If `RunTask` returns no tasks, then the desktop app shall report `"Failed to start {game}: {reason}"` using the first ECS failure reason, or `unknown` when none is given. (observed: `AwsCloudProvider.ts:479-481`)
- [x] **RT-TASK-LAUNCH-012**: When a desktop Start succeeds, `EcsService.start` shall return `success: true`, the task ARN, and the message `"{game} is starting. It may take 2–5 minutes."`; when a desktop Stop succeeds, `EcsService.stop` shall return `success: true` and `"{game} is stopping."`. (observed: `EcsService.ts:316-356`)
- [x] **RT-TASK-LAUNCH-013**: If a desktop Start or Stop fails with a guard refusal or launch failure, then `EcsService` shall return `success: false` with the provider's message unprefixed; for any other error it shall return `String(err)`. (observed: `EcsService.ts:122-125,327-332,347-354`)
- [x] **RT-TASK-LAUNCH-014**: If a desktop Start or Stop fails with a non-guard error, then `EcsService` shall log the normalised error message rather than the raw error object.
- [x] **RT-TASK-LAUNCH-015**: When a Start begins, the desktop app and the followup Lambda shall acquire a lease by a conditional put of `LAUNCH#{game}` / `LOCK` in the Discord table that succeeds only when no row exists or its `expiresAt` has passed, with a TTL of 120 seconds, re-check for a running task, and pass the lease id as the `RunTask` `clientToken`; if the lease write or the re-check errors, then the Start shall fail without calling `RunTask`. (observed: `startLease.ts`)
- [x] **RT-TASK-LAUNCH-016**: If a Start finds the lease held by another start, then the desktop app shall refuse with `"A start for {game} is already in progress."` and the Discord reply shall carry the same text prefixed with the failure marker, without calling `RunTask`; a refusal for an already-running task or a failed launch shall release the lease. (observed: `startInProgressMessage` in `startLease.ts`)

## Status

- [x] **RT-TASK-STATUS-001**: While no stack outputs exist, the desktop app's workload status for any game shall be `not_deployed` with message `"Run Apply on the IaC page first."`. (observed: `AwsCloudProvider.ts:545-546`)
- [x] **RT-TASK-STATUS-002**: When a game's non-stopped task has `lastStatus` `RUNNING`, the desktop app's status shall be `running` with the task ARN, the ENI's public IP when it resolves, and hostname `{game}.{domain}` when a domain is configured. (observed: `AwsCloudProvider.ts:551-561`)
- [x] **RT-TASK-STATUS-003**: When a game's non-stopped task has any `lastStatus` other than `RUNNING`, `STOPPED` or `DEPROVISIONING`, the desktop app's status shall be `starting` with the task ARN. (observed: `AwsCloudProvider.ts:395-396,562`)
- [x] **RT-TASK-STATUS-004**: When no non-stopped task exists for a game's `{game}-server` family, the desktop app's status shall be `stopped`. (observed: `AwsCloudProvider.ts:564`)
- [x] **RT-TASK-STATUS-005**: If resolving one game's status throws, including during credential or config resolution, then the desktop app shall report `error` with `String(err)` for that game only, without failing the status read for other games. (observed: `AwsCloudProvider.ts:544-546,565-567`)
- [x] **RT-TASK-STATUS-006**: If the ENI public-IP lookup fails for a running task, then the desktop app shall report `running` without a public IP and log the failure through the injected logger. (observed: `AwsCloudProvider.ts:404-419`, `EcsService.ts:92-94`)
- [x] **RT-TASK-STATUS-007**: `EcsService.getStatus` shall map a `WorkloadStatus` onto the `GameStatus` shape by passing through `state`, `publicIp`, `hostname` and `message` and renaming `workloadId` to `taskArn`. (observed: `EcsService.ts:295-306`)
- [x] **RT-TASK-STATUS-008**: The `GameStatus`, `StartResult` and `CostEstimates` shapes shall be declared once in `@hyveon/shared` and imported by `desktop-main`, `desktop-preload` and `web`.

## DNS Lifecycle

- [x] **RT-TASK-DNS-001**: The infra program shall declare no per-game DNS record; the update-dns Lambda shall be the only writer of `{game}.{domain}` A records. (observed: CLAUDE.md invariant; `update-dns/src/handler.ts:98-170`; `infra/src/route53.ts` declares a hosted-zone lookup only)
- [x] **RT-TASK-DNS-002**: The update-dns Lambda shall be invoked by an EventBridge rule matching `aws.ecs` `ECS Task State Change` events for this deployment's cluster ARN with `lastStatus` `RUNNING` or `STOPPED`. (observed: `infra/src/lambdas.ts:660-675`)
- [x] **RT-TASK-DNS-003**: When the update-dns Lambda receives an event whose `detail.group` family is not a configured `{game}-server` family, including the helper task's family, it shall return `skipped` and make no Route 53 or Discord call. (observed: `update-dns/src/handler.ts:257-263`)
- [x] **RT-TASK-DNS-004**: When the update-dns Lambda receives a RUNNING event for a game task, it shall resolve the task's public IP from its ENI with up to five attempts spaced 3 s apart before giving up. (observed: `update-dns/src/handler.ts:71-96`)
- [x] **RT-TASK-DNS-005**: When the update-dns Lambda resolves a RUNNING game task's public IP, it shall UPSERT an A record `{game}.{DOMAIN_NAME}` to that IP with TTL `DNS_TTL`. (observed: `update-dns/src/handler.ts:98-118,231`)
- [x] **RT-TASK-DNS-006**: If the update-dns Lambda cannot resolve a RUNNING game task's public IP, then it shall make no Route 53 change and return `no_ip`. (observed: `update-dns/src/handler.ts:224-229`)
- [x] **RT-TASK-DNS-007**: When the update-dns Lambda receives a STOPPED event for a game task and an A record `{game}.{DOMAIN_NAME}` exists, it shall issue a Route 53 DELETE for that record. (observed: `update-dns/src/handler.ts:141-166,235-238`)
- [x] **RT-TASK-DNS-008**: When the update-dns Lambda receives a STOPPED event for a game task and no A record `{game}.{DOMAIN_NAME}` exists, it shall log and return without a Route 53 change. (observed: `update-dns/src/handler.ts:142-146`)
- [x] **RT-TASK-DNS-009**: When the update-dns Lambda deletes a game's A record on STOPPED, the DELETE shall carry the existing record's TTL and value as read from Route 53, so a `dnsTtl` change between UPSERT and DELETE cannot leave the record behind.
- [ ] **RT-TASK-DNS-010**: If a STOPPED event arrives for a game task that is not the task the game's current A record was written for, then the update-dns Lambda shall leave the record in place. (gap: the STOPPED event carries no public IP and the stopped task's ENI is already deleted, so ownership cannot be proved from the IP without an `ecs:ListTasks` grant on the update-dns role; see the design doc's Open Questions)
- [x] **RT-TASK-DNS-011**: HTTPS game tasks (Caddy sidecar, `https: true`) shall use the same update-dns A-record path as every other game: UPSERT to the task's public IP on RUNNING and DELETE on STOPPED.
- [x] **RT-TASK-DNS-012**: The update-dns Lambda source and its wiring in `infra/src/lambdas.ts` shall contain no ELBv2 API call, no `ALB_TARGET_GROUPS` or `HTTPS_GAMES` environment variable, and no `elasticloadbalancing` IAM statement.
- [x] **RT-TASK-DNS-013**: The update-dns Lambda shall read its region from `AWS_REGION_` first, falling back to `AWS_REGION`, `AWS_DEFAULT_REGION`, then `us-east-1`. (observed: `update-dns/src/handler.ts:51-59`; CLAUDE.md invariant "Lambda env vars use `AWS_REGION_`")
- [x] **RT-TASK-DNS-014**: The update-dns Lambda shall log identifiers from each EventBridge event (task ARN, family, `lastStatus`) rather than the full event JSON.
- [x] **RT-TASK-DNS-015**: The shared ENI helpers (`getTaskEniId`, `getTaskPrivateIp`, `resolveEniPublicIp` in `@hyveon/shared/aws/ecsTask`) shall use structural types and a caller-supplied `DescribeNetworkInterfaces` callback, importing no `@aws-sdk/*` package. (observed: `shared/src/aws/ecsTask.ts:1-16,68-107`; CLAUDE.md invariant on the shared barrel)

## Discord Follow-up on Task State

- [x] **RT-TASK-NOTIFY-001**: Where the update-dns Lambda's `TABLE_NAME` is set, when it UPSERTs a RUNNING game task's record and a `PENDING#{taskArn}` row exists, it shall PATCH that Discord interaction with the formatted running status (hostname, IP, per-game connect message and port) and delete the row. (observed: `update-dns/src/handler.ts:176-198,232`)
- [x] **RT-TASK-NOTIFY-002**: Where the update-dns Lambda's `TABLE_NAME` is set, if a RUNNING game task's public IP cannot be resolved and a `PENDING#{taskArn}` row exists, then it shall PATCH that interaction with an error status and delete the row. (observed: `update-dns/src/handler.ts:187-193,224-228`)
- [x] **RT-TASK-NOTIFY-003**: Where the update-dns Lambda's `TABLE_NAME` is empty, it shall skip every pending-interaction lookup. (observed: `update-dns/src/handler.ts:181`)
- [x] **RT-TASK-NOTIFY-004**: If the update-dns Lambda's Discord PATCH or pending-row delete fails, then it shall log the failure and still return the DNS result. (observed: `update-dns/src/handler.ts:195-197`)
- [x] **RT-TASK-NOTIFY-005**: Where the update-dns Lambda's `TABLE_NAME` is set, when a STOPPED event arrives for a game task with a `PENDING#{taskArn}` row (a task that stopped before reaching RUNNING), it shall PATCH the interaction with an error status and delete the row.
- [x] **RT-TASK-NOTIFY-006**: If the update-dns Lambda's RUNNING-path UPSERT fails and a `PENDING#{taskArn}` row exists, then it shall PATCH the interaction with an error status before failing the invocation.

## Cost Estimates

- [x] **RT-TASK-COST-001**: The app shall not make any AWS Cost Explorer API request, including `GetCostAndUsage`, from any code path, automatic or user-triggered.
- [x] **RT-TASK-COST-002**: No `CloudProvider` implementation, desktop-main service, controller or IPC channel shall expose a method that calls the AWS Cost Explorer API.
- [x] **RT-TASK-COST-003**: When an operator navigates to the Dashboard route (`/`), on that or any later mount, the app shall make no AWS Cost Explorer API request.
- [x] **RT-TASK-COST-004**: When an operator navigates to the Costs page (`/costs`), the app shall make no AWS Cost Explorer API request.
- [x] **RT-TASK-COST-005**: While an operator navigates between the Dashboard and Costs page any number of times in a session, the app's cumulative AWS Cost Explorer request count shall remain zero.
- [x] **RT-TASK-COST-006**: The `costs.estimate` IPC channel shall derive each configured game's estimate only from its `{game}-server` task-definition CPU/memory (via `DescribeTaskDefinition`) and the static Fargate on-demand constants `FARGATE_VCPU_PER_HOUR` and `FARGATE_GB_PER_HOUR`.
- [x] **RT-TASK-COST-007**: The `costs.estimate` IPC channel shall return, per game, `vcpu` (cpu/1024), `memoryGb` (memory/1024), `costPerHour` (4 decimals), `costPerDay24h` (hourly × 24, 2 decimals) and `costPerMonth4hpd` (hourly × 4 × 30, 2 decimals), plus `totalPerHourIfAllOn` as the sum of `costPerHour`. (observed: `CostService.ts:31-42`, `costs.controller.ts:42-47`)
- [x] **RT-TASK-COST-008**: While no stack outputs exist, the `costs.estimate` IPC channel shall return `{ games: {}, totalPerHourIfAllOn: 0 }`. (observed: `costs.controller.ts:31-34`)
- [x] **RT-TASK-COST-009**: When the Costs page loads and Cost Explorer has never been called, the per-game estimates table shall render `$/hour`, `$/day` and `$/month` figures for every configured game.
- [x] **RT-TASK-COST-010**: The desktop app shall compute a Fargate hourly cost from CPU/memory through one shared function, used by the wizard estimate and `CostService`.
- [x] **RT-TASK-COST-011**: If a game's task-definition CPU or memory is missing or its describe fails, then the `costs.estimate` path shall apply the shared fallback of 2048 CPU units and 8192 MiB (`FALLBACK_TASK_CPU`, `FALLBACK_TASK_MEMORY`), from one declaration.
- [x] **RT-TASK-COST-012**: The `CloudProvider` interface shall expose no cost-estimate method; the `costs.estimate` IPC channel shall be the only per-game estimate path.

## Dashboard and Costs Page

- [x] **RT-TASK-UI-001**: The `GameStatusProvider` (mounted above the router) shall poll `games.status` on every route at 20 s by default, overridable at build time by `VITE_STATUS_POLL_MS` with values below 1000 ms ignored. (observed: `game-status-provider.component.tsx:22-29,82`)
- [x] **RT-TASK-UI-002**: If a `GameStatusProvider` status poll fails, then it shall expose the error to consumers and re-throw it to the polling registry, and clear it on the next successful poll. (observed: `game-status-provider.component.tsx:66-80`)
- [x] **RT-TASK-UI-003**: The `GameStatusProvider` shall fetch `costs.estimate` once on mount rather than on every status poll. (observed: `game-status-provider.component.tsx:54-58,84-86`)
- [x] **RT-TASK-UI-004**: If the renderer's `costs.estimate` fetch fails on the dashboard or the Costs page, then the renderer shall surface the failure to the operator rather than silently leaving estimates empty.
- [x] **RT-TASK-UI-005**: When the dashboard refreshes a single game's status, the renderer shall insert that game's status if the last full poll did not include it.
- [x] **RT-TASK-UI-006**: The dashboard game card shall enable Start only while the game is `stopped`, `not_deployed` or `error`, enable Stop only while it is `running` or `starting`, and disable both while an action is in flight. (observed: `game-card.component.tsx:150-151,240,258`)
- [x] **RT-TASK-UI-007**: The dashboard game card shall show the hostname when present, else the public IP, else `no hostname`, and shall show the public IP beside the hostname when both are present. (observed: `game-card.component.tsx:153,188,202-204`)
- [x] **RT-TASK-UI-008**: When the operator clicks Start or Stop on a dashboard game card, the renderer shall toast the result and, whether the call succeeded or failed, refresh that game's status after 3 s and then re-enable the card. (observed: `use-game-actions.hook.ts:6,43-52,54-72,108-112`)
- [x] **RT-TASK-UI-009**: When a dashboard Stop succeeds, the renderer shall show a 5 s toast with an Undo action that calls `games.start` for the same game. (observed: `use-game-actions.hook.ts:80-104`)
- [x] **RT-TASK-UI-010**: While a dashboard Undo-after-Stop start is in flight, the game card shall disable its Start and Stop buttons.
- [x] **RT-TASK-UI-011**: The dashboard KPI strip's "Current run rate" tile shall show the sum of `costPerHour` across games whose status is `running`, derived only from the `costs.estimate` result and current statuses.
- [x] **RT-TASK-UI-012**: While no configured game is `running`, the dashboard KPI strip's "Current run rate" tile shall show `$0.00`.
- [x] **RT-TASK-UI-013**: The dashboard KPI strip's "Est. month cap" tile shall show `totalPerHourIfAllOn × 24 × days in the current calendar month`.
- [x] **RT-TASK-UI-014**: The Costs page shall display a callout linking to the static AWS Cost Explorer console home URL, with no query-string filters.
- [x] **RT-TASK-UI-015**: The app shall render no chart, card or figure claiming to show actual historical billed spend on any page.
- [x] **RT-TASK-UI-016**: When the operator clicks Files on a dashboard game card, the renderer shall navigate to that game's file-browser route `/games/{game}/files` with `autoStart: true` router state, rather than opening an in-page file-manager dialog. (observed: `dashboard.page.tsx:80`)

## Retired IDs

These IDs are not reused.

- `RT-TASK-STATUS-009` (one region source for every desktop ECS call): superseded by IAC-ENGINE-REGION-002, which sets `ConfigService.getRegion()` as the region source for every desktop AWS client, the ECS calls included.
