# Arrow: watchdog

Automatically stop a game nobody is playing, so the operator does not pay for an idle server.

## Status

**MAPPED** — mapped 2026-10-30 (git SHA `2822efd1`), not yet audited.
A single scheduled Lambda with its state in an ECS task tag; tested at the handler level. Games without a health check are judged by Container Insights `NetworkRxBytes` per task family; several robustness gaps remain in the per-run loop.

## References

### HLD
- `docs/high-level-design.md`
- `docs/intent/game-runtime/game-runtime-design.md` (sub-HLD)

### LLD
- `docs/intent/game-runtime/watchdog/watchdog-design.md`

### EARS
- `docs/intent/game-runtime/watchdog/watchdog-specs.md` (58 specs)

### Tests
- `app/packages/lambda/watchdog/src/handler.test.ts`
- `app/packages/web/src/components/watchdog-panel.component.test.tsx`

### Code
- **lambda/watchdog**
  - `app/packages/lambda/watchdog/src/handler.ts`
  - `app/packages/lambda/watchdog/package.json`
  - `app/packages/lambda/watchdog/esbuild.config.mjs`
  - `app/packages/lambda/watchdog/tsconfig.json`
- **web**
  - `app/packages/web/src/components/watchdog-panel.component.tsx`

### Cited from other leaves
- `app/packages/infra/src/lambdas.ts` (`iac/program`): watchdog function, env vars, EventBridge rate rule, target and invoke permission (`lambdas.ts:559-620`); `HEALTH_CHECKS` env builder (`lambdas.ts:325`).
- `app/packages/infra/src/iam.ts` (`iac/program`): `watchdogLambdaRole` (`iam.ts:346-348`) and `watchdogLambdaPolicy` with the conditional `lambda:InvokeFunction` grant on the health-check function (`iam.ts:439-466`).
- `app/packages/lambda/health-check/src/handler.ts` (`game-runtime/health-check`): the synchronous verdict source for games that declare a health check.
- `app/packages/lambda/update-dns/src/handler.ts` (`game-runtime/task-and-dns`): deletes the DNS record on the `STOPPED` event that the watchdog's `StopTask` produces.
- `app/packages/shared/src/env.ts` (`familyToGameMap`, `gameNamesFromEnv`, `parseGameMapEnv`, `requireEnv`).
- `app/packages/shared/src/deploymentConfig.ts` (`deployment-config`): `watchdogIntervalMinutes`/`watchdogIdleChecks`/`watchdogMinBytesPerSecond` fields and defaults 15/4/1000 (`deploymentConfig.ts:83-103,240-242`); `app/packages/shared/src/deploymentSettingsWrite.ts:70-72` positive-integer validation.
- `app/packages/web/src/components/deployment-settings-form.component.tsx` (`deployment-config`): the "Watchdog tuning" editor the panel points at.
- `app/packages/web/src/pages/settings.page.tsx` (`operator-app/desktop-shell`): hosts `WatchdogPanel`.

### OpenSpec sources
- No OpenSpec capability of its own; EARS will be authored from code.
- Fragments: the `game-health-checks` capability (verdict-source routing, fail-active, log recoverability), `in-task-tls-termination` (no ELB paths in watchdog), `operator-documentation` (watchdog never described as touching DNS) and `desktop-only-operator-surface` (a `server_config.json` scenario that no code matches, see finding 6).
- The pluggable health-check work touching this leaf is shipped; its primary leaf is `game-runtime/health-check`.

## Architecture

**Purpose:** On a fixed EventBridge rate, look at every running game-server task, decide idle or active from exactly one verdict source, keep a consecutive-idle count in the task's own `idle_checks` tag, and `StopTask` once the count reaches `IDLE_CHECKS`. DNS cleanup is left to update-dns via the resulting `STOPPED` event.

**Key Components:**
1. `handler()`: `app/packages/lambda/watchdog/src/handler.ts:191-257`; lists RUNNING tasks, one `DescribeTasks`, per-task verdict, tag update or `StopTask`; returns `{ checked }`.
2. Env contract: `handler.ts:41-49`: `ECS_CLUSTER` (required), `GAME_NAMES`, `IDLE_CHECKS` (default 4), `MIN_BYTES_PER_SECOND` (default 1000), `CHECK_WINDOW_MINUTES` (default 15), `HEALTH_CHECKS` (JSON map), `HEALTH_CHECK_FUNCTION_NAME`; region from `AWS_REGION_` fallback chain (`handler.ts:53-61`).
3. Game matching: `FAMILY_TO_GAME` from `familyToGameMap` (`handler.ts:51`, `shared/src/env.ts:64-65`) maps `${game}-server` families only, so helper tasks and unknown families are skipped (`handler.ts:205-207`).
4. CloudWatch verdict: `getRxBytesPerSecond()`: `ECS/ContainerInsights` `NetworkRxBytes` `Average` over the window, dimensions `ClusterName` and `TaskDefinitionFamily`; the task is identified by its family alone, with no ENI or EC2 read. A missing datapoint or an error returns `null`, which counts as active (fail-active).
5. Health-check verdict: `invokeHealthCheck()` (`handler.ts:113-144`): synchronous `RequestResponse` invoke of the health-check Lambda; unset function name, `FunctionError`, malformed payload or any throw is fail-active with `failureDerived: true`.
6. Idle state: `getIdleCount()`/`setIdleCount()` (`handler.ts:146-168`) read and write the `idle_checks` ECS task tag; no DynamoDB or SSM.
7. Infra wiring: `lambdas.ts:559-620`: `${projectName}-watchdog` (60 s timeout, 128 MB default), `CHECK_WINDOW_MINUTES` and the `rate(N minute|minutes)` schedule both from `watchdogIntervalMinutes`.
8. IAM: `iam.ts:445-457`: ECS list/describe/stop/tag, `ec2:DescribeNetworkInterfaces` (unused), `cloudwatch:GetMetricStatistics`, plus `lambda:InvokeFunction` on the health-check ARN only when a game declares a health check.
9. `WatchdogPanel`: `app/packages/web/src/components/watchdog-panel.component.tsx:7-20`; static Settings card pointing at the General form's "Watchdog tuning"; no IPC, no inputs.

## Spec Coverage

| OpenSpec capability | requirements | scenarios | notes |
|---|---|---|---|
| (none owned) |: |: | No OpenSpec capability; EARS will be authored from code. |
| `game-health-checks` (fragment) | 3 of 10 touch the watchdog: authoritative health check routing (`spec.md:12`), fail-active (`:152`), shutdown basis recoverable from logs (`:292`) | 30 total in capability | Owned by `game-runtime/health-check`; watchdog side implemented at `handler.ts:211-228`, `:113-144`, `:234`. |
| `in-task-tls-termination` (fragment) | 1 of 6 (`spec.md:56`) | 1 (`:65-68`) | Holds: no ELBv2 calls or `elasticloadbalancing` grants in `handler.ts` or `iam.ts:445-457`. |
| `operator-documentation` (fragment) | 1 (`spec.md:57`) | 1 (`:67-70`) | Watchdog issues `StopTask` only; `docs/docs/app/settings.md:250` still contradicts it (finding 7). |
| `desktop-only-operator-surface` (fragment) | 1 (`spec.md:42`) | 1 (`:51-54`) | Stale; see finding 6. |

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Schedule and provisioning | `RT-WATCHDOG-SCHED-001` to `RT-WATCHDOG-SCHED-006` | 6 | 0 | 0 |
| Task selection | `RT-WATCHDOG-SCOPE-001` to `RT-WATCHDOG-SCOPE-006` | 5 | 0 | 1 |
| Verdict source routing | `RT-WATCHDOG-ROUTE-001` to `RT-WATCHDOG-ROUTE-004` | 4 | 0 | 0 |
| CloudWatch traffic verdict | `RT-WATCHDOG-CW-001` to `RT-WATCHDOG-CW-007` | 6 | 0 | 0 |
| Health-check verdict | `RT-WATCHDOG-HC-001` to `RT-WATCHDOG-HC-006` | 5 | 0 | 1 |
| Idle-count state | `RT-WATCHDOG-STATE-001` to `RT-WATCHDOG-STATE-007` | 7 | 0 | 0 |
| Shutdown | `RT-WATCHDOG-STOP-001` to `RT-WATCHDOG-STOP-004` | 3 | 0 | 1 |
| Logging | `RT-WATCHDOG-LOG-001` to `RT-WATCHDOG-LOG-005` | 5 | 0 | 0 |
| Configuration | `RT-WATCHDOG-CFG-001` to `RT-WATCHDOG-CFG-007` | 7 | 0 | 0 |
| IAM | `RT-WATCHDOG-IAM-001` to `RT-WATCHDOG-IAM-003` | 3 | 0 | 0 |
| Settings panel | `RT-WATCHDOG-UI-001` | 1 | 0 | 0 |
| Documentation | `RT-WATCHDOG-DOC-001` to `RT-WATCHDOG-DOC-003` | 2 | 0 | 1 |

**Summary:** 54 of 58 active specs implemented; 0 deferred; 4 gaps.

## Key Findings

1. **Idle state lives in the `idle_checks` ECS task tag**: read at `handler.ts:146-155` (any error or non-numeric value becomes 0), written at `:157-168` (failures only warned). Activity resets the tag to 0 only when it was non-zero (`:250-253`). Matches the CLAUDE.md invariant.
2. **Exactly one verdict source per game**: a declared `HEALTH_CHECKS[game]` routes to the health-check invoke and never to CloudWatch, otherwise CloudWatch only (`handler.ts:211-228`); both paths fail active (`:94-101`, `:118-143`). Tests pin the exclusivity (`handler.test.ts:200-271`).
3. **Single `DescribeTasks` over all ARNs**: `handler.ts:200` passes every listed ARN in one call even though `ListTasks` is paginated (`:170-181`); `DescribeTasks` accepts at most 100 tasks, so more than 100 RUNNING tasks in the cluster appears to throw and abort the run (sweep-8, confirmed by reading the code).
4. **`StopTask` is unguarded**: `handler.ts:239-245` awaits `StopTaskCommand` with no try/catch, so one failure aborts evaluation of every remaining task in that run. Tag writes, by contrast, swallow errors (`:165-167`).
5. **Serial synchronous health-check invokes under a 60 s timeout** `[inferred]`: tasks are processed sequentially (`handler.ts:203-255`), each health-check invoke is `RequestResponse` (`:126`), the health-check function has a 30 s timeout (`lambdas.ts:544-547`) and the watchdog 60 s (`lambdas.ts:568`). Two or more hung checks in one run would time out the watchdog before later tasks are evaluated.
6. **Legacy requirement text contradicts code**: the legacy `desktop-only-operator-surface` requirement said `ConfigService` reads and writes watchdog tunables in `server_config.json`; `app/packages/desktop-main/src/services/ConfigService.ts` contains no watchdog reference, there is no config controller under `desktop-main/src/controllers/`, and tunables live in `deployment-config.json` (`watchdog-panel.component.tsx:1-5`, `deploymentConfig.ts:240-242`). `watchdog-panel.component.tsx:4` still names `server_config.json` as history.
7. **Docs attribute DNS writes to the watchdog**: `docs/docs/app/settings.md:250` says DNS TTL applies to "records the watchdog Lambda writes"; the watchdog never touches Route 53 (`handler.ts:13-17`), update-dns does. Violates `operator-documentation` (`spec.md:57`).
8. **Unused dependencies and permissions**: `package.json` lists `@aws-sdk/client-route-53` and `@smithy/core` devDeps that `handler.ts` does not import (`@smithy/core` may be test-only, `[unverified]`); `iam.ts:452` grants `ec2:DescribeNetworkInterfaces` although the handler makes no EC2 call (ENI ID comes from task attachments, `shared/src/aws/ecsTask.ts:53-55`).
9. **Duplicated region fallback chain**: `handler.ts:53-61` repeats the `AWS_REGION_ → AWS_REGION → AWS_DEFAULT_REGION → us-east-1` chain also present in the other Lambda handlers and shared/cloud-aws helpers (inventory findings digest); candidate for one shared helper.
10. **`HealthCheckInvokeResult` duplicated by design**: `handler.ts:67-72` copies the health-check verdict shape rather than importing it so the two Lambda packages deploy independently; the comment documents the choice, but the two shapes can drift silently.
11. **Settings changes need an apply**: tunables are baked into env vars and the schedule expression at apply time (`lambdas.ts:575-577,598`); `WatchdogPanel` says so (`watchdog-panel.component.tsx:13-16`). Validation is only positive-integer (`deploymentSettingsWrite.ts:70-72`); no upper bound on `watchdogIntervalMinutes` relative to CloudWatch query limits `[unverified whether one is needed]`.

## Work Required

Spec IDs cite the open (`[ ]`) gap specs in `docs/intent/game-runtime/watchdog/watchdog-specs.md`; items with no matching gap spec carry none.

### Must Fix
None.

### Should Fix
1. Chunk `DescribeTasks` into batches of 100 (finding 3). (specs: `RT-WATCHDOG-SCOPE-005`)
2. Wrap `StopTask` per task so one failure does not abort the rest of the run (finding 4). (specs: `RT-WATCHDOG-STOP-004`)
3. Bound total health-check time per run (parallelise or budget against the 60 s timeout) (finding 5). (specs: `RT-WATCHDOG-HC-006`)
4. Fix the stale `desktop-only-operator-surface` scenario and `docs/docs/app/settings.md:250` (findings 6, 7). (specs: `RT-WATCHDOG-DOC-002`)

### Nice to Have
5. Drop the unused `client-route-53` devDep and the `ec2:DescribeNetworkInterfaces` grant if confirmed unused (finding 8).
6. Extract the Lambda region fallback chain into one shared helper (finding 9).
