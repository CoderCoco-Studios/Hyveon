# Idle Watchdog Specs

EARS requirements for the idle watchdog, prefix `RT-WATCHDOG`; design in `docs/intent/game-runtime/watchdog/watchdog-design.md`.

## Schedule and provisioning

- [x] **RT-WATCHDOG-SCHED-001**: The infra program shall provision exactly one watchdog Lambda, `${projectName}-watchdog`, with a 60 s timeout and Lambda's default memory, invoked by an EventBridge rule `${projectName}-watchdog-schedule`. (observed)
- [x] **RT-WATCHDOG-SCHED-002**: The watchdog EventBridge rule shall use the schedule expression `rate(N minutes)` where N is `DeploymentConfig.watchdogIntervalMinutes`, and `rate(1 minute)` (singular) when that value is 1. (observed)
- [x] **RT-WATCHDOG-SCHED-003**: The infra program shall set the watchdog's `CHECK_WINDOW_MINUTES` env var from the same `watchdogIntervalMinutes` value that drives the watchdog schedule, so each watchdog run looks back exactly one schedule interval. (observed)
- [x] **RT-WATCHDOG-SCHED-004**: The infra program shall grant `events.amazonaws.com` permission to invoke the watchdog Lambda only from the watchdog schedule rule's ARN. (observed)
- [x] **RT-WATCHDOG-SCHED-005**: The watchdog Lambda shall ignore its invocation event payload and perform a full stateless pass over the cluster on every invocation. (observed)
- [x] **RT-WATCHDOG-SCHED-006**: When the operator changes `watchdogIntervalMinutes`, `watchdogIdleChecks` or `watchdogMinBytesPerSecond`, the deployed watchdog shall keep its previous values until the next infra apply, because the tunables reach the watchdog only as env vars and the schedule expression set at apply time.

## Task selection

- [x] **RT-WATCHDOG-SCOPE-001**: When the watchdog runs, it shall list every task with desired status `RUNNING` in `ECS_CLUSTER`, following `ListTasks` pagination until no `nextToken` remains. (observed)
- [x] **RT-WATCHDOG-SCOPE-002**: When the watchdog's `ListTasks` pass returns no task ARNs, the watchdog shall return `{ checked: 0 }` without calling `DescribeTasks`. (observed)
- [x] **RT-WATCHDOG-SCOPE-003**: When evaluating described tasks, the watchdog shall skip any task whose `lastStatus` is not `RUNNING` or that has no task ARN. (observed)
- [x] **RT-WATCHDOG-SCOPE-004**: The watchdog shall evaluate only tasks whose `group` is `family:{game}-server` for a game listed in `GAME_NAMES`, and shall skip every other task in the cluster, including helper tasks and families that match an inherited `Object.prototype` key. (observed)
- [ ] **RT-WATCHDOG-SCOPE-005**: When more than 100 RUNNING tasks are listed in `ECS_CLUSTER`, the watchdog shall describe them in batches of at most 100 so that every listed task is evaluated in that run. (observed) (gap: `app/packages/lambda/watchdog/src/handler.ts:200` passes every ARN to one `DescribeTasks` call)
- [x] **RT-WATCHDOG-SCOPE-006**: The watchdog shall treat an HTTPS game's `{game}-server` task exactly like any other game's task for idle evaluation and shutdown. (observed)

## Verdict source routing

- [x] **RT-WATCHDOG-ROUTE-001**: When the watchdog evaluates a running task of a game that has an entry in `HEALTH_CHECKS`, it shall take the idle verdict from the health-check Lambda and shall not query CloudWatch for that task. (OpenSpec: game-health-checks / A game may declare an authoritative health check)
- [x] **RT-WATCHDOG-ROUTE-002**: When the watchdog evaluates a running task of a game that has no entry in `HEALTH_CHECKS`, it shall take the idle verdict from the CloudWatch packet measurement and shall not invoke the health-check Lambda for that task. (OpenSpec: game-health-checks / A game may declare an authoritative health check)
- [x] **RT-WATCHDOG-ROUTE-003**: The watchdog shall apply exactly one verdict source to each evaluated game-server task per run, never a combination of the health check and the packet measurement. (OpenSpec: game-health-checks / A game may declare an authoritative health check)
- [x] **RT-WATCHDOG-ROUTE-004**: The infra program shall build the watchdog's `HEALTH_CHECKS` env var as a JSON object mapping each game name, in sorted key order, to its full declared `healthCheck`, omitting every game with no declared health check. (observed)

## CloudWatch traffic verdict

- [x] **RT-WATCHDOG-CW-001**: When the watchdog uses the traffic measurement for a game-server task, it shall query CloudWatch `GetMetricStatistics` for namespace `ECS/ContainerInsights`, metric `NetworkRxBytes`, dimensions `ClusterName` equal to `ECS_CLUSTER` and `TaskDefinitionFamily` equal to the task's `{game}-server` family, statistic `Average`, over the last `CHECK_WINDOW_MINUTES` with a period of `CHECK_WINDOW_MINUTES * 60` seconds.
- [x] **RT-WATCHDOG-CW-002**: When the watchdog uses the traffic measurement, it shall identify the task by its task definition family alone, without reading the task's ENI attachment or calling EC2.
- [x] **RT-WATCHDOG-CW-004**: When the traffic measurement returns an `Average` for a game-server task, the watchdog shall treat the task as idle for that window if the value is below `MIN_BYTES_PER_SECOND`, and active otherwise.
- [x] **RT-WATCHDOG-CW-005**: If the CloudWatch traffic query for a game-server task returns no datapoint, then the watchdog shall treat the task as active for that window. (observed)
- [x] **RT-WATCHDOG-CW-006**: If the CloudWatch traffic query for a game-server task throws, then the watchdog shall log a warning and treat the task as active for that window. (observed)
- [x] **RT-WATCHDOG-CW-007**: Where a game declares no health check, the watchdog's idle measurement shall return data that reflects the Fargate task's real inbound traffic, so that an idle game without a health check is eventually stopped. (observed)

## Health-check verdict

- [x] **RT-WATCHDOG-HC-001**: When the watchdog evaluates a task of a game with a declared health check, it shall invoke `HEALTH_CHECK_FUNCTION_NAME` synchronously (`RequestResponse`) with the payload `{ game, taskArn, healthCheck }`, forwarding the declaration verbatim. (observed)
- [x] **RT-WATCHDOG-HC-002**: When the health-check Lambda returns a well-formed verdict to the watchdog, the watchdog shall treat the task as idle for that window exactly when the verdict's `active` is `false`. (observed)
- [x] **RT-WATCHDOG-HC-003**: If a game declares a health check but `HEALTH_CHECK_FUNCTION_NAME` is empty or unset, then the watchdog shall treat that game's task as active with a failure-derived reason, without attempting an invoke. (OpenSpec: game-health-checks / A failed check reports the server as active)
- [x] **RT-WATCHDOG-HC-004**: If the watchdog's health-check invoke throws, returns a `FunctionError`, returns an unparseable payload, or returns a payload without a boolean `active` and a string `reason`, then the watchdog shall treat the task as active with a failure-derived reason naming the failure. (OpenSpec: game-health-checks / A failed check reports the server as active)
- [x] **RT-WATCHDOG-HC-005**: The watchdog shall never resolve a health check's `auth.secretArn` itself; secret resolution is left to the health-check Lambda. (observed)
- [ ] **RT-WATCHDOG-HC-006**: While a watchdog run is evaluating several games with declared health checks, the watchdog shall bound the total time spent on health-check invokes so that slow or hung checks cannot exhaust the watchdog's 60 s timeout before every remaining task is evaluated. (observed) (gap: `handler.ts:203-255` invokes sequentially with `RequestResponse`; the health-check function's 30 s timeout at `app/packages/infra/src/lambdas.ts:547` allows two hung checks to exceed the watchdog's 60 s at `lambdas.ts:568`)

## Idle-count state

- [x] **RT-WATCHDOG-STATE-001**: The watchdog shall keep its only per-task state, the consecutive-idle count, in the `idle_checks` ECS resource tag on the game-server task ARN, and shall use no DynamoDB table, SSM parameter or other store. (observed)
- [x] **RT-WATCHDOG-STATE-002**: If a game-server task's `idle_checks` tag is missing, non-numeric, or the watchdog's `ListTagsForResource` call fails, then the watchdog shall treat the task's idle count as 0. (observed)
- [x] **RT-WATCHDOG-STATE-003**: When a game-server task is idle for the current window and the incremented idle count is below `IDLE_CHECKS`, the watchdog shall write the incremented count to the task's `idle_checks` tag. (observed)
- [x] **RT-WATCHDOG-STATE-004**: When a game-server task is active for the current window and its idle count is greater than 0, the watchdog shall reset the task's `idle_checks` tag to 0. (observed)
- [x] **RT-WATCHDOG-STATE-005**: When a game-server task is active for the current window and its idle count is already 0, the watchdog shall not write the `idle_checks` tag. (observed)
- [x] **RT-WATCHDOG-STATE-006**: If writing a game-server task's `idle_checks` tag fails, then the watchdog shall log a warning and continue evaluating the remaining tasks in that run. (observed)
- [x] **RT-WATCHDOG-STATE-007**: When a game-server task's failure-derived health-check verdict is reported as active, the watchdog shall not increment that task's idle count. (OpenSpec: game-health-checks / A failed check reports the server as active)

## Shutdown

- [x] **RT-WATCHDOG-STOP-001**: When a game-server task is idle for the current window and its incremented idle count reaches or exceeds `IDLE_CHECKS`, the watchdog shall call `StopTask` on that task in `ECS_CLUSTER` with reason `Watchdog: idle for {count * CHECK_WINDOW_MINUTES} minutes`, and shall not write the `idle_checks` tag for that window. (observed)
- [x] **RT-WATCHDOG-STOP-002**: The watchdog shall not create, update or delete any Route 53 record; DNS removal for a watchdog-stopped task is left to update-dns reacting to the resulting `STOPPED` task-state event. (observed)
- [x] **RT-WATCHDOG-STOP-003**: The watchdog Lambda source shall contain no load-balancer target-registration path, no ELBv2 API call, and no `ALB_TARGET_GROUPS` or `HTTPS_GAMES` configuration. (OpenSpec: in-task-tls-termination / HTTPS games use the Lambda-managed DNS lifecycle)
- [ ] **RT-WATCHDOG-STOP-004**: If `StopTask` fails for one game-server task, then the watchdog shall log the failure and continue evaluating the remaining tasks in that run. (observed) (gap: `handler.ts:239-245` awaits `StopTaskCommand` with no try/catch, aborting the run)

## Logging

- [x] **RT-WATCHDOG-LOG-001**: When a game-server task is idle for the current window, the watchdog shall log the game, the incremented idle count against `IDLE_CHECKS`, and the verdict detail (the health-check reason, or `rxBytesPerSecond=N, threshold=MIN_BYTES_PER_SECOND`). (OpenSpec: game-health-checks / The basis for a shutdown decision is recoverable from the logs)
- [x] **RT-WATCHDOG-LOG-002**: When the watchdog resets a game-server task's idle count after an active window, it shall log the game and the verdict detail that caused the reset. (OpenSpec: game-health-checks / The basis for a shutdown decision is recoverable from the logs)
- [x] **RT-WATCHDOG-LOG-003**: When the watchdog stops a game-server task, it shall log the game, the idle count and the computed idle minutes before calling `StopTask`. (OpenSpec: game-health-checks / The basis for a shutdown decision is recoverable from the logs)
- [x] **RT-WATCHDOG-LOG-004**: When a health-check verdict received by the watchdog is failure-derived, the watchdog shall log it at warn level with the game and the failure reason. (OpenSpec: game-health-checks / The basis for a shutdown decision is recoverable from the logs)
- [x] **RT-WATCHDOG-LOG-005**: The watchdog's health-check log lines shall carry only the game name and the verdict reason, never the health-check declaration, credential values, or game-response bodies. (OpenSpec: game-health-checks / The basis for a shutdown decision is recoverable from the logs)

## Configuration

- [x] **RT-WATCHDOG-CFG-001**: If `ECS_CLUSTER` is unset when the watchdog module initialises, then the watchdog shall throw at module init. (observed)
- [x] **RT-WATCHDOG-CFG-002**: When `IDLE_CHECKS`, `MIN_BYTES_PER_SECOND` or `CHECK_WINDOW_MINUTES` is absent from the watchdog's environment, the watchdog shall default them to 4, 1000 and 15 respectively.
- [x] **RT-WATCHDOG-CFG-003**: If the watchdog's `HEALTH_CHECKS` env var is absent or not valid JSON, then the watchdog shall treat it as an empty map without throwing, routing every game to the traffic measurement. (observed)
- [x] **RT-WATCHDOG-CFG-004**: The watchdog shall resolve its AWS region from `AWS_REGION_`, then `AWS_REGION`, then `AWS_DEFAULT_REGION`, then `us-east-1`, and the infra program shall set `AWS_REGION_` on the watchdog function. (observed)
- [x] **RT-WATCHDOG-CFG-005**: When the operator saves deployment settings, the system shall reject a `watchdogIntervalMinutes`, `watchdogIdleChecks` or `watchdogMinBytesPerSecond` value that is not a positive integer.
- [x] **RT-WATCHDOG-CFG-006**: Where `DeploymentConfig` omits the watchdog tunables, the system shall default `watchdogIntervalMinutes` to 15, `watchdogIdleChecks` to 4 and `watchdogMinBytesPerSecond` to 1000.
- [x] **RT-WATCHDOG-CFG-007**: The watchdog shall not read `deployment-config.json` or any S3 object at runtime. (observed)

## IAM

- [x] **RT-WATCHDOG-IAM-001**: The watchdog Lambda's policy shall grant log writes, `ecs:ListTasks`, `ecs:DescribeTasks`, `ecs:StopTask`, `ecs:TagResource`, `ecs:ListTagsForResource` and `cloudwatch:GetMetricStatistics`. (observed)
- [x] **RT-WATCHDOG-IAM-002**: Where at least one game declares a health check, the watchdog Lambda's policy shall grant `lambda:InvokeFunction` on the health-check function's ARN only; otherwise it shall grant no `lambda:InvokeFunction`. (observed)
- [x] **RT-WATCHDOG-IAM-003**: The watchdog Lambda's policy shall contain no `secretsmanager`, `route53` or `elasticloadbalancing` actions. (OpenSpec: in-task-tls-termination / HTTPS games use the Lambda-managed DNS lifecycle)

## Settings panel

- [x] **RT-WATCHDOG-UI-001**: The Settings page's `WatchdogPanel` shall be a static card with no IPC call and no inputs that points the operator to the General form's "Watchdog tuning" section and states the tunables take effect on the next apply. (observed)

## Documentation

- [x] **RT-WATCHDOG-DOC-001**: `docs/docs/guides/user.md` and `docs/diagrams/control-loops.d2` shall describe the watchdog as issuing `StopTask` only, with update-dns removing the DNS record on the resulting `STOPPED` event. (OpenSpec: operator-documentation / Documentation contains no references to removed infrastructure)
- [ ] **RT-WATCHDOG-DOC-002**: No page under `docs/docs/**` shall describe the watchdog as writing or deleting DNS records. (OpenSpec: operator-documentation / Documentation contains no references to removed infrastructure) (gap: `docs/docs/app/settings.md:250` says DNS TTL applies to "records the watchdog Lambda writes")
- [x] **RT-WATCHDOG-DOC-003**: `docs/docs/guides/user.md`'s watchdog section shall describe both verdict sources, the health-check route and the Container Insights traffic route. (observed)

## Dropped from OpenSpec

- `desktop-only-operator-surface` / "ConfigService carries no API-token plumbing", scenario "Watchdog tunables still persist": dropped because `ConfigService` holds no watchdog tunables and there is no `ConfigController`; tunables live in `deployment-config.json` (`app/packages/shared/src/deploymentConfig.ts:240-242`) and are covered by RT-WATCHDOG-CFG-005/006.
