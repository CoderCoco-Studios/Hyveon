---
title: Lambdas
sidebar_position: 4
---

# Lambdas

Six TypeScript Lambda packages live under `app/packages/lambda/`. Each
builds via esbuild to a single CJS file at `dist/handler.cjs`; the Pulumi
infra program's `lambdaCode()` helper (`app/packages/infra/src/lambdas.ts`)
wraps that file in an `AssetArchive`/`FileAsset` pair at deploy time —
functionally equivalent to the directory-archiving data source other IaC
tools provide, which has no direct Pulumi resource counterpart. One of the
six — `health-check` — is conditionally provisioned, existing only when at
least one game declares a `healthCheck` (see that section below); the other
five are always deployed.

```bash
npm run app:build:lambdas        # produces every dist/handler.cjs
```

The four core, always-on Lambdas (interactions, followup, update-dns,
watchdog) read AWS region from `process.env.AWS_REGION_` (trailing
underscore — `AWS_REGION` is reserved by the Lambda runtime). The Pulumi
infra program sets the variable with that name in every function definition
(`app/packages/infra/src/lambdas.ts`'s `defineLambdas`), including
efs-seeder's and health-check's — but efs-seeder never reads it, since it
makes no AWS SDK calls (see below).

## interactions

| | |
|---|---|
| **Package** | `@hyveon/lambda-interactions` |
| **Trigger** | Lambda Function URL (public HTTPS, `auth_type = NONE`, CORS for `https://discord.com`) — Discord POSTs every interaction here. |
| **Pulumi** | `app/packages/infra/src/lambdas.ts` (`interactionsFunction`, `interactionsFunctionUrl`). Output: `StackOutputs.interactionsInvokeUrl` (`program.ts`). |
| **IAM** | `dynamodb:GetItem` on the Discord table, `secretsmanager:GetSecretValue` on the public-key secret, `lambda:InvokeFunction` on the followup Lambda. |
| **Env vars** | `AWS_REGION_`, `TABLE_NAME`, `DISCORD_PUBLIC_KEY_SECRET_ARN`, `FOLLOWUP_LAMBDA_NAME`, `GAME_NAMES`, `HOSTED_ZONE_NAME`. |

### Behaviour

1. **Signature verify** — reads `x-signature-ed25519` + `x-signature-timestamp`
   headers, fetches the public key from Secrets Manager (5-minute cache via
   `@hyveon/shared/secrets`), and verifies with `@noble/ed25519` over
   `timestamp + rawBody`. Rejects 401 on mismatch; without a valid signature
   Discord stops routing to the URL.
2. **PING** (`type === 1`) → respond `{ type: 1 }` (PONG).
3. **Autocomplete** (`type === 4`) → filter `GAME_NAMES` by the user's
   partial input, then filter by `canRun()` against the DynamoDB config,
   return choices synchronously. No ECS calls — has to fit in Discord's
   3-second budget.
4. **Application command** (`type === 2`):
   - Confirm the guild is in `allowedGuilds`.
   - Confirm `canRun(cfg, { userId, roleIds, game, action })`.
   - Return a **deferred ack** (`type: 5`, ephemeral flag `64`) immediately.
   - Async-invoke the followup Lambda (`InvokeCommand` with `InvocationType:
     'Event'`) with a `FollowupPayload` (`kind`, applicationId,
     interactionToken, userId, guildId, roleIds, optional game).

If anything above throws, Discord sees either a non-200 response or a
silent timeout — the user gets no reply, which is the correct failure
mode (replying with an error would require another signed response, which
we can't forge).

## followup

| | |
|---|---|
| **Package** | `@hyveon/lambda-followup` |
| **Trigger** | Async invoke from the interactions Lambda (`InvocationType: 'Event'`). Not exposed externally. |
| **Pulumi** | `app/packages/infra/src/lambdas.ts` (`followupFunction`). |
| **IAM** | `ecs:RunTask` / `StopTask` / `ListTasks` / `DescribeTasks` / `TagResource`, `iam:PassRole` (task execution role — required for RunTask with Fargate), `ec2:DescribeNetworkInterfaces`, `dynamodb:GetItem` / `PutItem`, `secretsmanager:GetSecretValue` on the public key (only read for downstream calls in some paths). |
| **Env vars** | `AWS_REGION_`, `TABLE_NAME`, `ECS_CLUSTER`, `SUBNET_IDS` (comma-separated), `SECURITY_GROUP_ID`, `DOMAIN_NAME`, `GAME_NAMES`. |

### Behaviour

Event is a `FollowupPayload`:

```ts
type FollowupPayload = {
  kind: 'start' | 'stop' | 'status' | 'list'
  applicationId: string
  interactionToken: string
  userId: string
  guildId: string
  roleIds: string[]
  game?: string
}
```

1. Re-fetch the Discord config (defensive re-check — the interactions
   Lambda already ran `canRun`, but config could change between the two
   invocations).
2. Dispatch by `kind`:
   - **`start`** — `runStart()`: `ecs.runTask` with the game's task
     definition family (`{game}-server`), public-IP-enabled network
     config, the Fargate launch type. If successful, call `putPending()`
     (`PENDING#{taskArn}` with 15-min TTL); then PATCH the original
     interaction with "starting …".
   - **`stop`** — find the running task via `findRunningTask()`, call
     `ecs.stopTask`, PATCH "stopping …".
   - **`status`** — single-game `getStatus()` (ListTasks → DescribeTasks →
     `ec2.describeNetworkInterfaces` for the public IP), PATCH with the
     resolved state + hostname/IP.
   - **`list`** — status for every game the user has at least `status`
     permission for, joined into one ephemeral message.
3. PATCH the Discord webhook at
   `https://discord.com/api/v10/webhooks/{applicationId}/{interactionToken}/messages/@original`.
   Valid for 15 minutes after the original interaction.

Failure modes:

- ECS call fails → error message in the PATCH body.
- CloudWatch ENI lag (task RUNNING but no ENI yet) → `getStatus()` returns
  `{ state: 'error', message: ... }`; caller sees it in Discord.
- DynamoDB write fails (for `start`) → logged, PATCH still happens so user
  sees "starting"; but update-dns won't later PATCH with the final IP
  because the pending row doesn't exist.
- Discord PATCH fails (stale token, network) → logged; user's deferred
  message is not edited.

## update-dns

| | |
|---|---|
| **Package** | `@hyveon/lambda-update-dns` |
| **Trigger** | EventBridge rule on `source: aws.ecs`, `detail-type: 'ECS Task State Change'`, `lastStatus` in `['RUNNING', 'STOPPED']`. |
| **Pulumi** | `app/packages/infra/src/lambdas.ts` (`dnsUpdaterFunction`, `ecsTaskChangeRule`) — `route53.ts` only performs the hosted-zone lookup (DNS records themselves are Lambda-managed, never infra-program-managed). |
| **IAM** | `route53:ChangeResourceRecordSets`, `route53:ListResourceRecordSets`, `ecs:DescribeTasks`, `ec2:DescribeNetworkInterfaces`, `dynamodb:GetItem` / `DeleteItem`. |
| **Env vars** | `HOSTED_ZONE_ID`, `DOMAIN_NAME`, `GAME_NAMES`, `DNS_TTL`, `AWS_REGION_`, `TABLE_NAME`. |

### Behaviour

Event shape (simplified):

```json
{
  "detail": {
    "lastStatus": "RUNNING | STOPPED",
    "taskArn": "...",
    "clusterArn": "...",
    "group": "family:palworld-server"
  }
}
```

1. Parse the task family from `detail.group`, map to a game via
   `FAMILY_TO_GAME`. Skip unknown families. Every game — including
   `https = true` ones, which terminate TLS in-task via a Caddy sidecar and
   share the task's public IP — follows the same path below.
2. On `RUNNING`: `resolvePublicIp()` — retries up to 5 times with
   3-second sleeps to survive ENI attach lag; then `upsertDns()` writes
   an A record `{game}.{domain}` → IP with `DNS_TTL`.
3. On `STOPPED`: read the current record, verify its IP, `deleteDns()`.
4. On `RUNNING`: call `notifyDiscordIfPending()` — look up
   `PENDING#{taskArn}` in DynamoDB, format a final status message
   (including the resolved public IP), PATCH the original Discord
   interaction, delete the pending row.

Failure modes:

- IP not available after 5 retries → log warning, skip; the handler returns
  `{status: 'error', reason: 'no_ip'}`. No retry is scheduled — the task stays
  up but unreachable by DNS until another `RUNNING`/`STOPPED` state-change
  event fires for it (e.g. the task is stopped and started again).
- Route 53 call fails → log, continue. There is no retry and no backstop —
  the watchdog only issues `StopTask`, it never touches Route 53 — so a
  stale record persists until another `RUNNING`/`STOPPED` event fires for
  that game (e.g. the next start/stop cycle) or someone deletes it manually.
- Pending row missing (expired / never written / `stop` flow) → skip the
  Discord PATCH; no user-visible issue.
- Discord PATCH fails (stale token) → log, continue.

## watchdog

| | |
|---|---|
| **Package** | `@hyveon/lambda-watchdog` |
| **Trigger** | EventBridge schedule at `rate(${watchdog_interval_minutes} minute(s))`. No event payload. |
| **Pulumi** | `app/packages/infra/src/lambdas.ts` (`watchdogFunction`, `watchdogScheduleRule`). |
| **IAM** | `ecs:ListTasks` / `DescribeTasks` / `StopTask` / `TagResource` / `ListTagsForResource`, `cloudwatch:GetMetricStatistics`, and — only when at least one game declares a `healthCheck` — `lambda:InvokeFunction` scoped to the health-check function's ARN. |
| **Env vars** | `ECS_CLUSTER`, `GAME_NAMES`, `IDLE_CHECKS`, `MIN_PACKETS`, `CHECK_WINDOW_MINUTES`, `AWS_REGION_`, `HEALTH_CHECKS` (JSON map, game → that game's `healthCheck` declaration; `{}` when no game opts in), `HEALTH_CHECK_FUNCTION_NAME` (the health-check function's name; empty string when it doesn't exist). |

### Behaviour

1. `ListTasks(desiredStatus: RUNNING)` across the cluster. Paginates.
2. `DescribeTasks` on the batch to get attachments and tags.
3. For each task, resolve its game from the task-def family, then get a
   verdict from exactly one of two sources — never both:
   - **`HEALTH_CHECKS[game]` is absent** (the common case today): resolve
     the ENI ID from attachments, then `cloudwatch.GetMetricStatistics` →
     `AWS/EC2/NetworkPacketsIn` over the last `CHECK_WINDOW_MINUTES`. If the
     call fails, assume **active** (fails-safe for fresh tasks with no
     metrics yet). Idle iff `packets < MIN_PACKETS`.
   - **`HEALTH_CHECKS[game]` is present**: synchronously `Invoke` the
     health-check Lambda (`RequestResponse`) with
     `{ game, taskArn, healthCheck }`. A failed invoke — throttled, the
     function absent or unreachable, a timeout, a `FunctionError`, or a
     malformed response — is fail-active (assumed active) and does **not**
     increment the idle counter, the same treatment a failed CloudWatch
     query gets. The invoked verdict's `reason` is folded into this Lambda's
     own idle/shutdown log line, so one line explains verdict, idle count,
     and (eventually) shutdown regardless of which source produced it. See
     `game-health-checks`'s OpenSpec capability and the `health-check`
     section below for the check itself.
   - If idle by whichever source applied:
     - Increment the `idle_checks` tag.
     - If the counter reaches `IDLE_CHECKS`:
       - `StopTask` with reason `Watchdog: idle for {N} minutes`. This Lambda
         does not touch DNS directly — the resulting `STOPPED` state-change
         event is what triggers update-dns's record deletion. Deleting the
         record here first would risk leaving a running task unreachable by
         DNS if `StopTask` then failed.
     - Otherwise persist the incremented counter via `TagResource`.
   - Else (active), if the counter is non-zero, reset it to 0.

Watchdog state lives **only** in the `idle_checks` ECS task tag. It's
inherently scoped to the task — when the task goes away, so does the
state, which is exactly what we want. Do not move it to DDB/SSM. The
watchdog itself gains no VPC attachment and no health-check credential from
this routing — it only ever holds the ARN it's permitted to invoke.

Failure modes:

- CloudWatch query fails → treated as active (no accidental shutdowns).
- Health-check invoke fails, or the health-check itself reports a
  failure-derived verdict → treated as active, same as a CloudWatch
  failure.
- Tagging fails → logged; a task might hang around a cycle longer than
  intended.
- `StopTask` fails → logged; next schedule tick retries.

## efs-seeder

| | |
|---|---|
| **Package** | `@hyveon/lambda-efs-seeder` |
| **Trigger** | An `aws.lambda.Invocation` resource in `app/packages/infra/src/escapes.ts`'s `defineEfsSeederInvocations`, invoked synchronously as part of `PulumiService`'s `apply()` (`stack.up()`). Not exposed externally, not event-driven, and not part of the always-on control flow the other four Lambdas belong to. |
| **Pulumi** | `app/packages/infra/src/lambdas.ts` (`efsSeederFunctions`, `efsSeederLogGroups`) and `app/packages/infra/src/escapes.ts` (`efsSeederInvocations`). **One function per game that declares `file_seeds`** — this Lambda is conditionally created, not fixed like the other four. Games with no `file_seeds` get no seeder function, no seeder IAM role, and no seeder log group. |
| **IAM** | Per-game role: `logs:CreateLogGroup`/`CreateLogStream`/`PutLogEvents`, `ec2:CreateNetworkInterface`/`DescribeNetworkInterfaces`/`DeleteNetworkInterface` (required for Lambda VPC networking), `elasticfilesystem:ClientMount`/`ClientWrite` scoped to the shared EFS filesystem. |
| **Env vars** | `AWS_REGION_` — set by the Pulumi infra program for consistency with the other Lambdas, but unused: this handler makes no AWS SDK calls (see below). |

### Behaviour

The Lambda mounts the game's first volume's EFS access point at `/mnt/efs`
via `file_system_config` (VPC-attached, using the same public subnets and a
dedicated `efs-seeder` security group scoped to outbound NFS only — port
2049/tcp to the EFS security group, via a standalone `aws.ec2.SecurityGroupRule`
rather than an inline rule on the seeder group itself; see the `efsSeederSg`
group and its `efsSeederEgressRule` in `app/packages/infra/src/securityGroups.ts`)
and receives `{ game, seeds, container_path }` as its invocation payload —
`container_path` is `volumes[0].container_path`.

1. For each `FileSeed` in `seeds`: strip the `container_path` prefix from
   `path` and resolve the remainder under `/mnt/efs`, rejecting anything that
   resolves outside the mount point (path-traversal guard) or has no file
   component left after stripping the prefix.
2. Decode `content` (UTF-8 text) or `content_base64` (binary) — exactly one
   must be set — and validate `mode` is a 3–4 digit octal string (default
   `"0644"`).
3. `mkdirSync(..., { recursive: true })` then `writeFileSync` with that mode.
4. Throw on any error — `aws.lambda.Invocation` is a synchronous Pulumi
   resource (it calls the Lambda's `Invoke` API during resource creation),
   so a thrown error surfaces directly as a failed `PulumiService.apply()`
   run (`stack.up()`, raised to the caller as `PulumiUpError`/
   `PulumiPartialApplyError`) rather than an async CloudWatch-only failure.

Unlike the other four Lambdas, this handler imports no `@aws-sdk/*` package
at all — it only touches the filesystem (`fs`, `path`), which is why the
`AWS_REGION_` env var the infra program sets on it is never actually read.

**Re-trigger behaviour**: each invocation's `triggers` is
`{ seedsHash: fileSeedsHash(fileSeeds) }` (`escapes.ts`'s
`defineEfsSeederInvocations`) — a SHA-256 digest of the game's `file_seeds`
array — so a deploy only re-invokes the Lambda for a game when that game's
`file_seeds` content actually changes; a deploy with unchanged seeds is a
no-op for this Lambda. Removed seed entries are not deleted from EFS; clean
them up via the FileBrowser task.

Failure modes:

- Path validation error (traversal, missing file component, both/neither of
  `content`/`content_base64` set, invalid `mode`) → thrown synchronously,
  fails the `PulumiService.apply()` run.
- EFS mount not ready (mount targets still propagating) → Lambda invocation
  fails; the deploy reports the error — retry once mount targets are up
  (~30 s after the EFS mount target's creation).

## health-check

| | |
|---|---|
| **Package** | `@hyveon/lambda-health-check` |
| **Trigger** | Synchronous invoke (`InvocationType: RequestResponse`) from the watchdog Lambda, once per running task belonging to a game that declares a `healthCheck`. Not exposed externally, and invocable only by the watchdog — no Function URL, no resource-based `aws.lambda.Permission`; the grant is an IAM identity-policy statement on the watchdog's own role. |
| **Pulumi** | `app/packages/infra/src/lambdas.ts` (`healthCheckFunction`, `healthCheckLogGroup`). **A single shared function, conditionally created** — provisioned only when at least one game declares `healthCheck` (`iam.ts`'s `gamesWithHealthChecks`), unlike efs-seeder's one-function-per-game shape. A deployment where no game opts in gets no health-check function, role, security group, or log group. |
| **IAM** | Single shared role: `logs:CreateLogGroup`/`CreateLogStream`/`PutLogEvents`, `ec2:CreateNetworkInterface`/`DescribeNetworkInterfaces`/`DeleteNetworkInterface` (required for Lambda VPC networking), `ecs:DescribeTasks` scoped to the deployed cluster, and — only when at least one opted-in game references a credential — `secretsmanager:GetSecretValue` scoped to exactly those `auth.secretArn` values. |
| **Env vars** | `AWS_REGION_` only. Everything else it needs (`game`, `taskArn`, the full `healthCheck` declaration) arrives in the invocation payload from the watchdog. |

### Behaviour

Invocation payload: `{ game: string, taskArn: string, healthCheck: GameServerHealthCheck }`.

1. Resolve the checked task's private IPv4 address from ECS
   `DescribeTasks` attachment details — the same attachment-walking shape
   the watchdog's own ENI resolution uses, reading `privateIPv4Address`
   instead of `networkInterfaceId`. This is the *only* source of the
   request's destination host; the declared configuration never supplies
   one, closing the SSRF surface by construction rather than by validation.
2. When `healthCheck.auth` is present, fetch the credential's raw value
   from Secrets Manager and build the `Authorization` header value by
   branching on `auth.type` (`'raw' | 'basic' | 'bearer'`, defaulting to
   `'raw'` when absent):
   - **`raw`** (or no `type` — every declaration made before `type`
     existed) — the secret's raw string, verbatim, no prefix.
   - **`bearer`** — `` `Bearer <secretValue>` ``.
   - **`basic`** — parses the secret string as JSON shaped
     `{ username: string, password: string }`, then base64-encodes
     `username:password` into `` `Basic <encoded>` ``. A secret that isn't
     valid JSON, or isn't shaped that way, makes header construction throw;
     the handler's top-level `try`/`catch` (below) turns that into the same
     fail-active verdict as any other credential failure — a broken `basic`
     secret produces a repeating `warn`-level "active" verdict, not a crash.

   The resulting value is injected as a single, fixed `Authorization`
   header — never interpolated into the path, query string, or any other
   declared header — overriding any operator-supplied `Authorization`
   entry in `healthCheck.headers`. The Lambda only ever reads the secret at
   `auth.secretArn`; it never creates, updates, or deletes one — that's the
   desktop app's write path, covered by the existing `secretsmanager:*`
   grant in the [`HyveonDeployAll` policy](/setup). This Lambda's own
   `GetSecretValue`-only grant (above) is unaffected by `type`.
3. Issue the declared request (`scheme`/`port`/`path`/`method`/`headers`),
   bounded by `healthCheck.timeoutMs` as a single wall-clock budget, with
   no redirect following (a 3xx response is a failed check, not a hop to
   chase).
4. Delegate the verdict to the pure evaluation engine
   (`src/engine.ts`, no I/O, table-tested in isolation): parse the
   response body as JSON, resolve `activeWhen.jsonPath` (plain field
   access and numeric array indices only — no wildcards, filters, or
   recursive descent), and apply `activeWhen.operator`. The condition
   holding means active; not holding means idle.

**Fail-active is the rule at every failure point** — a check that can't
produce a conclusive verdict is reported active, never idle, matching the
watchdog's own fail-active handling of a failed CloudWatch query:

- Non-2xx response status.
- Response body that isn't valid JSON.
- `activeWhen.jsonPath` resolving to no value, or to a non-scalar
  (object/array) value.
- A value the declared `activeWhen.operator` can't compare (e.g. a string
  where `greaterThan` expects a number).
- Any transport or credential failure — timeout, refused connection, an
  unavailable secret.

Every verdict carries a `reason` naming the JSONPath and operator involved,
**never the resolved response value** — a game's response body may carry
player identities or network addresses. Logs `debug` on entry with
`{ game, kind, port }` and on a genuine verdict; a failure-derived verdict
(the fail-active cases above) logs at `warn` instead, so a persistently
broken check surfaces as a repeating fault rather than silent, ever-growing
cost.

Failure modes:

- Any of the fail-active cases above → verdict `{ active: true, reason,
  failureDerived: true }`, logged at `warn`.
- The health-check function itself is throttled, absent, or times out →
  the *watchdog* (not this Lambda) treats the failed invoke as fail-active
  — see the watchdog section above.

## The `/server-start` critical path, assembled

```text
User types /server-start palworld
  → Discord POSTs to interactions Function URL
    → interactions verifies + returns type:5 ack + async-invokes followup
      → followup RunTask + put PENDING#{arn} + PATCH @original "starting"
        → ECS reaches RUNNING
          → EventBridge fires update-dns
            → update-dns resolves IP + UPSERT A + get+delete PENDING#{arn}
              + PATCH @original "🟢 running — palworld.example.com"
```

Every Lambda has its own CloudWatch log group; when a step goes wrong, the
group with the latest events is the one that last ran. The interactions
Lambda logs the `async invoke of followup` line; if you see that but no
followup logs, check IAM.
