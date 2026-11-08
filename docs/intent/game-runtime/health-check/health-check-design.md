---
parent: game-runtime
prefix: RT-HEALTH
---

# Authoritative Health Check

## Context and Design Philosophy

The watchdog's default idleness signal is the task's inbound traffic from ECS Container Insights, which cannot tell a server with players apart from a server receiving background traffic. The health check lets a game opt in to a better signal: it declares an HTTP request against its own management API and a single condition on the response, and the watchdog then asks that question instead of measuring traffic. For an opted-in game the verdict fully replaces the CloudWatch measurement for that cycle (`app/packages/lambda/watchdog/src/handler.ts:211-216`).

This leaf owns:

- The `@hyveon/lambda-health-check` package: the handler that takes the host from the invoke payload, resolves the credential and issues the request (`app/packages/lambda/health-check/src/handler.ts:156-188`) and the pure verdict engine (`app/packages/lambda/health-check/src/engine.ts:156-212`).
- The app-owned credential lifecycle helpers in `@hyveon/shared` (`app/packages/shared/src/secrets/secretsStore.ts:94-194`).
- The wizard's health-check subsection (`app/packages/web/src/components/add-game-wizard/health-check-fields.component.tsx`).

It deliberately does not own, and cites instead:

- The idle counter, the stop decision, the invoke wrapper and the resolution of the checked task's private IP: `game-runtime/watchdog` (`app/packages/lambda/watchdog/src/handler.ts:113-144`). The watchdog is the sole invoker.
- The task ENI and private-IP helpers: `game-runtime/task-and-dns` (`getTaskPrivateIp` in `app/packages/shared/src/aws/ecsTask.ts`), called by the watchdog on its own `DescribeTasks` result.
- Provisioning of the function, role, policy, security groups, subnets and the Secrets Manager interface VPC endpoint: `iac/program` (`app/packages/infra/src/lambdas.ts:535-571`, `app/packages/infra/src/iam.ts:389-396`, `:602-634`, `app/packages/infra/src/securityGroups.ts:287-320`, `:432-453`, `app/packages/infra/src/network.ts`).
- The `GameServerHealthCheck` type, its zod schema and cross-field rules, and the write path that calls the credential helpers: `game-server` (`app/packages/shared/src/gameServerConfig.ts:117-195`, `app/packages/shared/src/gameServerValidator.ts:114`, `:986-1030`, `app/packages/desktop-main/src/services/GamesWriteService.ts:474-535`).

Guiding principles, each visible in code:

1. **Fail-active.** A check that cannot reach a conclusive answer must never read as idle, because the cost of a wrongly stopped server (players dropped) is worse than the cost of a server kept running (`engine.ts:144-151`). The principle is implemented at three layers, not one (see "Fail-active layering").
2. **Zero footprint when unused.** No game declares `healthCheck` means no function, role, policy, security group or log group (`iam.ts:390`, `lambdas.ts:545`, `securityGroups.ts:292-296`). No game declares `healthCheck.auth` means no Secrets Manager endpoint, so a deployment pays for the endpoint only while a check needs a credential (see "Provisioning and Reachability").
3. **Host is never configuration.** The request is always addressed to the checked task's own private IP, which the watchdog reads from its ECS `DescribeTasks` result and passes in the invoke payload, so there is no `healthCheck` field through which a check can be pointed elsewhere (`gameServerConfig.ts:164-170`). The payload is trusted because the watchdog is the function's only invoker (`RT-HEALTH-NET-003`).
4. **No response value leaves the function.** Verdict reasons name the JSONPath and operator, never the value found or the body (`engine.ts:7-12`); logs carry only game, kind, port, active and reason (`handler.ts:145-148`, `:158`).

CLAUDE.md invariants that live here: Lambda env uses `AWS_REGION_` (`handler.ts:34-37`); secrets never reach the renderer, enforced by `redactGameServer` replacing `auth` with `secretSet` / `authType` (`gameServerConfig.ts:373-381`); `@hyveon/shared` AWS helpers, where `secretsStore.ts` is currently reachable from the barrel (`app/packages/shared/src/index.ts:35`) rather than only as a deep import.

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
| Request | `{ game, taskArn, privateIp, healthCheck }`: `privateIp` is the checked task's private IPv4 address as the watchdog resolved it with `getTaskPrivateIp`; `healthCheck` is the declaration forwarded verbatim from the watchdog's `HEALTH_CHECKS` env map | `handler.ts:28-32`, `watchdog/src/handler.ts:122-128` |
| Response | `{ active: boolean, reason: string, failureDerived: boolean }` | `engine.ts:4-22` |

The watchdog learns which games opted in from `HEALTH_CHECKS`, a JSON env var built by `healthChecksByGame` with sorted keys and only opted-in games (`lambdas.ts:335-343`, `:595`), and the function name from `HEALTH_CHECK_FUNCTION_NAME` (`lambdas.ts:596`). It never reads `deployment-config.json` at runtime, so a declaration change takes effect only after an infra apply re-renders the env var `[inferred]`.

## Check Execution

One invocation runs this sequence (`handler.ts:156-188`):

1. **Take the host and resolve the credential** (`handler.ts:161`). The host is the payload's `privateIp`; the function makes no ECS call. A `privateIp` that is absent (`undefined` or `null`) or that Node's `net.isIPv4` rejects, applied to the value as received with no trimming, throws, which the handler turns into the standard failure-derived verdict (`active: true`, `failureDerived: true`, reason prefixed `health check failed:`), so no hostname, IPv6 address or other string ever becomes a request target. Any well-formed IPv4 literal is accepted without a VPC CIDR or private-range check, because the watchdog is the only invoker and reads the address from ECS. The credential is fetched with `GetSecretValue` on `auth.secretArn` only when `auth` is declared, over the Secrets Manager interface endpoint, under one overall deadline that covers the whole call, SDK retry attempts included, so an unreachable endpoint fails the fetch instead of running the function toward its own timeout; an empty `SecretString` throws (`handler.ts:74-83`). The deadline is 5 s, shorter than the function's 30 s timeout, and the deadline plus the check's `timeoutMs` (at most 10 s) fits inside the watchdog's 40 s per-run bound on health-check invokes (`RT-WATCHDOG-HC-006`), since both draw on the same 60 s watchdog budget. A cold private-DNS resolution of the endpoint hostname is inside that deadline: a lookup that does not complete in time fails the fetch, fail-active. The request URL is built so that the declared `path` can never change its authority, so the connect address is always `privateIp`. The address is a snapshot from the watchdog's `DescribeTasks` call: a task that stops between that call and the request leaves the address unanswered (connection refused or timeout, fail-active), and an address ECS reassigns inside that window of seconds to another task listening on the same declared port is checked instead, which the port-level confinement of the shared `gameServersSg` already accepts (see "Provisioning and Reachability"). Only IPv4 literals are accepted, because Fargate tasks in these subnets carry an IPv4 private address and the security-group rules are IPv4.
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
| Handler | Missing or non-IPv4 `privateIp` in the payload, secret fetch (including an unreachable endpoint and the overall secret-fetch deadline), malformed basic secret, network error, timeout | `handler.ts:178-187` |
| Watchdog invoke wrapper | No private IP readable for the task (no invoke is made), no function configured, invoke throws, `FunctionError` (including init failure), malformed payload | `watchdog/src/handler.ts:117-143` |

A failure-derived verdict is logged at `warn` by both the handler and the watchdog (`handler.ts:147`, `watchdog/src/handler.ts:217`), so a persistently broken check shows up as a repeating fault rather than silence. The accepted trade is that a broken check keeps a server running indefinitely, costing money. This is deliberate: fail-active is the safe direction for players and the unsafe direction for cost, and the opposite default could stop a live server with players on it.

Interaction with the watchdog schedule: the watchdog invokes synchronously, one task at a time, under a 60 s timeout, while the health-check function has a 30 s timeout. The watchdog bounds the whole run's health-check time to 40 s (`HEALTH_CHECK_RUN_BUDGET_MS` in `@hyveon/shared`): each invoke is aborted when the remaining budget elapses, and once the budget is spent the remaining health-checked tasks of that run take a failure-derived active verdict without an invoke (`RT-WATCHDOG-HC-006`), so slow or hung checks cannot time out the watchdog and skip CloudWatch-path games. A check's worst case is the secret deadline (5 s, `HEALTH_CHECK_SECRET_DEADLINE_MS`) plus the largest declared `timeoutMs` (10 s, `HEALTH_CHECK_TIMEOUT_MAX_MS`), which fits the budget (`RT-HEALTH-FAIL-006`) and sits under the function's 30 s timeout (`RT-HEALTH-FAIL-005`).

## Provisioning and Reachability

Provisioning is owned by `iac/program`; the contract this leaf depends on is:

| Resource | Shape | Source |
|---|---|---|
| Function `{projectName}-health-check` | 30 s timeout, `vpcConfig` in the public subnets with the health-check SG, env `{ AWS_REGION_ }` (the handler reads no cluster name, because it makes no ECS call), no Function URL | `lambdas.ts:545-571` |
| Role and inline policy | One shared role; logs, VPC ENI, and `secretsmanager:GetSecretValue` on exactly the declared `auth.secretArn` values; no `ecs:*` action | `iam.ts:389-396`, `:602-634` |
| Health-check security group | No inline egress; one standalone TCP egress rule per distinct declared port toward `gameServersSg`, with matching ingress on the game SG from the health-check SG; while at least one game declares `healthCheck.auth`, one further standalone TCP 443 egress rule toward the endpoint security group | `securityGroups.ts:287-320`, `:432-453` |
| Secrets Manager interface VPC endpoint | Declared only while at least one game declares `healthCheck.auth`: service `com.amazonaws.{region}.secretsmanager`, one ENI in the first public subnet (subnet 0), private DNS enabled, its own security group whose only ingress is a standalone TCP 443 rule from the VPC CIDR and which has no egress | `program-design.md`, "Resource Areas and the Per-Game Fan-Out" |
| Watchdog grant | `lambda:InvokeFunction` on the health-check function ARN only | `iam.ts` (watchdog policy), `docs/docs/components/lambdas.md:182` |

The function is VPC-attached only so that it can open connections to game tasks on their private IPs; that is the one network path it needs for every check. It makes no ECS call: the watchdog already holds the checked task's `DescribeTasks` result and passes its private IP in the payload. Its only AWS API call is `GetSecretValue`, made only for a check that declares `auth`, and it reaches Secrets Manager through the interface endpoint. With private DNS enabled the regional Secrets Manager hostname resolves to the endpoint's private address inside the VPC, so the SDK client needs no endpoint override; private DNS relies on the VPC's DNS support and hostnames settings (`IAC-PROGRAM-NET-001`). A VPC-attached Lambda ENI has no public IP and the VPC has no NAT gateway (`IAC-PROGRAM-NET-002`), so the function has no other route to any AWS API; a check that declares `auth` in a deployment without the endpoint cannot fetch its credential and is fail-active.

The endpoint is the only always-on cost this leaf can add. An interface endpoint bills per hour for each subnet it occupies plus a per-GB processing charge, about $7.30 a month per subnet in us-east-1 before processing, so it is placed in subnet 0 alone and declared only while a game declares `auth`; a deployment whose checks are all unauthenticated pays nothing for health-check networking. While it exists the endpoint runs whether or not any game task is running, which is the price an operator accepts by declaring a health-check credential. This is the one exception to the HLD's monthly storage-and-state baseline (`docs/high-level-design.md`, "Success Metrics").

The function's own `vpcConfig` keeps both public subnets. An invocation in the other subnet reaches the endpoint across Availability Zones inside the VPC. If subnet 0's Availability Zone is unavailable, checks that declare `auth` cannot fetch their credential and are fail-active for the outage, while checks without `auth` keep working from the other subnet.

The placement follows from HLD goal 1 ("No idle compute cost") and the under-$5 monthly baseline, which rule out always-on networking for a feature most games use without a credential:

- A NAT gateway bills hourly, about $32 a month in us-east-1, plus per-GB processing, around the clock, and needs private subnets the network does not have.
- Interface endpoints for both ECS and Secrets Manager would bill about $7.30 a month each per subnet in us-east-1 in every deployment with any health check, although the watchdog already holds the task's private IP from the `DescribeTasks` call it makes every run, so the ECS endpoint buys nothing.
- Dropping `vpcConfig` would give the function the public internet, but the task would then have to be reached on its public IP, which means opening the health-check port to the internet rather than to one security group and reading the IP from EC2 `DescribeNetworkInterfaces`.
- Having the watchdog resolve the secret and pass the credential in the payload would put every opted-in game's secret in the function every shutdown depends on, contradicting "Where the check runs" and `RT-WATCHDOG-HC-005`.

Network confinement is port-level, not game-level: all game tasks share `gameServersSg`, so a non-opted-in game listening on a port some opted-in game declares is reachable from the function. The request is still addressed to one specific task's private IP from the watchdog's `DescribeTasks` result, so reachability is not the same as a request being made; the confinement is stated accurately rather than overclaimed. The endpoint security group admits TCP 443 from the whole VPC CIDR. Private DNS applies to the whole VPC, so any other VPC resource that calls Secrets Manager while the endpoint exists resolves to the endpoint and can use it rather than leaving through the internet gateway; no other resource in the VPC needs Secrets Manager. Admitting the VPC CIDR keeps such a client working instead of being silently refused, and the function's own reach is still limited by the health-check SG's egress rules.

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
| Verdict logic placement | Pure `evaluateHealthCheck` separate from the handler | Logic inline in the handler | Whole decision matrix is table-testable without AWS mocks, mirroring `canRun()`; the handler keeps only the parts that need mocking (secret fetch, the HTTP call) |
| How the watchdog learns opt-ins | `HEALTH_CHECKS` JSON env map rendered by infra | Watchdog reads `deployment-config.json` from S3; always invoke and let the function decide | No new S3 access for the watchdog; no network hop or provisioning for non-opted-in deployments. Always invoking was rejected because it would provision the function unconditionally, losing zero footprint, and put a network hop in front of every idle decision. The watchdog forwards the declaration verbatim, including `auth.secretArn`; an ARN is a reference, not a credential, so the watchdog never handles a resolved secret value or issues the request |
| Failure semantics | Fail-active at engine, handler and invoke-wrapper layers | Fail-idle; fail-active in the engine only | A wrongly stopped server drops players; the absent-function failure runs no lower layer. The accepted cost is a persistently broken check keeping a server running, made visible by `warn` logs |
| Destination host | Always the checked task's private IP, read by the watchdog from its `DescribeTasks` result and passed in the invoke payload | A configurable `host` field with validation | SSRF closed by construction: there is no configuration field to validate; configuration supplies scheme, port, path, method and headers only, and the payload's host comes from ECS through the function's only invoker |
| Condition expressiveness | Single `activeWhen` comparison, restricted JSONPath | Boolean expression tree; full JSONPath | An expression tree is the first step to an interpreter; scripted checks are the planned answer, and a game whose API needs AND/OR keeps the network heuristic until then |
| Redirect handling | `redirect: 'manual'`, so any 3xx is a fail-active failure | Follow redirects | Following would let a game redirect the check to another host, reopening the SSRF surface `[inferred]` |
| `exists` on an unresolved path | Conclusive idle verdict | Treat as failure-derived like other operators | Matches the spec's cardinality semantics for `exists` `[inferred]`; leaves a misconfiguration route to an idle verdict |
| Auth type discriminator | Optional `type`, absent means `raw` | Required `type` with a config migration | Zero-migration compatibility for existing ARN-only configs; `raw` is a correct default for every pre-existing config, so migration machinery would buy nothing |
| Basic credential storage | Username and password together as JSON in one secret | Username in plaintext config, password in the secret | Keeps every credential part out of `deployment-config.json`; atomic rotation; a plaintext username would put part of the credential in a JSON file that support bundles and exports include |
| Who owns basic/bearer secrets | App creates, updates and deletes them under a deterministic name | Operator-supplied ARN with app writing only the value | Removes the manual Secrets Manager round trip for the two common cases; `raw` stays the escape hatch for externally managed or shared secrets. The operator-supplied-ARN variant remains the lower-scope fallback if `CreateSecret` ownership concerns surface |
| Header encoding point | At check time in the handler, per type | Pre-encode at write time and store as `raw` | Keeps the credential's structure validatable and `type` meaningful; the encoding is exactly the step operators should not do by hand, and it lives in the one place that already resolves the secret (`handler.ts:97-123`) |
| Secret deletion | Default recovery window, plus restore-on-reuse in upsert; app-owned secrets deleted on unset or game delete | `ForceDeleteWithoutRecovery`; never auto-delete | Safer against an accidental wizard clear; restore keeps clear-then-re-add working (`secretsStore.ts:113-135`, `:176-182`). Never auto-deleting was rejected: the Discord bot-token and public-key secrets are few and infra-provisioned once per deployment, whereas health-check credentials are created per game and per edit, so orphans would accumulate as untraceable Secrets Manager cost. `raw` secrets are never deleted |
| Network confinement granularity | Port-level egress toward the shared `gameServersSg` | Per-game security groups | Per-game SGs would touch every ingress rule and task definition, dwarfing the feature; they remain the follow-on that would close the gap |
| VPC placement and AWS API reachability | VPC-attached in both public subnets for game-port egress; private IP passed by the watchdog, so no ECS call; Secrets Manager interface endpoint in subnet 0 only while a game declares `healthCheck.auth` | NAT gateway; always-on ECS and Secrets Manager endpoints; no VPC attachment; watchdog passes the credential | HLD goal 1: $0 for checks without `auth`, one single-subnet endpoint otherwise; the ECS endpoint buys nothing the watchdog lacks, and the credential stays out of the watchdog (see "Provisioning and Reachability") |
| Health-check time bounds | Secret fetch deadline 5 s; watchdog per-run health-check budget 40 s; function timeout stays 30 s | A per-task budget only; lowering the function timeout; invoking health checks concurrently | One run shares the watchdog's 60 s: 40 s leaves 20 s for listing, CloudWatch queries and tag writes, and 5 s plus the largest `timeoutMs` (10 s) fits the budget with room for a second check. Concurrent invokes would need the watchdog to hold several in-flight verdicts and raise concurrency on the function, more than the problem needs |
| HTTPS health-check target | Deferred: an `https` check addresses the private IP with default certificate validation and is expected to read fail-active | Set TLS `servername` to the game's hostname; skip certificate verification | The Caddy certificate is issued for `{game}.{zone}`, so a handshake to an IP fails hostname verification. Setting `servername` needs the game FQDN in the payload and a handler change with a Caddy-backed integration test; skipping verification is rejected as it weakens the transport for credentialed checks. A verified handshake test against a Caddy-served task would un-defer it (`RT-HEALTH-HTTP-005`) |

## Open Questions & Future Decisions

### Resolved

1. Recovery-window choice for deleting app-owned secrets: default window, with `RestoreSecret` on re-add (resolved in `secretsStore.ts:113-135`, `:176-194`; a recoverable default guards against a wizard mis-click).
2. App-owned secret naming: `hyveon-{gameId}-healthcheck-auth` (`secretsStore.ts:94-96`; the deterministic name makes save idempotent: reuse and `PutSecretValue` when the persisted config holds an app-owned ARN, `CreateSecret` only when none exists).
3. How the function learns the task's host and reaches Secrets Manager: the watchdog passes the private IP in the payload, so the function needs no cluster name and no ECS access, and a conditional Secrets Manager interface endpoint in subnet 0 serves checks that declare `auth`; the function's `vpcConfig` keeps both subnets (Decisions & Alternatives: "VPC placement and AWS API reachability").
4. Payload host validation: `privateIp` must be a well-formed dotted-decimal IPv4 literal (Node's `net.isIPv4`), with no VPC CIDR or private-range check; anything else is a failure-derived verdict ("Check Execution").
5. A RUNNING task whose private IP is absent, empty or not a well-formed IPv4 literal: the watchdog makes no invoke and records a failure-derived active verdict itself (`watchdog-design.md`, "Health-check invoke").
6. Secret-fetch bound: one overall deadline covers the whole `GetSecretValue` call including SDK retries, shorter than the function timeout and inside the `RT-WATCHDOG-HC-006` budget ("Check Execution").
7. Health-check time bounds: secret deadline 5 s, watchdog per-run budget 40 s, function timeout 30 s (Decisions & Alternatives: "Health-check time bounds").

### Deferred

1. Should a contract test assert that every env var the handler reads at module load is in the provisioned env, so `handler.test.ts:18-20` can no longer mask a gap?
2. Should `exists` on an unresolved path remain a conclusive idle verdict, or become failure-derived like other operators (`engine.ts:175-178`)?
3. Does an `https` check against a task's private IP work at all, given certificate validation against a hostname-issued Caddy certificate? The spec is deferred (`RT-HEALTH-HTTP-005`); no test covers an https check end to end.
4. Should `secretsStore.ts` be split into health-check and Discord modules, and should the uncalled Discord helpers `getBotToken`, `putBotToken`, `putPublicKey`, `invalidateSecretsCache` (`secretsStore.ts:63-91`) be deleted? Relatedly, should it leave the `@hyveon/shared` barrel (`shared/src/index.ts:35`) for a deep import, as `GamesWriteService.ts:35` already uses?
5. Should the secret-name prefix derive from `projectName` instead of the literal `hyveon-` (`secretsStore.ts:95`)?
6. Should a newly created app-owned secret be readable before the next infra apply, given the policy is built from persisted ARNs (`iam.ts:602-604`)? The endpoint has the same apply dependency: the first `auth` declaration in a deployment has no endpoint until the next apply.
8. Scripted health checks (operator-authored check code) are a planned follow-on that is not yet in this arrow. Before they start, their credential model must be reconciled with the `raw` / `basic` / `bearer` `type` discriminator, and the shared-function decision must be revisited because operator code would run in the function that holds every opted-in game's secrets.
9. Wizard: the timeout `FormField` passes no `errors` (`health-check-fields.component.tsx:122`), and the secret-storage hint is duplicated for basic and bearer (`health-check-fields.component.tsx:305-307`, `:326-328`). The component has no dedicated test file.
10. Stale comment: `gameServerConfig.ts:184-189` describes only `raw` injection.
11. The region fallback chain at `handler.ts:34-37` is repeated in `secretsStore.ts:25-27` and every other Lambda handler; extract one shared helper?
12. Should the wizard tell the operator that declaring a health-check credential adds an always-on Secrets Manager endpoint charge to the deployment?

## References

- Arrow doc: `docs/arrows/game-runtime/health-check.md`
- EARS specs (future): `docs/intent/game-runtime/health-check/health-check-specs.md` (prefix `RT-HEALTH`)
- Docs: `docs/docs/components/lambdas.md` (`## health-check`, and the watchdog section's health-check env and IAM rows)
- Neighbouring leaf designs: `docs/intent/game-runtime/watchdog/watchdog-design.md`, `docs/intent/game-runtime/task-and-dns/task-and-dns-design.md`, `docs/intent/iac/program/program-design.md`, `docs/intent/game-server/game-server-design.md`
- Parent: `docs/intent/game-runtime/game-runtime-design.md` (grouping node)
