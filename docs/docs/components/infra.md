---
title: Infra program
sidebar_position: 2
---

# Infra program

All AWS infrastructure is provisioned by `app/packages/infra` (`@hyveon/infra`) —
a **Pulumi Automation API program**, not a CLI-driven `.tf` tree. There is no
`.tf` file anywhere in this repository; the old `terraform/` tree was deleted
by the `migrate-iac-to-pulumi` change. Provisioning logic lives in ordinary
TypeScript functions that declare `@pulumi/aws` resources, driven entirely
from inside the packaged Electron app by `PulumiService`.

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

Unlike the old Terraform S3 backend (which paired an S3 bucket with a
DynamoDB lock table), the Pulumi stack uses Pulumi's own **DIY S3 backend**
and needs no separate lock table:

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
its only input — there is no `terraform.tfvars` and no `.tfvars` file of any
kind. `DeploymentConfig.gameServers: Record<string, GameServerConfig>` is
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
| `securityGroups.ts` | The security groups guarding game tasks, the file manager, EFS, and the EFS-seeder Lambdas. | `aws.ec2.SecurityGroup` — 3 fixed (game servers, file manager, EFS) + 1 conditional (EFS-seeder, only when at least one game declares `file_seeds`). Ingress/egress on all four groups are inline arrays, EXCEPT the EFS-seeder group's egress: one conditional standalone `aws.ec2.SecurityGroupRule` (egress, port 2049/tcp only, scoped to the EFS security group) — the seeder group carries no inline `egress` at all, so the standalone rule can't conflict with an inline one on the same group (see the file's own doc, "`efsSeederSg`'s egress — standalone rule, not inline"). |
| `efs.ts` | The shared encrypted EFS filesystem and its access points. | `aws.efs.FileSystem` (1), `MountTarget` (one per public subnet), `AccessPoint` (one per game/volume pair, plus one per HTTPS game for Caddy's certificate storage). |
| `ecs.ts` | The ECS cluster and per-game task definitions. | `aws.ecs.Cluster` (1), `aws.cloudwatch.LogGroup` (one per game, `/ecs/{game}-server`), `aws.ecs.TaskDefinition` (one per game, family `{game}-server`). **No `aws.ecs.Service` is ever declared** — upholding the no-persistent-Service invariant. |
| `iam.ts` | Every IAM role and inline policy, split into `defineIamRoles`/`defineIamPolicies` because policies need a Lambda ARN that doesn't exist until after `lambdas.ts` runs. | `aws.iam.Role` — 6 fixed (task execution, watchdog, followup, interactions, dns-updater, FileBrowser auto-stop scheduler) + 1 per game with `file_seeds`. `RolePolicyAttachment` (1, the managed ECS task-execution policy). `RolePolicy` — 5 fixed + 1 per seeder game. The scheduler role trusts `scheduler.amazonaws.com` and its policy grants only `ecs:StopTask`, scoped to the deployed cluster's tasks — used by `FileManagerService`'s per-launch auto-stop schedule, not by any Lambda. |
| `lambdas.ts` | The five Lambda functions, their log groups, the interactions Function URL, and the two EventBridge rule/target pairs. | `aws.lambda.Function` — 4 fixed + 1 per seeder game (`{projectName}-efs-seeder-{game}`). `aws.cloudwatch.LogGroup` — 4 fixed + 1 per seeder game. `aws.lambda.FunctionUrl` (1). `aws.lambda.Permission` (4). `aws.cloudwatch.EventRule` (2: watchdog schedule, ECS task-state-change). `EventTarget` (2). |
| `dynamodb.ts` | The two DynamoDB tables this program manages. | `aws.dynamodb.Table` — 2 fixed: Discord state (TTL on `expiresAt`), audit log. Both `PAY_PER_REQUEST`. The run-history table is bootstrap-managed, not declared here — see "The runs table invariant" below. |
| `secrets.ts` | The two Discord Secrets Manager secrets plus the FileBrowser helper's shared credential-hash secret, and all three's create-only placeholder versions. | `aws.secretsmanager.Secret` (3, `recoveryWindowInDays: 0`). `SecretVersion` (3, seeded with a placeholder string and `ignoreChanges: ['secretString']` so the app can edit them afterwards without a redeploy overwriting the value). The FileBrowser secret is ONE shared secret across every game (not per-game) — `FileManagerService` overwrites it with a fresh bcrypt hash on every launch, purely as an audit record; the container itself gets the hash directly via command-line flags, never by reading this secret back. |
| `route53.ts` | Hosted-zone lookup **only**. | **Zero Pulumi resources** — one data-source call, `aws.route53.getZoneOutput()`. See the DNS invariant below. |
| `escapes.ts` | The imperative "escape hatches" that don't fit a declarative resource model: seeding a DynamoDB config row and invoking the EFS-seeder Lambdas. | `aws.dynamodb.TableItem` (0–2, conditional on Discord config being set). `aws.lambda.Invocation` — one per game with `file_seeds`, re-triggered only when that game's seed content hash changes. |
| `discordDomain.ts` | The CloudFront-fronted `discord.{hostedZoneName}` custom domain in front of the interactions Lambda's Function URL (Function URLs can't be Route 53 ALIAS targets directly). | `aws.acm.Certificate` (1, `us-east-1`), `aws.route53.Record` (1, the ACM DNS-validation record), `aws.acm.CertificateValidation` (1, `us-east-1`), `aws.cloudfront.Distribution` (1), `aws.route53.Record` (2 more — A and AAAA ALIASes to the distribution). |
| `program.ts` | The package's entry point: constructs both AWS providers, calls every `defineX()` in dependency order, and builds the stack outputs object. | `aws.Provider` (2 — the default region, plus a fixed `us-east-1` alias for the Discord domain's ACM certificate, which CloudFront requires). |
| `index.ts` | Barrel re-export of every `defineX()`, helper, and type. | none |
| `testing/fixtures.ts`, `testing/pulumiMocks.ts` | Test-only: shared game-config fixtures and a `pulumi.runtime.setMocks()` harness. | none |

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
custom subdomain — unrelated to any game, never touched by any Lambda. This
mirrors the old Terraform stack's one exception to the same rule, so it is
not a migration regression.

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

## Migrating from the old Terraform stack

If you previously deployed the Terraform-based version of this stack,
see the [maintainer guide's legacy-teardown note](/guides/maintainer#legacy-terraform-teardown-one-off)
before running the first apply from the app's [Infrastructure page](/app/iac) —
the new program reuses the same physical resource names, and deploying both
stacks against the same AWS account risks duplicate or conflicting
infrastructure.

## Dependencies

| Package | Version | Where |
|---|---|---|
| `@pulumi/pulumi` | `3.255.0` | `app/packages/infra`, `app/packages/desktop-main` (exact pin, matches `PULUMI_ENGINE_VERSION`) |
| `@pulumi/aws` | `7.39.0` | `app/packages/infra`, `app/packages/desktop-main` (exact pin, kept identical across both workspaces) |
