---
parent: game-runtime
prefix: RT-WATCHDOG
---

# Idle Watchdog

## Context and Design Philosophy

Hyveon's cost model depends on game-server tasks existing only while someone is playing: there is no persistent ECS Service, tasks are started on demand with `RunTask` and stopped with `StopTask` (CLAUDE.md, "No persistent ECS Service"). The watchdog is the component that closes the loop on the "stopped" side. Without it, a server started from Discord or the desktop app runs, and bills, until someone remembers to stop it.

The watchdog is a single scheduled Lambda (`app/packages/lambda/watchdog/src/handler.ts:191-257`) provisioned by the infra program (`app/packages/infra/src/lambdas.ts:559-620`). On every EventBridge tick it looks at each RUNNING `{game}-server` task, decides "idle" or "active" for the last window, keeps a consecutive-idle count, and stops the task once that count reaches the configured threshold.

What it owns:

- The per-run evaluation loop and the stop decision (`handler.ts:191-257`).
- The Container Insights traffic heuristic, the default verdict source.
- The routing choice between that heuristic and the health-check Lambda, and the watchdog-side fail-active handling of a failed invoke (`handler.ts:113-144`, `:211-228`).
- The `idle_checks` ECS task tag as its only state (`handler.ts:146-168`).
- The static `WatchdogPanel` card on the Settings page (`app/packages/web/src/components/watchdog-panel.component.tsx:7-20`).

What it deliberately does not own:

- **DNS.** Stopping a task produces an ECS `STOPPED` state-change event; `game-runtime/task-and-dns` (`app/packages/lambda/update-dns/src/handler.ts`) deletes the record on that path. The module header gives the reason: deleting DNS first would leave a running task with no record if `StopTask` then failed (`handler.ts:13-17`).
- **Game-aware liveness checks.** The HTTP probe, secret resolution and verdict engine live in `game-runtime/health-check` (`app/packages/lambda/health-check/src/handler.ts`); the watchdog only invokes it and normalises the result.
- **Tunables and their storage.** `watchdogIntervalMinutes`, `watchdogIdleChecks` and `watchdogMinBytesPerSecond` are `DeploymentConfig` fields owned by `deployment-config` (`app/packages/shared/src/deploymentConfig.ts:83-103`, defaults `:240-242`), edited in the General form's "Watchdog tuning" section.
- **Provisioning.** The function, schedule, role and policy are resources in `iac/program` (`lambdas.ts:559-620`, `app/packages/infra/src/iam.ts:346-348,439-466`).

CLAUDE.md invariants that live here:

- **Watchdog state lives in ECS task tags**, not DynamoDB or SSM. Holds: the only state read or written is the `idle_checks` tag (`handler.ts:148-162`).
- **DNS records are Lambda-managed** by update-dns, never by the watchdog. Holds: the handler has no Route 53 client (`handler.ts:19-39`).
- **Lambda env vars use `AWS_REGION_`.** Holds: `region()` reads `AWS_REGION_` first (`handler.ts:53-61`) and the infra program sets it (`lambdas.ts:578`).
- **TLS terminates in-task; no ALB.** Holds: no ELBv2 call in the handler and no `elasticloadbalancing` grant in the watchdog policy (`iam.ts:445-457`), as the in-task TLS invariant requires (no load balancer, target registration or `elasticloadbalancing` grant in any runtime Lambda).

## Run Lifecycle

Each invocation is a stateless pass over the cluster, triggered by `${projectName}-watchdog-schedule` with `rate(N minute|minutes)` where N is `watchdogIntervalMinutes` (`lambdas.ts:590-599`). The event payload is ignored (`handler.ts:191`). The function has a 60 s timeout and Lambda's default 128 MB memory (`lambdas.ts:568-570`).

1. **List.** `listAllRunningTaskArns()` pages through `ListTasks(desiredStatus: RUNNING)` on `ECS_CLUSTER` (`handler.ts:170-181`). No tasks returns `{ checked: 0 }` immediately (`:195-198`).
2. **Describe.** One `DescribeTasks` call over every listed ARN (`handler.ts:200`). This is not chunked; `DescribeTasks` accepts at most 100 tasks, so a cluster with more than 100 RUNNING tasks appears to fail the whole run here (arrow finding 3).
3. **Filter.** A task is skipped unless `lastStatus === 'RUNNING'` and it has an ARN (`handler.ts:204`), and unless its `group` (`family:<name>`) maps through `FAMILY_TO_GAME` (`:205-207`). `FAMILY_TO_GAME` is built from `GAME_NAMES` as `{game}-server → game` with a null prototype (`handler.ts:51`, `app/packages/shared/src/env.ts:64-65`), so helper tasks and foreign families are ignored.
4. **Count.** `checked` increments for every RUNNING task of a configured game, before its verdict is taken.
5. **Verdict.** Exactly one source per task, described in the next section (`handler.ts:211-228`).
6. **Transition.** Read the current count with `getIdleCount()` (`handler.ts:230`), then apply the state machine below.

Tasks are processed strictly sequentially (`for ... await`, `handler.ts:203-255`). There is no per-task try/catch around the loop body, so an exception from any un-caught call (`StopTask`, `DescribeTasks`) aborts the remaining tasks in that run; the next scheduled run starts over from scratch.

### Idle-count state machine

The state is one integer per task, stored as the ECS resource tag `idle_checks` on the task ARN.

| Current verdict | Count after increment | Action | Code |
|---|---|---|---|
| idle | `< IDLE_CHECKS` | write `idle_checks = count` | `handler.ts:232-234,246-248` |
| idle | `>= IDLE_CHECKS` | `StopTask` with reason `Watchdog: idle for {count * CHECK_WINDOW_MINUTES} minutes`; tag not written | `handler.ts:235-245` |
| active | count was `> 0` | write `idle_checks = 0` | `handler.ts:250-253` |
| active | count was `0` | no write | `handler.ts:250` |

Properties that follow from the tag being the state:

- **Fresh tasks start at zero.** A new `RunTask` produces a new task ARN with no tag; `getIdleCount()` returns 0 for a missing tag, a non-numeric value, or any `ListTagsForResource` error (`handler.ts:146-155`). Restarting a stopped server therefore never inherits an old count.
- **Tag writes are best-effort.** `setIdleCount()` swallows failures with a `console.warn` (`handler.ts:165-167`). A failed increment silently delays shutdown by one window; a failed reset leaves a stale count that the next idle window builds on.
- **`StopTask` is not best-effort.** It is awaited with no try/catch (`handler.ts:239-245`), unlike the tag writes (arrow finding 4).
- **Single writer.** Only the watchdog reads or writes `idle_checks`, so the read-modify-write is not guarded. Overlapping invocations are possible in principle when `watchdogIntervalMinutes` is 1 and a run approaches the 60 s timeout `[inferred]`; nothing prevents that.

Total idle time before shutdown is `watchdogIntervalMinutes * watchdogIdleChecks` (`deploymentConfig.ts:85-97`), 60 minutes with the defaults. The log line and stop reason compute it as `idleCount * CHECK_WINDOW_MINUTES` (`handler.ts:237,243`), which equals that product only because the infra program sets `CHECK_WINDOW_MINUTES` from the same `watchdogIntervalMinutes` that drives the schedule (`lambdas.ts:577,598`).

## Verdict Sources

A game with a declared health check is judged by that check alone and every other game by the network-traffic measurement, never a combination, so an operator reading a log can attribute a shutdown to a single cause. The handler implements this as a single branch on `HEALTH_CHECKS[game]` (`handler.ts:211-228`); tests pin the exclusivity in both directions (`app/packages/lambda/watchdog/src/handler.test.ts:200-227`).

| | CloudWatch heuristic | Health-check invoke |
|---|---|---|
| Applies when | `HEALTH_CHECKS[game]` absent | `HEALTH_CHECKS[game]` present |
| Call | `GetMetricStatistics`, `ECS/ContainerInsights`, `NetworkRxBytes`, dimensions `ClusterName` and `TaskDefinitionFamily`, `Average`, one period of `CHECK_WINDOW_MINUTES` | `Invoke` `HEALTH_CHECK_FUNCTION_NAME`, `RequestResponse`, payload `{ game, taskArn, healthCheck }` (`handler.ts:123-129`) |
| Needs ENI | no; the `{game}-server` family identifies the task | no |
| Idle when | average `NetworkRxBytes` below `MIN_BYTES_PER_SECOND` | `active === false` in the returned verdict (`handler.ts:217`) |
| Fail-active on | no datapoint, any query error | unset function name, `FunctionError`, unparseable or malformed payload, any throw: `{ active: true, failureDerived: true }` (`handler.ts:118-143`) |
| Log detail | `rxBytesPerSecond={n}, threshold={MIN_BYTES_PER_SECOND}` | the check's `reason` string (`handler.ts:218`) |

### CloudWatch heuristic

The traffic measurement reads ECS Container Insights, which the cluster has enabled (`IAC-PROGRAM-ECS-001`). Container Insights publishes `NetworkRxBytes` in Bytes/Second for tasks in `awsvpc` network mode, which every Fargate task uses, under the dimension pair `ClusterName` and `TaskDefinitionFamily`. Every game has its own `{game}-server` family, so the family metric is the game's inbound traffic. The `Average` over one `CHECK_WINDOW_MINUTES` period is the mean inbound rate for the window; below `MIN_BYTES_PER_SECOND` the window counts as idle.

The family dimension stands for a single task only while one task per game runs. A second task of the same family would be judged by the two tasks' combined traffic, which can only delay a stop, never cause a wrong one, so it stays inside the fail-active tenet.

Container Insights emits nothing for a task in its first minute, and nothing at all if the cluster setting is off. Both cases arrive as "no datapoint", which counts as active (`RT-WATCHDOG-CW-005`), so a brand-new task is never stopped early. The same rule means a cluster with Container Insights switched off silently never auto-stops, which is why `IAC-PROGRAM-ECS-001` declares the setting rather than leaving it to the account default.

Idle servers are not silent: Steam master-server heartbeats, query pings and port scanners all count as inbound bytes. `MIN_BYTES_PER_SECOND` therefore sits above that background but far below a single connected player. The default of 1000 bytes per second is a starting point to be checked against measured idle and one-player traffic of the deployed games.

Container Insights metrics are billed as CloudWatch custom metrics for the hours they receive data, plus ingestion of the performance log events. With no task running nothing is published, so the cost scales with game-hours: about two dozen metrics per running family and cluster, which at the first-tier custom-metric price is roughly one cent per game-hour.

### Health-check invoke

The watchdog forwards the game's declaration verbatim, including any `auth.secretArn`, and never resolves the secret itself; it holds no `secretsmanager` permission (`iam.ts:445-457`). An ARN is a reference, not a credential, so the watchdog gains no new network reach or credential-value access; only the health-check Lambda resolves the secret and issues the request (`health-check-design.md`, Decisions: "How the watchdog learns opt-ins").

Fail-active is applied at the watchdog layer as well as inside the health-check Lambda, because the most important failure (the function absent or unreachable) is one where no lower layer runs (`handler.ts:104-112`; same design.md, "Fail-active is implemented at every layer"). This satisfies `game-health-checks/spec.md:152-158`. A failure-derived verdict is logged twice at warn level, once in `invokeHealthCheck` (`handler.ts:141`) and once in the loop (`:219-221`), which is how the watchdog meets the "distinguishable severity" clause of `spec.md:292-301`.

The spec's requirement that the reason is carried into the idle-decision record (`spec.md:298-301`) holds on the idle path (`handler.ts:234`) and the reset path (`:251`). An active verdict on a task whose count is already 0 produces no watchdog log line at all; the health-check Lambda's own log is then the only record.

The verdict shape `HealthCheckInvokeResult` is duplicated locally rather than imported, so the two Lambda packages deploy independently (`handler.ts:67-72`). Nothing checks the two shapes stay in sync beyond the runtime type guard at `:135-137`.

## Configuration Contract

All configuration arrives through environment variables set at apply time; the watchdog never reads `deployment-config.json` or S3 at runtime.

| Env var | Source (`lambdas.ts`) | Parsed at | Default / failure behaviour |
|---|---|---|---|
| `ECS_CLUSTER` | `ecsClusterName` (`:573`) | `requireEnv` (`handler.ts:41`) | missing throws at module init |
| `GAME_NAMES` | `gameNamesCsv(gameServers)` (`:574`) | `gameNamesFromEnv()` (`handler.ts:42`) | builds `FAMILY_TO_GAME` |
| `IDLE_CHECKS` | `watchdogIdleChecks` (`:575`) | `parseInt` (`handler.ts:43`) | `4` when absent; a non-numeric value yields `NaN`, and `count >= NaN` is never true, so nothing would ever stop `[inferred]` |
| `MIN_BYTES_PER_SECOND` | `watchdogMinBytesPerSecond` | `parseInt` | `1000` when absent |
| `CHECK_WINDOW_MINUTES` | `watchdogIntervalMinutes` (`:577`) | `parseInt` (`handler.ts:45`) | `15` when absent |
| `AWS_REGION_` | `awsRegion` (`:578`) | `region()` (`handler.ts:53-61`) | falls back to `AWS_REGION`, `AWS_DEFAULT_REGION`, `us-east-1` |
| `HEALTH_CHECKS` | `JSON.stringify(healthChecksByGame(gameServers))` (`:579`, builder `:324-344`) | `parseGameMapEnv` (`handler.ts:47`) | absent or malformed JSON becomes `{}` without throwing (`app/packages/shared/src/env.ts:39-49`) |
| `HEALTH_CHECK_FUNCTION_NAME` | health-check function name, or `''` when not provisioned (`:580`) | raw read (`handler.ts:49`) | empty with a declared check is fail-active (`handler.ts:118-121`) |

A malformed `HEALTH_CHECKS` value silently routes every opted-in game back to the CloudWatch heuristic rather than failing loudly. Combined with the unverified CloudWatch signal, the practical effect is likely "never stop" rather than "stop wrongly", but no log line records the downgrade at the watchdog level `[inferred]`.

Operator-side validation is positive-integer only for the three tunables (`app/packages/shared/src/deploymentSettingsWrite.ts:70-72`); there is no upper bound, and no check that `CHECK_WINDOW_MINUTES * 60` is a valid CloudWatch period. The schedule string handles `rate(1 minute)` versus plural explicitly (`lambdas.ts:590-599`).

`WatchdogPanel` (`watchdog-panel.component.tsx:7-20`) makes no IPC call and has no inputs. It tells the operator the three knobs live in the General form and take effect on the next apply, which is accurate because they are baked into env vars and the schedule expression (`lambdas.ts:575-577,598`).

### IAM

`watchdogLambdaPolicy` (`iam.ts:445-466`) grants logs, `ecs:ListTasks`/`DescribeTasks`/`StopTask`/`TagResource`/`ListTagsForResource` on `*`, `cloudwatch:GetMetricStatistics` on `*`, and `ec2:DescribeNetworkInterfaces` on `*`. The EC2 grant is unused, since the handler no longer reads the ENI (arrow finding 8). `lambda:InvokeFunction` on the health-check ARN is added only when `healthCheckFunctionArn` is set (`iam.ts:455-457`). `StopTask` and `TagResource` on `*` mean the watchdog can stop any task in the account, not only `{game}-server` tasks in its cluster; the family filter in code is the only scoping.

### Where documentation diverges

- `docs/docs/app/settings.md:250` says DNS TTL applies to "records the watchdog Lambda writes"; the watchdog writes no DNS records. Documentation must not describe the watchdog as deleting DNS records; update-dns owns every DNS write.
- `watchdog-panel.component.tsx:4` still names `server_config.json` as history; the tunables live in `deployment-config.json` (`deploymentConfig.ts:240-242`) and `ConfigService` has no watchdog code.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Where idle state lives | `idle_checks` ECS task tag | DynamoDB, SSM | CLAUDE.md invariant and `docs/docs/architecture.md:163`; state dies with the task, so no cleanup and no extra table. Rationale for the tag beyond "no extra store" is `[inferred]`. |
| Who deletes DNS on idle stop | update-dns, via the `STOPPED` event | watchdog deletes the record before `StopTask` | Stated in `handler.ts:13-17`: deleting first would orphan a running task if `StopTask` failed. |
| Default idle signal | Container Insights `NetworkRxBytes` per `{game}-server` family, `Average` over one window, compared with `MIN_BYTES_PER_SECOND` | `AWS/EC2` `NetworkPacketsIn` by ENI; a mandatory health check for every game; VPC Flow Logs on the task ENI | `AWS/EC2` per-ENI metrics are never published for Fargate tasks, so that source returns no data. A mandatory health check gives the most accurate signal at no AWS cost, but most game servers expose no HTTP status endpoint, so every game would need an adapter. Flow Logs work for any protocol but aggregate over 1 to 10 minutes, add log ingestion cost that grows with game traffic, and need a parsing step. Container Insights works for any protocol from metrics the platform already collects, at a cost proportional to game-hours. |
| Behaviour on missing or failed metrics | fail-active | treat as idle, skip task | A brand-new task has no datapoints yet and must not be stopped. |
| Game-aware liveness | separate, conditionally provisioned health-check Lambda invoked synchronously | check inside the watchdog; one Lambda per game | Giving the watchdog a `vpcConfig`, game-network egress and `GetSecretValue` for every opted-in credential would widen the blast radius of the one function every shutdown depends on and add ENI cold-start latency to a tight schedule; a Lambda per game multiplies functions and roles for an identically shaped check. Full rationale: `health-check-design.md`, Decisions: "Where the check runs". |
| How the watchdog learns which games opted in | `HEALTH_CHECKS` JSON env var built at apply time | read `DeploymentConfig` from S3 at runtime; always invoke and let health-check decide | Avoids giving the watchdog S3 access and an unconditional network hop in every deployment (`health-check-design.md`, Decisions: "How the watchdog learns opt-ins"). |
| Combining verdict sources | exactly one source per game | combine packets and health check | One source so an operator can read why a server stopped. |
| Fail-active on failed invoke | handled in the watchdog too | rely on the health-check Lambda | The absent or unreachable function is the failure where no lower layer runs, so each layer handles its own failure mode (`health-check-design.md`, "Fail-active Layering"; `handler.ts:104-112`). |
| Verdict type sharing | local duplicate `HealthCheckInvokeResult` | import from `@hyveon/lambda-health-check` | `handler.ts:67`: keeps the two Lambda packages independently deployable. |
| Which tasks are eligible | `{game}-server` families from `GAME_NAMES` | tag-based selection, all tasks in cluster | `[inferred]`: the family naming convention is already the cross-package contract (`env.ts:51-63`); excludes helper tasks for free. |
| Check window vs schedule | one tunable drives both `CHECK_WINDOW_MINUTES` and the rate | separate tunables | `[inferred]`: each run looks back exactly one interval, so windows neither overlap nor leave gaps. |
| Per-run concurrency | sequential task loop, no per-task error isolation for `StopTask` | parallel evaluation, per-task try/catch | Unknown; no rationale in code or docs `[inferred: simplicity]`. |
| Threshold unit | mean inbound bytes per second (`watchdogMinBytesPerSecond`); the earlier `watchdogMinPackets` key is dropped without migration | keep a packet count; carry the old key forward | Container Insights publishes bytes per second, not packets. Hyveon has no released install, so no stored `deployment-config.json` needs the old key translated. |
| Tunable delivery | env vars, applied on next infra apply | runtime read of `deployment-config.json` | `[inferred]`: keeps the watchdog free of S3 permissions; `WatchdogPanel` documents the apply requirement. |

## Open Questions & Future Decisions

### Resolved

1. Routing, fail-active layering, and secret-handling boundary for health-checked games: resolved as `health-check-design.md` Decisions record and shipped in `handler.ts:104-144,211-228`.

### Deferred

1. Should `DescribeTasks` be chunked into batches of 100 so a cluster with more than 100 RUNNING tasks does not fail the run (`handler.ts:200`)?
2. Should `StopTask` be wrapped per task so one failure does not abort evaluation of the remaining tasks (`handler.ts:239-245`)?
3. How should health-check time be bounded per run? Sequential `RequestResponse` invokes against a 30 s health-check timeout (`lambdas.ts:563`) can exceed the watchdog's 60 s timeout (`lambdas.ts:584`) with two hung checks (`handler.ts:203-255`).
4. Should `watchdog-panel.component.tsx:4` drop its historical `server_config.json` reference?
5. Should `docs/docs/app/settings.md:250` stop attributing DNS writes to the watchdog, 
6. Should the now-unused `ec2:DescribeNetworkInterfaces` grant (`iam.ts:452`) be dropped, and are the `@aws-sdk/client-route-53` and `@smithy/core` devDependencies in `app/packages/lambda/watchdog/package.json` used?
7. Should the `AWS_REGION_` fallback chain (`handler.ts:53-61`) move into one shared helper used by every Lambda?
8. Should a malformed `HEALTH_CHECKS` env var, which silently becomes `{}` (`env.ts:39-49`), be logged by the watchdog so the downgrade to CloudWatch is visible?
9. Should non-numeric `IDLE_CHECKS`/`MIN_BYTES_PER_SECOND`/`CHECK_WINDOW_MINUTES` fail at module init instead of becoming `NaN` (`handler.ts:43-45`)?
10. Should `watchdogIntervalMinutes` have an upper bound or CloudWatch-period validation (`deploymentSettingsWrite.ts:70-72`)?
11. Should the CloudWatch fallback log a distinct detail instead of a synthetic threshold-plus-one reading (`handler.ts:97,227`)?
12. Should `StopTask`/`TagResource` be scoped to the game cluster's task ARNs instead of `*` (`iam.ts:449-451`)?
13. Should the duplicated `HealthCheckInvokeResult` (`handler.ts:67-72`) gain a contract test against the health-check package so the shapes cannot drift silently?
14. Should a game be able to override `MIN_BYTES_PER_SECOND` when its idle background traffic sits above the global threshold?

## References

- Arrow doc: `docs/arrows/game-runtime/watchdog.md`
- EARS specs (future): `docs/intent/game-runtime/watchdog/watchdog-specs.md`
- Docs pages: `docs/docs/components/lambdas.md` (watchdog section), `docs/docs/architecture.md` (control loops, invariant 7), `docs/docs/guides/user.md` ("When the watchdog will stop you"), `docs/docs/app/settings.md`, `docs/docs/guides/maintainer.md` (watchdog state in task tags)
- Neighbouring leaf designs: `docs/intent/game-runtime/health-check/health-check-design.md`, `docs/intent/game-runtime/task-and-dns/task-and-dns-design.md`, `docs/intent/iac/program/program-design.md`, `docs/intent/deployment-config/deployment-config-design.md`
