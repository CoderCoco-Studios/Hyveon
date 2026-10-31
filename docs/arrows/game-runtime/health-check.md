# Arrow: health-check

Optionally ask a game "are you actually serving players?" over HTTP, so the watchdog judges idleness by the game's own answer instead of network packets.

## Status

**MAPPED** — mapped 2026-10-30 (git SHA `2822efd1`), not yet audited.
Code, tests, docs and the `game-health-checks` spec are complete and internally consistent, but on HEAD the deployed Lambda cannot initialise (missing `ECS_CLUSTER`) and, once fixed, appears unable to reach AWS APIs from its VPC placement, so every health-checked game is permanently judged active.

## References

### HLD
- `docs/high-level-design.md`
- `docs/intent/game-runtime/game-runtime-design.md` (sub-HLD)

### LLD
- `docs/intent/game-runtime/health-check/health-check-design.md`

### EARS
- `docs/intent/game-runtime/health-check/health-check-specs.md` (67 specs)

### Tests
- `app/packages/lambda/health-check/src/engine.test.ts`
- `app/packages/lambda/health-check/src/handler.test.ts`
- `app/packages/shared/src/secrets/secretsStore.test.ts`

### Code
- **lambda/health-check**
  - `app/packages/lambda/health-check/src/handler.ts`
  - `app/packages/lambda/health-check/src/engine.ts`
  - `app/packages/lambda/health-check/esbuild.config.mjs`
  - `app/packages/lambda/health-check/package.json`
  - `app/packages/lambda/health-check/tsconfig.json`
- **shared**
  - `app/packages/shared/src/secrets/secretsStore.ts` (app-owned health-check secret helpers; also carries Discord secret helpers, see Key Findings)
- **web**
  - `app/packages/web/src/components/add-game-wizard/health-check-fields.component.tsx`

### Cited from other leaves
- `app/packages/infra/src/lambdas.ts` (`iac/program`): conditional function, log group, env map (`lambdas.ts:529-557`), watchdog `HEALTH_CHECKS` / `HEALTH_CHECK_FUNCTION_NAME` env.
- `app/packages/infra/src/iam.ts` (`iac/program`): conditional single role (`iam.ts:387-395`) and policy with cluster-scoped `ecs:DescribeTasks` plus exact-ARN `secretsmanager:GetSecretValue` (`iam.ts:602-630`).
- `app/packages/infra/src/securityGroups.ts`, `app/packages/infra/src/network.ts` (`iac/program`): health-check SG, per-port egress rules (`securityGroups.ts:283-314`, `:430-446`), public subnets only (`network.ts:132`).
- `app/packages/lambda/watchdog/src/handler.ts` (`game-runtime/watchdog`): sole invoker, `invokeHealthCheck` fail-active wrapper (`handler.ts:113-144`), sequential per-task loop (`handler.ts:203-216`).
- `app/packages/shared/src/aws/ecsTask.ts` (`game-runtime/task-and-dns`): `getTaskPrivateIp`.
- `app/packages/shared/src/env.ts` (`iac/program`): `requireEnv` (`env.ts:16-20`).
- `app/packages/shared/src/gameServerConfig.ts`, `app/packages/shared/src/gameServerValidator.ts` (`game-server`): `GameServerHealthCheck(Auth)` shape, JSONPath regex (`gameServerValidator.ts:114`), cross-field rules.
- `app/packages/desktop-main/src/services/GamesWriteService.ts` (`game-server`): calls `upsertHealthCheckAuthSecret` / `deleteHealthCheckAuthSecret` (`GamesWriteService.ts:35`, `:513-535`).
- `app/packages/web/src/components/add-game-wizard/networking-step.component.tsx` (`game-server`): hosts `HealthCheckFields` (`networking-step.component.tsx:320`).
- `docs/docs/components/lambdas.md` (`## health-check`, lines 290-363).

### OpenSpec sources
- `openspec/specs/game-health-checks/spec.md` (10 requirements, 30 scenarios).
- `openspec/changes/add-healthcheck-auth-type/` (shipped + synced, unarchived; 27/27; ready for archive).
- `openspec/changes/add-pluggable-health-checks/` (shipped + synced, unarchived; 29/29; its delta is superseded by auth-type, so archive without spec application, before auth-type).
- `openspec/changes/add-scripted-health-checks/` (not started; 0/28; credential model written against pluggable-health-checks, needs reconciling with auth-type).

## Architecture

**Purpose:** For a game that declares `healthCheck`, the watchdog invokes a single shared, conditionally provisioned Lambda which resolves the task's private IP from ECS, optionally fetches a credential from Secrets Manager, issues the declared HTTP request, and returns a fail-active `{ active, reason, failureDerived }` verdict that replaces the CloudWatch `NetworkPacketsIn` measurement for that game.

**Key Components:**
1. `lambda/health-check/src/handler.ts`: entry point `handler` (`handler.ts:156`); module-load env and SDK clients (`handler.ts:39-41`); host resolution via `DescribeTasks` (`handler.ts:60-71`); credential fetch (`handler.ts:74-83`); `raw` / `basic` / `bearer` header build (`handler.ts:97-123`); top-level catch turns any failure into fail-active (`handler.ts:178-187`).
2. `lambda/health-check/src/engine.ts`: pure verdict function `evaluateHealthCheck` (`engine.ts:156`), restricted JSONPath tokenizer (`engine.ts:34-60`), operator table (`engine.ts:106-142`); reasons never carry response values (`engine.ts:7-12`).
3. `shared/src/secrets/secretsStore.ts`: app-owned credential lifecycle: deterministic name `hyveon-{game}-healthcheck-auth` (`secretsStore.ts:94-96`), `upsertHealthCheckAuthSecret` with put / restore-if-pending-deletion / create fallback (`secretsStore.ts:144-174`), `deleteHealthCheckAuthSecret` with default recovery window (`secretsStore.ts:184-194`).
4. `web/src/components/add-game-wizard/health-check-fields.component.tsx`: presentational subsection of the networking step: scheme, port, method, timeout, path, condition, and auth type (`none` / `raw` / `basic` / `bearer`, `health-check-fields.component.tsx:31-36`) with write-only secret inputs.
5. `infra/src/lambdas.ts:529-557` (cited): the function, 30 s timeout, `vpcConfig` in public subnets, env `{ AWS_REGION_ }` only.
6. `infra/src/iam.ts:387-395`, `:602-630` (cited): single conditional role and least-privilege policy.
7. `infra/src/securityGroups.ts:283-314`, `:430-446` (cited): health-check SG with no inline egress, one standalone egress rule per distinct declared port toward `gameServersSg`, matching ingress on the game SG.
8. `lambda/watchdog/src/handler.ts:113-144` (cited): synchronous `RequestResponse` invoke; any invoke failure, `FunctionError`, or malformed payload is fail-active.

## Spec Coverage

| OpenSpec capability | requirements | scenarios | notes |
|---|---|---|---|
| `game-health-checks` | 10 | 30 | Behavioural requirements (declaration, HTTP kind, fail-active, conditional provisioning, SSRF-safe host, validation, log recoverability, redaction, app-owned credentials) all have matching code and tests. The confinement requirement (`spec.md:204-252`) asserts AWS API calls travel "over the component's normal route out of its public subnet", which the deployed topology does not provide (Key Findings 2). |

**OpenSpec summary:** The one OpenSpec capability is implemented in code but is not operational on HEAD because of Key Findings 1 and 2.

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Declaration and routing | `RT-HEALTH-DECL-001` to `RT-HEALTH-DECL-006` | 6 | 0 | 0 |
| HTTP request | `RT-HEALTH-HTTP-001` to `RT-HEALTH-HTTP-005` | 4 | 0 | 1 |
| Credential injection | `RT-HEALTH-AUTH-001` to `RT-HEALTH-AUTH-006` | 6 | 0 | 0 |
| Verdict evaluation | `RT-HEALTH-EVAL-001` to `RT-HEALTH-EVAL-009` | 9 | 0 | 0 |
| Fail-active | `RT-HEALTH-FAIL-001` to `RT-HEALTH-FAIL-006` | 5 | 0 | 1 |
| Provisioning and runtime environment | `RT-HEALTH-PROV-001` to `RT-HEALTH-PROV-006` | 3 | 0 | 3 |
| Network and permission confinement | `RT-HEALTH-NET-001` to `RT-HEALTH-NET-005` | 5 | 0 | 0 |
| Save-time validation | `RT-HEALTH-VALID-001` to `RT-HEALTH-VALID-008` | 8 | 0 | 0 |
| Logging | `RT-HEALTH-LOG-001` to `RT-HEALTH-LOG-004` | 4 | 0 | 0 |
| Operator interface redaction | `RT-HEALTH-REDACT-001` to `RT-HEALTH-REDACT-004` | 3 | 0 | 1 |
| App-owned credential lifecycle | `RT-HEALTH-CRED-001` to `RT-HEALTH-CRED-008` | 8 | 0 | 0 |

**Summary:** 61 of 67 active specs implemented; 0 deferred; 6 gaps.

## Key Findings

1. **Lambda cannot initialise: `ECS_CLUSTER` required at module load but never provided.** `handler.ts:39` calls `requireEnv('ECS_CLUSTER')` at module scope, and `requireEnv` throws on an unset var (`shared/src/env.ts:16-20`). Infra sets only `{ AWS_REGION_: awsRegion }` (`infra/src/lambdas.ts:552`), and `infra/src/lambdas.test.ts:792` pins the env to exactly `{ AWS_REGION_: 'us-east-1' }`. `docs/docs/components/lambdas.md:296` also says "`AWS_REGION_` only". The handler test masks it by setting `ECS_CLUSTER` before import (`handler.test.ts:18-20`). Every invoke therefore fails at init; the watchdog sees `FunctionError` and treats the game as active (`watchdog/src/handler.ts:131-143`), so health-checked games are never auto-stopped. Sweep-8 claim verified in code.
2. **No AWS API reachability from the function's VPC placement.** The function sits in public subnets (`lambdas.ts:548-551`); `network.ts` provisions no NAT gateway or VPC endpoints (only `mapPublicIpOnLaunch`, `network.ts:132`), and VPC-attached Lambda ENIs never receive a public IP per AWS Lambda VPC networking behaviour. Independently, the health-check SG has no inline egress (`securityGroups.ts:296-297`) and its only egress rules are TCP to `gameServersSg` on declared ports (`securityGroups.ts:430-446`), so even with a route, `ecs:DescribeTasks` and Secrets Manager calls would be blocked. The spec (`openspec/specs/game-health-checks/spec.md:213-220`) and a test comment (`infra/src/lambdas.test.ts:794-796`) both claim no NAT or endpoint is needed; that contradicts the SG rules in the same code. Sweep-8 claim verified by reading code; not verified against a live deployment.
3. **Fixing only Finding 1 would degrade the watchdog for every game** `[inferred]`. With env fixed but egress missing, each `DescribeTasks` would hang until the 30 s function timeout (`lambdas.ts:547`). The watchdog invokes sequentially per task (`watchdog/src/handler.ts:203-216`) under a 60 s timeout (`lambdas.ts:568`), so two health-checked running tasks would time out the whole watchdog run, including CloudWatch-path games later in the loop.
4. **Fail-active everywhere except `exists`.** Every engine failure path returns `active: true, failureDerived: true` (`engine.ts:157-203`) and the handler catch does the same (`handler.ts:178-187`). The `exists` operator alone treats an unresolved path as a conclusive idle verdict (`engine.ts:175-178`), so a typo in `jsonPath` with `exists` reads as "idle" rather than as a fault. This matches the spec's operator semantics but is the one route by which a misconfigured check can stop a server.
5. **Sweep-8 JSONPath bug is unreachable (sweep disagreement, code wins).** Sweep-8 says `$.`-prefixed paths never resolve (`engine.ts:26-60`). True of the tokenizer in isolation (`$` becomes a literal key), but the validator rejects `$` via `HEALTH_CHECK_JSON_PATH_PATTERN = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+|\[\d+\])*$/` (`shared/src/gameServerValidator.ts:114`, `:227-232`), so no saved config can carry one.
6. **3xx is fail-active by design.** `redirect: 'manual'` (`handler.ts:170`) plus the 2xx-only gate (`engine.ts:157-163`) makes any redirect a failed check; documented in `lambdas.md` step 3.
7. **Host is never taken from config.** URL host is the ECS-reported private IP (`handler.ts:60-71`, `:165`); there is no `host` field to inject, closing SSRF by construction.
8. **Stale doc comment.** `handler.ts:53-59` says it mirrors "the watchdog's own `getEniId`"; the watchdog now uses shared `getTaskEniId` (`shared/src/aws/ecsTask.ts:53`, `watchdog/src/handler.ts:35`), and this handler uses shared `getTaskPrivateIp`.
9. **Region fallback chain duplicated.** `handler.ts:34-37` repeats the `AWS_REGION_ ?? AWS_REGION ?? AWS_DEFAULT_REGION ?? 'us-east-1'` chain also found in `secretsStore.ts:25-27` and every other Lambda handler (sweep-8).
10. **`secretsStore.ts` mixes two leaves.** Health-check helpers (`secretsStore.ts:94-194`) share a file with Discord helpers; `getBotToken`, `putBotToken`, `putPublicKey`, `invalidateSecretsCache` (`secretsStore.ts:63-91`) have no non-test caller in `app/packages`. The module is re-exported from the barrel (`shared/src/index.ts:35`), while `GamesWriteService` deep-imports it (`GamesWriteService.ts:35`).
11. **Secret name hard-codes `hyveon-`.** `healthCheckAuthSecretName` returns `hyveon-${gameId}-healthcheck-auth` (`secretsStore.ts:95`) regardless of the infra `projectName`; harmless because IAM scopes to the persisted ARN (`iam.ts:602-604`), but two deployments in one account and region would collide on a shared game id `[inferred]`.
12. **Wizard gaps.** The timeout `FormField` passes no `errors` prop (`health-check-fields.component.tsx:122`), so a `healthCheck.timeoutMs` issue only shows as `aria-invalid`. The "app stores this as a Secrets Manager secret" hint is duplicated for basic and bearer (`health-check-fields.component.tsx:305-307`, `:326-328`). The component has no dedicated test file; it is exercised through `networking-step.component.test.tsx` and `add-game-wizard.component.test.tsx`.
13. **Spec sync hazard.** Re-applying `add-pluggable-health-checks` would regress main's auth-type wording; both shipped changes remain unarchived (final-clustering §7).

## Work Required

Spec IDs cite the open (`[ ]`) gap specs in `docs/intent/game-runtime/health-check/health-check-specs.md`; items with no matching gap spec carry none.

### Must Fix
1. Pass `ECS_CLUSTER` to the health-check function (`lambdas.ts:552`), update the pinned env test (`lambdas.test.ts:792`) and `lambdas.md:296`, or move the cluster name into the watchdog's invoke payload. (specs: `RT-HEALTH-PROV-003`)
2. Give the function a path to ECS and Secrets Manager: VPC interface endpoints (or NAT) plus SG egress 443 to them, or drop `vpcConfig` and reach the task another way. Correct `spec.md:213-220` and `lambdas.test.ts:794-796` to match. (specs: `RT-HEALTH-PROV-004`)
3. Land 1 and 2 together, or bound per-invoke time in the watchdog, to avoid the cascading watchdog timeout in Finding 3. (specs: `RT-HEALTH-FAIL-006`)

### Should Fix
4. Add an infra-level or contract test asserting the handler's required env is a subset of the provisioned env, so `handler.test.ts:18` can no longer mask the gap. (specs: `RT-HEALTH-PROV-005`)
5. Decide whether `exists` with an unresolved path should stay a conclusive idle verdict (Finding 4).
6. Split `secretsStore.ts` into health-check and Discord modules; delete or justify the uncalled Discord helpers.
7. Archive `add-pluggable-health-checks` (without spec application) then `add-healthcheck-auth-type`; reconcile `add-scripted-health-checks` with the auth-type credential model.

### Nice to Have
8. Show `timeoutMs` validation text in the wizard; dedupe the secret hint copy. (specs: `RT-HEALTH-REDACT-004`)
9. Fix the stale `getEniId` comment (`handler.ts:53-59`).
10. Extract the region fallback chain into one shared helper.
11. Derive the secret-name prefix from the project name.
