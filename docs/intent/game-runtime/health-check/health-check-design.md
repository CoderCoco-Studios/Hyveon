---
parent: game-runtime
prefix: RT-HEALTH
---

# Authoritative Health Check

## Context and Design Philosophy

The watchdog's default idleness signal is the task's inbound traffic from ECS Container Insights, which cannot tell a server with players apart from a server receiving background traffic. The health check lets a game opt in to a better signal: it declares an HTTP request against its own management API and a single condition on the response, and the watchdog then asks that question instead of measuring traffic. For an opted-in game the verdict fully replaces the CloudWatch measurement for that cycle (`app/packages/lambda/watchdog/src/handler.ts:211-216`).

This leaf owns:

- The `@hyveon/lambda-health-check` package: the handler that resolves host and credential and issues the request (`app/packages/lambda/health-check/src/handler.ts:156-188`) and the pure verdict engine (`app/packages/lambda/health-check/src/engine.ts:156-212`).
- The app-owned credential lifecycle helpers in `@hyveon/shared` (`app/packages/shared/src/secrets/secretsStore.ts:94-194`).
- The wizard's health-check subsection (`app/packages/web/src/components/add-game-wizard/health-check-fields.component.tsx`).

It deliberately does not own, and cites instead:

- The idle counter, the stop decision, and the invoke wrapper: `game-runtime/watchdog` (`app/packages/lambda/watchdog/src/handler.ts:113-144`). The watchdog is the sole invoker.
- The task ENI and private-IP helpers: `game-runtime/task-and-dns` (`getTaskPrivateIp` in `app/packages/shared/src/aws/ecsTask.ts`).
- Provisioning of the function, role, policy, security group and subnets: `iac/program` (`app/packages/infra/src/lambdas.ts:535-571`, `app/packages/infra/src/iam.ts:389-396`, `:602-634`, `app/packages/infra/src/securityGroups.ts:287-320`, `:432-453`).
- The `GameServerHealthCheck` type, its zod schema and cross-field rules, and the write path that calls the credential helpers: `game-server` (`app/packages/shared/src/gameServerConfig.ts:117-195`, `app/packages/shared/src/gameServerValidator.ts:114`, `:986-1030`, `app/packages/desktop-main/src/services/GamesWriteService.ts:474-535`).

Guiding principles, each visible in code:

1. **Fail-active.** A check that cannot reach a conclusive answer must never read as idle, because the cost of a wrongly stopped server (players dropped) is worse than the cost of a server kept running (`engine.ts:144-151`). The principle is implemented at three layers, not one (see "Fail-active layering").
2. **Zero footprint when unused.** No game declares `healthCheck` means no function, role, policy, security group or log group (`iam.ts:390`, `lambdas.ts:545`, `securityGroups.ts:292-296`).
3. **Host is never configuration.** The request is always addressed to the checked task's own private IP from ECS, so there is no field through which a check can be pointed elsewhere (`handler.ts:53-71`, `gameServerConfig.ts:164-170`).
4. **No response value leaves the function.** Verdict reasons name the JSONPath and operator, never the value found or the body (`engine.ts:7-12`); logs carry only game, kind, port, active and reason (`handler.ts:145-148`, `:158`).

CLAUDE.md invariants that live here: Lambda env uses `AWS_REGION_` (`handler.ts:34-37`); secrets never reach the renderer, enforced by `redactGameServer` replacing `auth` with `secretSet` / `authType` (`gameServerConfig.ts:373-381`); `@hyveon/shared` AWS helpers, where `secretsStore.ts` is currently reachable from the barrel (`app/packages/shared/src/index.ts:35`) rather than only as a deep import.

**Current-state warning.** On HEAD the deployed function cannot initialise and, once that is fixed, appears unable to reach AWS APIs from its VPC placement (see "Provisioning and reachability"). Every invoke therefore comes back failure-derived and every health-checked game is judged active forever. The design below describes what the code does; the divergences are flagged in place.

## Declaration and Data Shapes

A game opts in by setting `healthCheck` on its `GameServerConfig` entry in `deployment-config.json` (`gameServerConfig.ts:306`). The shape (`gameServerConfig.ts:171-195`):

| Field | Type | Constraint (where enforced) |
|---|---|---|
| `kind` | `'http'` | Only kind today (`gameServerConfig.ts:172-173`) |
| `scheme` | `'http' \| 'https'` | zod enum |
| `port` | number | Must be one of the game's declared TCP ports or its `webPort` (`gameServerValidator.ts:1000-1005`) |
| `path` | string | Non-empty, starts with `/` (`gameServerValidator.ts:250-251`) |
| `method` | `GET \| POST \| PUT \| PATCH \| HEAD` | zod enum |
| `headers` | `Record<string,string>` | Values that look like credentials are rejected (`gameServerValidator.ts:264`) |
| `auth` | `{ type?, secretArn }` | ARN pattern; per-type required inputs (`gameServerValidator.ts:123-169`) |
| `timeoutMs` | integer | 100 to 10000 inclusive (`gameServerValidator.ts:273-275`) |
| `activeWhen` | `{ jsonPath, operator, value? }` | JSONPath regex (`gameServerValidator.ts:114`, `:230`); `value` forbidden for `exists`, required otherwise, typed per operator (`gameServerValidator.ts:1008-1030`) |

The persisted `auth` is always a reference: `type` (absent means `'raw'`) plus `secretArn` (`gameServerConfig.ts:117-135`). The wizard and IPC write payload carry plaintext `username` / `password` / `token` for `basic` / `bearer`, which `GamesWriteService.resolveHealthCheckAuthSecret` exchanges for an app-owned ARN before the config is persisted (`GamesWriteService.ts:474-511`).

Doc-comment drift: the `auth` field comment on `GameServerHealthCheck` still says the secret is injected as "the secret's raw value, no `Bearer ` prefix" (`gameServerConfig.ts:184-189`), which is only true of `raw`; `bearer` and `basic` prefix it (`handler.ts:97-123`).

The invoke contract between watchdog and function:

| Direction | Shape | Source |
|---|---|---|
| Request | `{ game, taskArn, healthCheck }`, the declaration forwarded verbatim from the watchdog's `HEALTH_CHECKS` env map | `handler.ts:28-32`, `watchdog/src/handler.ts:122-128` |
| Response | `{ active: boolean, reason: string, failureDerived: boolean }` | `engine.ts:4-22` |

The watchdog learns which games opted in from `HEALTH_CHECKS`, a JSON env var built by `healthChecksByGame` with sorted keys and only opted-in games (`lambdas.ts:335-343`, `:595`), and the function name from `HEALTH_CHECK_FUNCTION_NAME` (`lambdas.ts:596`). It never reads `deployment-config.json` at runtime, so a declaration change takes effect only after an infra apply re-renders the env var `[inferred]`.

## Check Execution

One invocation runs this sequence (`handler.ts:156-188`):

1. **Resolve host and credential in parallel** (`handler.ts:161`). The host comes from `DescribeTasks` on `ECS_CLUSTER` followed by `getTaskPrivateIp` (`handler.ts:60-71`); a missing task or IP throws. The credential is fetched with `GetSecretValue` on `auth.secretArn` only when `auth` is declared; an empty `SecretString` throws (`handler.ts:74-83`).
2. **Build the `Authorization` header** from the secret per `auth.type` (`handler.ts:97-123`): `raw` injects the value verbatim, `bearer` prefixes `Bearer `, `basic` parses `{ username, password }` JSON and base64-encodes `username:password`. A malformed basic secret throws. The injected header replaces any declared header named `authorization` case-insensitively (`handler.ts:131-142`).
3. **Issue the request** to `{scheme}://{privateIp}:{port}{path}` with `redirect: 'manual'` and `AbortSignal.timeout(timeoutMs)` (`handler.ts:165-172`). For `https` the request targets an IP, so certificate hostname validation against a Caddy-served certificate would presumably fail and surface as a fail-active fetch error `[inferred]`; no test covers an https check end to end.
4. **Evaluate** status and body with `evaluateHealthCheck` (`handler.ts:173-175`).
5. **Log** the verdict at `warn` when failure-derived, `debug` otherwise (`handler.ts:145-148`).

The engine is pure: no I/O and no SDK import beyond the type (`engine.ts:1`, `:144-156`). Its decision table:

| Condition | Verdict | `failureDerived` | Source |
|---|---|---|---|
| Status outside 200-299 (includes every 3xx, given `redirect: 'manual'`) | active | true | `engine.ts:157-163` |
| Body is not JSON | active | true | `engine.ts:165-170` |
| `exists`, path resolves | active | false | `engine.ts:175-177` |
| `exists`, path does not resolve | **idle** | false | `engine.ts:178` |
| Other operator, path does not resolve | active | true | `engine.ts:181-187` |
| Resolved value is an object or array | active | true | `engine.ts:188-194` |
| Operator cannot compare (type mismatch, non-numeric, non-string `contains`, missing `value`) | active | true | `engine.ts:105-142`, `:196-203` |
| Comparison holds / does not hold | active / idle | false | `engine.ts:205-211` |

Operator semantics: `equals` / `notEquals` are strict-typed except that `null` compares with anything (`engine.ts:117`); `greaterThan` / `lessThan` coerce numeric strings (`engine.ts:91-101`); `contains` is substring on strings only (`engine.ts:135-140`).

JSONPath is a restricted dialect: dotted field names and numeric indices only (`engine.ts:26-60`). The tokenizer has no syntax-error path; anything it cannot use simply fails to resolve. A `$.`-prefixed path would tokenize `$` as a literal key and never resolve, but the validator's `HEALTH_CHECK_JSON_PATH_PATTERN` forbids `$` (`gameServerValidator.ts:114`), so no saved config reaches that case.

The `exists` row is the single route by which a check that is misconfigured (for example a typo in `jsonPath`) can produce a non-failure idle verdict and therefore contribute to stopping a server. This matches the spec's operator semantics, which define `exists` as a cardinality test.

## Fail-active Layering

Fail-active is implemented at each layer that can fail, because the most important failure (the function is absent or unreachable) is the one where no lower layer runs at all:

| Layer | Failures handled | Source |
|---|---|---|
| Engine | Non-2xx, bad JSON, unresolved path, non-scalar, incomparable | `engine.ts:157-203` |
| Handler | ECS lookup, secret fetch, malformed basic secret, network error, timeout | `handler.ts:178-187` |
| Watchdog invoke wrapper | No function configured, invoke throws, `FunctionError` (including init failure), malformed payload | `watchdog/src/handler.ts:117-143` |

A failure-derived verdict is logged at `warn` by both the handler and the watchdog (`handler.ts:147`, `watchdog/src/handler.ts:217`), so a persistently broken check shows up as a repeating fault rather than silence. The accepted trade is that a broken check keeps a server running indefinitely, costing money. This is deliberate: fail-active is the safe direction for players and the unsafe direction for cost, and the opposite default could stop a live server with players on it.

Interaction with the watchdog schedule: the watchdog invokes synchronously, one task at a time (`watchdog/src/handler.ts:203-216`), under a 60 s timeout (`lambdas.ts:584`), while the health-check function has a 30 s timeout (`lambdas.ts:563`). There is no per-invoke time bound in the watchdog. Any health-check invocation that runs to its function timeout therefore consumes half the watchdog's budget, and two such invocations in one run would time out the watchdog itself, skipping every later task in the loop including CloudWatch-path games `[inferred]`.

## Provisioning and Reachability

Provisioning is owned by `iac/program`; the contract this leaf depends on is:

| Resource | Shape on HEAD | Source |
|---|---|---|
| Function `{projectName}-health-check` | 30 s timeout, `vpcConfig` in public subnets with the health-check SG, env `{ AWS_REGION_ }` only, no Function URL | `lambdas.ts:545-571` |
| Role and inline policy | One shared role; logs, VPC ENI, `ecs:DescribeTasks` on `task/{cluster}/*`, `secretsmanager:GetSecretValue` on exactly the declared `auth.secretArn` values | `iam.ts:389-396`, `:602-634` |
| Security group | No inline egress; one standalone TCP egress rule per distinct declared port toward `gameServersSg`; matching ingress added to the game SG from the health-check SG | `securityGroups.ts:287-320`, `:432-453` |
| Watchdog grant | `lambda:InvokeFunction` on the health-check function ARN only | `iam.ts` (watchdog policy), `docs/docs/components/lambdas.md:182` |

Network confinement is port-level, not game-level: all game tasks share `gameServersSg`, so a non-opted-in game listening on a port some opted-in game declares is reachable from the function. The request is still addressed to one specific task's private IP resolved from ECS, so reachability is not the same as a request being made; the confinement is stated accurately rather than overclaimed.

Two divergences between this contract and the handler make the feature non-operational on HEAD:

1. **Missing `ECS_CLUSTER`.** The handler calls `requireEnv('ECS_CLUSTER')` at module scope (`handler.ts:40`), which throws when unset (`app/packages/shared/src/env.ts:16-20`). Infra sets only `AWS_REGION_` (`lambdas.ts:568`), pinned by `app/packages/infra/src/lambdas.test.ts:831` and documented as "`AWS_REGION_` only" in `docs/docs/components/lambdas.md:302`. The handler test sets `ECS_CLUSTER` before import (`handler.test.ts:18-20`), which hides the gap. Every invoke fails at init and the watchdog's `FunctionError` branch makes the game active.
2. **No route to AWS APIs.** The function is VPC-attached in public subnets (`lambdas.ts:564-567`); `network.ts` provisions no NAT gateway or VPC endpoints, and VPC-attached Lambda ENIs do not receive public IPs. Independently, the SG's only egress is TCP to `gameServersSg` on declared ports (`securityGroups.ts:432-453`), so `DescribeTasks` and `GetSecretValue` calls would be blocked even with a route. The intent that AWS API calls "travel over the component's normal route out of its public subnet" with no new network provisioning, and the test comment at `lambdas.test.ts:834-836` that repeats it, both contradict the SG rules in the same code. Verified by reading code, not against a live deployment.

## Credential Lifecycle

Three auth types exist (`gameServerConfig.ts:117-135`):

- `raw` (or no `type`): operator supplies an existing secret ARN; the app never writes or deletes it (`GamesWriteService.ts:500-505`).
- `basic`: the app stores `JSON.stringify({ username, password })` (`GamesWriteService.ts:508`).
- `bearer`: the app stores the raw token (`GamesWriteService.ts:508`).

For app-owned types the secret name is deterministic, `hyveon-{gameId}-healthcheck-auth` (`secretsStore.ts:94-96`). `upsertHealthCheckAuthSecret` tries `PutSecretValue` first, on a pending-deletion `InvalidRequestException` (confirmed via `DescribeSecret.DeletedDate`) runs `RestoreSecret` and retries once, and on `ResourceNotFoundException` falls back to `CreateSecret` (`secretsStore.ts:109-174`). `deleteHealthCheckAuthSecret` uses the default recovery window and treats a missing secret as success (`secretsStore.ts:176-194`).

The write service deletes an app-owned secret when auth is switched to `raw`, cleared, or the game is deleted (`GamesWriteService.ts:289`, `:481`, `:502-503`). Upsert failures are logged at `error` and rethrown as a plain `Error`; delete failures are logged at `warn` and swallowed so cleanup never blocks the config write (`GamesWriteService.ts:513-535`).

IAM on the read side needs no change when a new app-owned secret is created, because the policy is rebuilt from the persisted ARNs on the next apply (`iam.ts:602-604`). On the write side the operator's deploy policy already grants `secretsmanager:*` (`app/packages/shared/src/iamPolicy.ts`), which covers `CreateSecret`, `PutSecretValue` and `DeleteSecret`; a regression test against `IamCheckService`'s action simulation (`IamCheckService.test.ts:472-486`) fails if a future least-privilege narrowing of that wildcard would silently break the feature for deployed accounts. A newly created secret is therefore unreadable by the function until the next infra apply `[inferred]`.

The name prefix is the literal `hyveon-`, not the infra `projectName` (`secretsStore.ts:95`), so two deployments in one account and region sharing a game id would write the same secret `[inferred]`.

The wizard subsection (`health-check-fields.component.tsx`) offers `none` / `raw` / `basic` / `bearer` (`health-check-fields.component.tsx:31-36`), offers the game's `webPort` ahead of extra ports as a target (`health-check-fields.component.tsx:44-45`), and treats secret inputs as write-only, hydrating only `secretSet` / `authType` from the redacted game (`gameServerConfig.ts:373-381`).

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Where the check runs | One shared, conditionally provisioned Lambda invoked by the watchdog | Check inside the watchdog; one Lambda per opted-in game (efs-seeder pattern) | Keeps VPC attachment, game-network egress and secret access out of the function every shutdown depends on; avoids per-game multiplication of functions, roles, log groups and cold starts for a check identical in shape across games. Giving the watchdog a `vpcConfig`, game-network egress and `GetSecretValue` for every opted-in credential would widen the blast radius of the one function that must not misbehave, and ENI attachment would slow a function on a tight schedule. Credentials stay scoped to the declared secret ARNs, but a compromise of the shared function sees every opted-in game's credentials rather than one. Accepted because the function executes no operator-supplied code today; scripted checks would remove that premise and reopen this decision |
| Verdict logic placement | Pure `evaluateHealthCheck` separate from the handler | Logic inline in the handler | Whole decision matrix is table-testable without AWS mocks, mirroring `canRun()`; the handler keeps only the parts that need mocking (ECS lookup, secret fetch, the HTTP call) |
| How the watchdog learns opt-ins | `HEALTH_CHECKS` JSON env map rendered by infra | Watchdog reads `deployment-config.json` from S3; always invoke and let the function decide | No new S3 access for the watchdog; no network hop or provisioning for non-opted-in deployments. Always invoking was rejected because it would provision the function unconditionally, losing zero footprint, and put a network hop in front of every idle decision. The watchdog forwards the declaration verbatim, including `auth.secretArn`; an ARN is a reference, not a credential, so the watchdog never handles a resolved secret value or issues the request |
| Failure semantics | Fail-active at engine, handler and invoke-wrapper layers | Fail-idle; fail-active in the engine only | A wrongly stopped server drops players; the absent-function failure runs no lower layer. The accepted cost is a persistently broken check keeping a server running, made visible by `warn` logs |
| Destination host | Always the task's private IP from `DescribeTasks` | A configurable `host` field with validation | SSRF closed by construction: there is no field to validate; configuration supplies scheme, port, path, method and headers only |
| Condition expressiveness | Single `activeWhen` comparison, restricted JSONPath | Boolean expression tree; full JSONPath | An expression tree is the first step to an interpreter; scripted checks are the planned answer, and a game whose API needs AND/OR keeps the network heuristic until then |
| Redirect handling | `redirect: 'manual'`, so any 3xx is a fail-active failure | Follow redirects | Following would let a game redirect the check to another host, reopening the SSRF surface `[inferred]` |
| `exists` on an unresolved path | Conclusive idle verdict | Treat as failure-derived like other operators | Matches the spec's cardinality semantics for `exists` `[inferred]`; leaves a misconfiguration route to an idle verdict |
| Auth type discriminator | Optional `type`, absent means `raw` | Required `type` with a config migration | Zero-migration compatibility for existing ARN-only configs; `raw` is a correct default for every pre-existing config, so migration machinery would buy nothing |
| Basic credential storage | Username and password together as JSON in one secret | Username in plaintext config, password in the secret | Keeps every credential part out of `deployment-config.json`; atomic rotation; a plaintext username would put part of the credential in a JSON file that support bundles and exports include |
| Who owns basic/bearer secrets | App creates, updates and deletes them under a deterministic name | Operator-supplied ARN with app writing only the value | Removes the manual Secrets Manager round trip for the two common cases; `raw` stays the escape hatch for externally managed or shared secrets. The operator-supplied-ARN variant remains the lower-scope fallback if `CreateSecret` ownership concerns surface |
| Header encoding point | At check time in the handler, per type | Pre-encode at write time and store as `raw` | Keeps the credential's structure validatable and `type` meaningful; the encoding is exactly the step operators should not do by hand, and it lives in the one place that already resolves the secret (`handler.ts:97-123`) |
| Secret deletion | Default recovery window, plus restore-on-reuse in upsert; app-owned secrets deleted on unset or game delete | `ForceDeleteWithoutRecovery`; never auto-delete | Safer against an accidental wizard clear; restore keeps clear-then-re-add working (`secretsStore.ts:113-135`, `:176-182`). Never auto-deleting was rejected: the Discord bot-token and public-key secrets are few and infra-provisioned once per deployment, whereas health-check credentials are created per game and per edit, so orphans would accumulate as untraceable Secrets Manager cost. `raw` secrets are never deleted |
| Network confinement granularity | Port-level egress toward the shared `gameServersSg` | Per-game security groups | Per-game SGs would touch every ingress rule and task definition, dwarfing the feature; they remain the follow-on that would close the gap |
| VPC placement | VPC-attached in public subnets, no NAT or endpoints | NAT gateway; interface endpoints; no VPC attachment | Avoid new network provisioning; on HEAD this leaves the function without AWS API reachability `[inferred]` |

## Open Questions & Future Decisions

### Resolved

1. Recovery-window choice for deleting app-owned secrets: default window, with `RestoreSecret` on re-add (resolved in `secretsStore.ts:113-135`, `:176-194`; a recoverable default guards against a wizard mis-click).
2. App-owned secret naming: `hyveon-{gameId}-healthcheck-auth` (`secretsStore.ts:94-96`; the deterministic name makes save idempotent: reuse and `PutSecretValue` when the persisted config holds an app-owned ARN, `CreateSecret` only when none exists).

### Deferred

1. How should the function receive the cluster name: an `ECS_CLUSTER` env var from infra (`lambdas.ts:568`, test pin `lambdas.test.ts:831`, doc `lambdas.md:302`), or a `cluster` field in the watchdog's invoke payload (`watchdog/src/handler.ts:127`)?
2. How should the function reach ECS and Secrets Manager: interface endpoints plus SG egress 443, a NAT gateway, or dropping `vpcConfig` and reaching the task another way (`lambdas.ts:564-567`, `securityGroups.ts:305`, `:432-453`)? The "normal route out of its public subnet" claim in the check's intent and the test comment at `lambdas.test.ts:834-836` must be corrected to whichever is chosen.
3. Should the watchdog bound each invoke's duration (or the function's timeout be lowered) so a hanging check cannot time out the whole watchdog run (`watchdog/src/handler.ts:203-216`, `lambdas.ts:563`, `:584`)? This must land with or before the fix for question 1.
4. Should a contract test assert that every env var the handler reads at module load is in the provisioned env, so `handler.test.ts:18-20` can no longer mask the gap?
5. Should `exists` on an unresolved path remain a conclusive idle verdict, or become failure-derived like other operators (`engine.ts:175-178`)?
6. Does an `https` check against a task's private IP work at all, given certificate validation against a hostname-issued Caddy certificate (`handler.ts:165-172`)? No test covers it.
7. Should `secretsStore.ts` be split into health-check and Discord modules, and should the uncalled Discord helpers `getBotToken`, `putBotToken`, `putPublicKey`, `invalidateSecretsCache` (`secretsStore.ts:63-91`) be deleted? Relatedly, should it leave the `@hyveon/shared` barrel (`shared/src/index.ts:35`) for a deep import, as `GamesWriteService.ts:35` already uses?
8. Should the secret-name prefix derive from `projectName` instead of the literal `hyveon-` (`secretsStore.ts:95`)?
9. Should a newly created app-owned secret be readable before the next infra apply, given the policy is built from persisted ARNs (`iam.ts:602-604`)?
10. Scripted health checks (operator-authored check code) are a planned follow-on that is not yet in this arrow. Before they start, their credential model must be reconciled with the `raw` / `basic` / `bearer` `type` discriminator, and the shared-function decision must be revisited because operator code would run in the function that holds every opted-in game's secrets.
11. Wizard: the timeout `FormField` passes no `errors` (`health-check-fields.component.tsx:122`), and the secret-storage hint is duplicated for basic and bearer (`health-check-fields.component.tsx:305-307`, `:326-328`). The component has no dedicated test file.
12. Stale comments: `handler.ts:53-59` refers to the watchdog's `getEniId`, now shared `getTaskEniId` / `getTaskPrivateIp`; `gameServerConfig.ts:184-189` describes only `raw` injection.
13. The region fallback chain at `handler.ts:34-37` is repeated in `secretsStore.ts:25-27` and every other Lambda handler; extract one shared helper?

## References

- Arrow doc: `docs/arrows/game-runtime/health-check.md`
- EARS specs (future): `docs/intent/game-runtime/health-check/health-check-specs.md` (prefix `RT-HEALTH`)
- Docs: `docs/docs/components/lambdas.md` (`## health-check`, and the watchdog section's health-check env and IAM rows)
- Neighbouring leaf designs: `docs/intent/game-runtime/watchdog/watchdog-design.md`, `docs/intent/game-runtime/task-and-dns/task-and-dns-design.md`, `docs/intent/iac/program/program-design.md`, `docs/intent/game-server/game-server-design.md`
- Parent: `docs/intent/game-runtime/game-runtime-design.md` (grouping node)
