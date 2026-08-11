---
title: Infra program
sidebar_position: 2
---

# Infra program

The Pulumi-managed application stack is provisioned by `app/packages/infra`
(`@hyveon/infra`) — a **Pulumi Automation API program**: ordinary TypeScript
functions that declare `@pulumi/aws` resources, driven entirely from inside
the packaged Electron app by `PulumiService`. There is no separate
infrastructure-as-code file tree on disk to edit or run for this stack — the
program's source *is* this package. Two exceptions provision AWS resources
outside it: the one-time IAM bootstrap CloudFormation template run before the
app ever calls Pulumi (see [setup](/setup)), and the [runs
table](#the-runs-table-invariant--bootstrap-managed-not-pulumi-managed)
below, created via the AWS SDK instead of Pulumi for a correctness reason.

## How it's invoked — no host-installed `pulumi` binary

`PulumiService` (`app/packages/desktop-main/src/services/PulumiService.ts`)
never shells out to a `pulumi` command it hopes is on `PATH`. Instead:

- **The program is inline, not a file on disk.** Every stack operation goes
  through `PulumiWorkspaceService.getOrCreateStack()`, which calls
  `LocalWorkspace.createOrSelectStack({ projectName: 'hyveon', stackName:
  'production', program })` from `@pulumi/pulumi/automation`. For `preview`
  and `apply`, `program` is `createInfraProgram(deploymentConfig, {
  lambdaBundlesDir })` — a function from this package, evaluated in-process.
  `destroy` deliberately passes a no-op program instead, so tearing down a
  stack never requires reading (or being blocked by) a broken configuration
  object.
- **The Pulumi CLI engine itself is still required — the app provisions it,
  not the operator.** The Automation API is a Node wrapper around a real
  `pulumi` binary; `PulumiEngineService` downloads and verifies the exact
  pinned version (`PULUMI_ENGINE_VERSION` in `@hyveon/shared`, currently
  matching this package's own `@pulumi/pulumi` dependency) into an app-owned
  directory under Electron's `userData` — never `~/.pulumi`, and it never
  probes `PATH`. The resolved `PulumiCommand` is passed explicitly into
  `LocalWorkspaceOptions.pulumiCommand`. An operator following the setup
  wizard never installs anything by hand.
- **`@pulumi/pulumi` and `@pulumi/aws` are pinned to exact versions** (no
  caret) in both `app/packages/infra/package.json` and
  `app/packages/desktop-main/package.json`, kept identical on purpose —
  `PulumiService` reads `@pulumi/aws`'s installed version to decide which
  provider plugin to install for a stack.

## State backend — self-managed S3, no DynamoDB lock table

Unlike an S3 backend that pairs a bucket with a companion DynamoDB lock
table, the Pulumi stack uses Pulumi's own **DIY S3 backend** and needs no
separate lock table:

- `LocalWorkspaceOptions.envVars.PULUMI_BACKEND_URL` is set to
  `s3://<stateBucket>?region=<region>` — the same state bucket the first-run
  wizard's bootstrap step creates (versioned, AES-256 encrypted, no public
  access). `secretsProvider: 'passphrase'` — there is no Pulumi Cloud
  account and no access token anywhere in this app; a random passphrase is
  generated once per stack and stored encrypted via `SafeStorageService`.
- **Locking is a lock *object* written into the state bucket itself**, not a
  DynamoDB table — this is how Pulumi's CLI implements its self-managed S3
  backend. A stale lock left by a crashed operation is recoverable through
  `PulumiService.clearStaleLock()` after the app verifies the lock is
  actually orphaned (same process identity, no longer alive).
- This is a distinct concept from the app's own **apply lock**: `RunService`
  additionally guards concurrent plan/apply/destroy submissions with an
  in-memory lock mirrored to a DynamoDB item in the runs table. Don't confuse
  the two — one guards the Pulumi backend itself, the other guards the app's
  own IPC-level submission queue.

## Configuration input

The program takes a single `DeploymentConfig` object (`@hyveon/shared`) as
its only input — there is no separate variables file of any kind.
`DeploymentConfig.gameServers: Record<string, GameServerConfig>` is
the single source of truth for per-game resources; it's persisted as the
JSON object `deployment-config.json` in the operator's S3 configuration
bucket. `PulumiService` fetches that object, `JSON.parse`s it, and passes it
into `createInfraProgram()`. See
[Management app — `DeploymentConfigModule` / `DeploymentConfigService`](/components/management-app#deploymentconfigmodule--deploymentconfigservice)
for how the desktop app reads and writes the same object.

There is no single `for_each`-style loop over this map. `defineAll()`
(`program.ts`) calls each resource-defining function once, in a fixed
dependency order, and **each function loops internally** over
`config.gameServers` to produce its own per-game resources. Adding or
removing a game means adding or removing exactly one map entry — every
per-game resource across every file below still fans out from that one
object.

Each game's `environment` values (container environment variables declared
in the deployment configuration) are echoed verbatim into the stack outputs
Pulumi's engine prints (`program.ts`'s `appliedGameServers`) — `PulumiService`
redacts every sufficiently long (4+ characters) value, drawn from the
current deployment configuration, out of `preview`/`apply`'s streamed
stdout/stderr before it reaches the run-log viewer or the persisted
`pulumi.log`. Shorter values pass through unredacted. See
[Infrastructure — Run plan](/app/iac#run-plan).

## Files

Every source file under `app/packages/infra/src/` and what it declares.
"Fixed" means the resource is always created once; "per-game"/"conditional"
means the count depends on `config.gameServers`.

| File | Purpose | Resources |
|---|---|---|
| `network.ts` | VPC and public networking. | `aws.ec2.Vpc` (1), `InternetGateway` (1), `Subnet` (2, fixed — not config-driven), `RouteTable` (1, with an inline default route), `RouteTableAssociation` (2). |
| `securityGroups.ts` | The security groups guarding game tasks, the file manager, EFS, the EFS-seeder Lambdas, and the health-check Lambda. | `aws.ec2.SecurityGroup` — 3 fixed (game servers, file manager, EFS) + 1 conditional (EFS-seeder, only when at least one game declares `file_seeds`) + 1 conditional (health-check, only when at least one game declares `healthCheck`). Ingress/egress on the three fixed groups are inline arrays, EXCEPT the EFS-seeder and health-check groups' egress: each is one or more conditional standalone `aws.ec2.SecurityGroupRule`s instead (EFS-seeder: one rule, port 2049/tcp to the EFS security group; health-check: one rule per distinct declared health-check port, to the game-servers security group) — neither seeder nor health-check group carries any inline `egress` at all, so the standalone rules can't conflict with an inline one on the same group (see the file's own doc, "`efsSeederSg`'s egress — standalone rule, not inline"). The health-check group's matching ingress (into `gameServers`) is a second in-line entry per declared port on that group's own `ingress` array, the same shape as the EFS-seeder group's ingress into `efs`. |
| `efs.ts` | The shared encrypted EFS filesystem and its access points. | `aws.efs.FileSystem` (1), `MountTarget` (one per public subnet), `AccessPoint` (one per game/volume pair, plus one per HTTPS game for Caddy's certificate storage). |
| `ecs.ts` | The ECS cluster and per-game task definitions. | `aws.ecs.Cluster` (1), `aws.cloudwatch.LogGroup` (one per game, `/ecs/{game}-server`), `aws.ecs.TaskDefinition` (one per game, family `{game}-server`). **No `aws.ecs.Service` is ever declared** — upholding the no-persistent-Service invariant. The per-game log group and task definition both carry a `Game=<game>` tag (see "Cost allocation tags" below); the cluster does not. |
| `iam.ts` | Every IAM role and inline policy, split into `defineIamRoles`/`defineIamPolicies` because policies need a Lambda ARN that doesn't exist until after `lambdas.ts` runs. | `aws.iam.Role` — 6 fixed (task execution, watchdog, followup, interactions, dns-updater, FileBrowser auto-stop scheduler) + 1 per game with `file_seeds` + 1 conditional, **single shared** role (health-check — not per-game, unlike the EFS-seeder role, since one function serves every opted-in game). `RolePolicyAttachment` (1, the managed ECS task-execution policy). `RolePolicy` — 5 fixed + 1 per seeder game + 1 conditional (health-check's own policy). The scheduler role trusts `scheduler.amazonaws.com` and its policy grants only `ecs:StopTask`, scoped to the deployed cluster's tasks — used by `FileManagerService`'s per-launch auto-stop schedule, not by any Lambda. The watchdog's own policy gains a conditional `lambda:InvokeFunction` statement, scoped to the health-check function's ARN, only when that function exists. |
| `lambdas.ts` | The six Lambda functions (one conditional), their log groups, the interactions Function URL, and the two EventBridge rule/target pairs. | `aws.lambda.Function` — 4 fixed + 1 per seeder game (`{projectName}-efs-seeder-{game}`) + 1 conditional, single shared function (`{projectName}-health-check`). `aws.cloudwatch.LogGroup` — 4 fixed + 1 per seeder game + 1 conditional. `aws.lambda.FunctionUrl` (1). `aws.lambda.Permission` (4 — none for health-check, which is invoked only via the IAM identity-policy grant above, never a resource-based permission). `aws.cloudwatch.EventRule` (2: watchdog schedule, ECS task-state-change). `EventTarget` (2). The per-seeder-game function and log group carry a `Game=<game>` tag; the 4 fixed Lambdas and the health-check Lambda (shared across every opted-in game) do not. |
| `dynamodb.ts` | The two DynamoDB tables this program manages. | `aws.dynamodb.Table` — 2 fixed: Discord state (TTL on `expiresAt`), audit log. Both `PAY_PER_REQUEST`. The run-history table is bootstrap-managed, not declared here — see "The runs table invariant" below. |
| `secrets.ts` | The two Discord Secrets Manager secrets plus the FileBrowser helper's shared credential-hash secret, and all three's create-only placeholder versions. | `aws.secretsmanager.Secret` (3, `recoveryWindowInDays: 0`). `SecretVersion` (3, seeded with a placeholder string and `ignoreChanges: ['secretString']` so the app can edit them afterwards without a redeploy overwriting the value). The FileBrowser secret is ONE shared secret across every game (not per-game) — `FileManagerService` overwrites it with a fresh bcrypt hash on every launch, purely as an audit record; the container itself gets the hash directly via command-line flags, never by reading this secret back. |
| `route53.ts` | Hosted-zone lookup **only**. | **Zero Pulumi resources** — one data-source call, `aws.route53.getZoneOutput()`. See the DNS invariant below. |
| `escapes.ts` | The imperative "escape hatches" that don't fit a declarative resource model: seeding a DynamoDB config row and invoking the EFS-seeder Lambdas. | `aws.dynamodb.TableItem` (0–2, conditional on Discord config being set). `aws.lambda.Invocation` — one per game with `file_seeds`, re-triggered only when that game's seed content hash changes. |
| `discordDomain.ts` | The CloudFront-fronted `discord.{hostedZoneName}` custom domain in front of the interactions Lambda's Function URL (Function URLs can't be Route 53 ALIAS targets directly). | `aws.acm.Certificate` (1, `us-east-1`), `aws.route53.Record` (1, the ACM DNS-validation record), `aws.acm.CertificateValidation` (1, `us-east-1`), `aws.cloudfront.Distribution` (1), `aws.route53.Record` (2 more — A and AAAA ALIASes to the distribution). |
| `program.ts` | The package's entry point: constructs both AWS providers, calls every `defineX()` in dependency order, and builds the stack outputs object. | `aws.Provider` (2 — the default region, plus a fixed `us-east-1` alias for the Discord domain's ACM certificate, which CloudFront requires). |
| `index.ts` | Barrel re-export of every `defineX()`, helper, and type. | none |
| `testing/fixtures.ts`, `testing/pulumiMocks.ts` | Test-only: shared game-config fixtures and a `pulumi.runtime.setMocks()` harness. | none |

## Cost allocation tags

Every Pulumi-managed resource carries `Project=hyveon` (applied once via
`defaultTags` on both `aws.Provider`s in `program.ts`). In addition, the
resources whose cost AWS meters independently per game — per-game ECS task
definitions and their CloudWatch log groups (`ecs.ts`), and the per-game
EFS-seeder Lambda and its log group (`lambdas.ts`) — carry a `Game=<game>`
tag, where `<game>` is the game's key in `DeploymentConfig.gameServers`.

Resources shared across every game (the ECS cluster, security groups,
DynamoDB tables, the four fixed project-wide Lambdas, the conditional
health-check Lambda — a single shared function, not one per game — and the
EFS filesystem and its access points) intentionally do **not** carry a
`Game` tag — EFS in
particular bills at the filesystem level, so tagging its per-game access
points would not let Cost Explorer split EFS cost by game (access points
aren't separately billed resources).

Dynamically-launched ECS Fargate tasks (via `RunTask`, never a persistent
`aws.ecs.Service` — see the no-persistent-Service invariant above) inherit
`Game` from their task definition via `propagateTags: 'TASK_DEFINITION'`,
set at both `RunTask` call sites — `AwsCloudProvider.startWorkload` (desktop
app) and the followup Lambda's `runStart` (Discord `/start` command) — this
is what makes the tag reach the resource AWS actually bills Fargate compute
against.

**One-time manual step required — Pulumi cannot do this:** to see costs
broken down by `Game` in AWS Cost Explorer, activate `Game` (and `Project`,
if not already active) as a cost allocation tag: AWS Billing console →
Cost allocation tags → select the tag → Activate. This is not retroactive
by default (only usage after activation is tagged in cost data) and can take
up to 24 hours to appear in Cost Explorer. A management-account user can
retroactively backfill up to the previous 12 months via the AWS Billing
console or the `StartCostAllocationTagBackfill` API — this only recovers
cost data for resources that already carried the tag during that period, and
can be requested at most once every 24 hours.

Once activated, pull a per-game breakdown with:

```bash
aws ce get-cost-and-usage \
  --time-period Start=2026-08-01,End=2026-09-01 \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --group-by Type=TAG,Key=Game
```

## The DNS invariant, precisely

**No per-game DNS record is a Pulumi resource.** `route53.ts` declares zero
resources — only a hosted-zone lookup — and its file doc carries an explicit
invariant comment enforced by a negative test assertion. Per-game hostnames
(`{game}.{hostedZoneName}`) are UPSERTed and DELETEd exclusively by
`@hyveon/lambda-update-dns` in response to ECS task state changes; adding a
per-game `aws.route53.Record` anywhere in this program would fight that
Lambda.

The **only** `aws.route53.Record` resources in the whole program are the
three static, fixed records in `discordDomain.ts` for the Discord bot's own
custom subdomain — unrelated to any game, never touched by any Lambda.

## Health-check network confinement is port-level, not game-level

All game-server tasks share the one `gameServers` security group — there
are no per-game security groups. So the health-check Lambda's egress rules
(one per distinct port declared across every opted-in game's `healthCheck`)
confine it to **ports**, not **games**: a game that declares no health
check is still reachable on that port if some *other*, opted-in game
happens to declare the same one. This is accepted deliberately (see the
`game-health-checks` OpenSpec capability's Risks section) rather than
overclaiming game-level isolation — the request is still addressed to a
specific task's private address resolved from ECS, so reachability alone
never redirects a check at the wrong task. Splitting `gameServers` into
per-game security groups would close this gap but touches every ingress
rule and task definition in the program; not done here.

## The runs table invariant — bootstrap-managed, not Pulumi-managed

**The run-history DynamoDB table is not a Pulumi resource.** `RunRecordService`'s
approve/apply gates need this table to exist on the very FIRST plan/apply
cycle of a fresh install, before any Pulumi apply has ever succeeded — a
resource this program provisions cannot satisfy that, since a stack only
reports outputs (and therefore could only report this table's name) after
its first successful `apply`.

Instead, `BootstrapService.ensureRunsTable` (`@hyveon/desktop-main`) creates
it directly via `@aws-sdk/client-dynamodb` at first-run-wizard bootstrap
time, alongside the state/configuration S3 buckets — before any
`DeploymentConfig` or Pulumi apply exists at all. This is the same pattern
["The DNS invariant, precisely"](#the-dns-invariant-precisely) above
describes for per-game DNS records: a resource whose lifecycle genuinely
can't be gated behind this program's own apply is managed by application
code instead, never by Pulumi.

`@hyveon/shared`'s `resolveRunsTableName(projectName, runsTableNameOverride)`
is the single source of truth for the table's deterministic name, called
from three places that must never disagree: `BootstrapService.ensureRunsTable`
(the AWS SDK create call), `program.ts`'s `buildStackOutputs` (the
`runsTableName` stack output — a plain config echo now, not a resource-derived
`pulumi.Output`, unlike every other table-name output), and
`RunRecordService`/`resolveRunRecordStoreConfig`'s pre-apply fallback (which
reads the persisted `DeploymentConfig` directly via `resolvePreApplyRunsTableName`
when no Pulumi stack output is available yet).

## Dependencies

| Package | Version | Where |
|---|---|---|
| `@pulumi/pulumi` | `3.255.0` | `app/packages/infra`, `app/packages/desktop-main` (exact pin, matches `PULUMI_ENGINE_VERSION`) |
| `@pulumi/aws` | `7.39.0` | `app/packages/infra`, `app/packages/desktop-main` (exact pin, kept identical across both workspaces) |
