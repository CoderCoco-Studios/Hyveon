---
parent: iac
prefix: IAC-PROGRAM
---

# IaC Infrastructure Program

## Context and Design Philosophy

The infrastructure program is the single description of every AWS resource Hyveon owns. It is an inline Pulumi Automation API program in `@hyveon/infra`: `createInfraProgram(config, options)` returns a `PulumiFn` closure whose whole body is `defineAll` followed by `buildStackOutputs` (`app/packages/infra/src/program.ts:556-561`). The closure turns one `DeploymentConfig` into a resource graph and returns the `StackOutputs` the desktop app reads back to find what it built.

It exists so that a game is one map entry. Every per-game resource (task definition, log groups, EFS access points, Caddy certificate storage, efs-seeder function, security-group rules) is produced by iterating `config.gameServers`, the `DeploymentConfig.gameServers` single source of truth named in CLAUDE.md. Nothing in this leaf is per-game hand-written.

What it owns:

- The resource graph and its dependency order (`program.ts:155-357`).
- The `StackOutputs` contract (`app/packages/shared/src/stackOutputs.ts:39-168`) and its compile-time completeness check (`program.ts:390`).
- The environment wire format each Lambda receives, and the Lambda-side parsers for it (`app/packages/shared/src/env.ts:16-64`, `app/packages/shared/src/envJson.ts:22`).
- The shared Lambda bundler that produces the `dist/handler.cjs` artefacts this program zips (`app/packages/lambda/buildLambda.mjs:12-27`, `lambdas.ts:230-243`).

What it deliberately does not own:

- Running the program. `iac/engine` provisions the Pulumi engine, backend and passphrase and calls `createInfraProgram` from `PulumiService`; `iac/run` owns the preview/approve/apply lifecycle and the run record.
- The `DeploymentConfig` type, its persistence as `deployment-config.json` and its read-time normalisers (`deployment-config` leaf). This program trusts what it is given; `ecs.ts:140-145` throws if an `https: true` game arrives without `webPort`, because only the normalising read path fills it.
- What a game is (`game-server` leaf), including the env-token catalogue and `ingressPorts` it calls.
- Lambda handler behaviour. `discord-bot`, `game-runtime/task-and-dns`, `game-runtime/watchdog`, `game-runtime/health-check` and `helper-task` own their handlers; this leaf owns only their roles, env, triggers and network placement.
- The runs table. `BootstrapService.ensureRunsTable` creates it over the SDK before the first apply; `dynamodb.ts:6-28` documents the schema for parity only, and the `runsTableName` output is computed from config, not read off a resource (`program.ts:516`).
- Per-game DNS records, which the update-dns Lambda writes.

CLAUDE.md invariants that live here:

| Invariant | Where the program enforces it |
|---|---|
| No persistent ECS Service | `ecs.ts` declares `aws.ecs.TaskDefinition` only (`ecs.ts:21-25`, `ecs.ts:333-346`) |
| DNS records are Lambda-managed | `route53.ts` declares zero `aws.route53.Record` resources, only `getZoneOutput` (`route53.ts:8-21`, `route53.ts:65`); the Discord custom domain's three static records are the documented exception (`discordDomain.ts:14-20`) |
| TLS terminates in-task via Caddy | Caddy sidecar per HTTPS game (`ecs.ts:301-321`); no ALB or target group anywhere. The Discord ACM certificate (`discordDomain.ts:117-150`) sits outside the invariant's literal wording; see Deferred |
| Lambda env vars use `AWS_REGION_` | Every function's env map (`lambdas.ts:427,458,552,578,646,746`) |
| `Project=hyveon` tag on everything | Provider `defaultTags`, fixed and independent of `projectName` (`program.ts:40`, `program.ts:170-182`) |
| Secrets never reach the stack | Placeholder secret versions with `ignoreChanges: ['secretString']` (`secrets.ts:8-21`, `secrets.ts:89-91`) |

## Composition and Dependency Order

`defineAll` is the composition root. It validates `hostedZoneName` is non-empty after trimming (`program.ts:163-168`), constructs two providers, then calls each resource-area definer and threads earlier outputs into later ones. It is synchronous and returns live resource handles so tests can await them (`program.ts:121-131`). Every definer receives the provider explicitly rather than relying on Pulumi's default provider (`program.ts:138-145`).

| Step | Definer | Consumes | Source |
|---|---|---|---|
| 1 | regional `aws` provider, `aws-us-east-1` provider | `config.awsRegion` | `program.ts:170-182` |
| 2 | `defineNetwork` | `vpcCidr` | `program.ts:184-188` |
| 3 | `defineSecurityGroups` | VPC id, `gameServers` | `program.ts:190-195` |
| 4 | `defineIamRoles` | `gameServers` (static trust policies only) | `program.ts:201-205` |
| 5 | `defineEfs` | subnets, EFS SG | `program.ts:207-213` |
| 6 | `defineEcs` | EFS access points, execution role ARN | `program.ts:215-223` |
| 7 | `defineDynamoDb`, `defineSecrets` | config only | `program.ts:237-246` |
| 8 | `defineRoute53` | trimmed zone name | `program.ts:249-252` |
| 9 | `defineDiscordTableItems` | Discord table | `program.ts:258-266` |
| 10 | `defineLambdas` | roles, subnets, SGs, cluster, EFS, tables, secret ARN, zone id, `lambdaBundlesDir` | `program.ts:272-294` |
| 11 | `defineDiscordDomain` | interactions Function URL, zone id, both providers | `program.ts:300-307` |
| 12 | `defineIamPolicies` | roles plus function ARNs from step 10 | `program.ts:314-326` |
| 13 | `defineEfsSeederInvocations` | seeder functions, seeder policies | `program.ts:332-338` |

Two orderings are load-bearing. IAM is split into roles and policies because the followup Lambda needs its role ARN before it exists, while the interactions policy needs the followup function's ARN after it exists (`iam.ts:8-22`). The consequence is that policies attach strictly after functions, so the efs-seeder invocation carries an explicit `dependsOn` on its policy (`escapes.ts:17-21`, `escapes.ts:102`); without it the seeder could run before it may mount EFS. Within `defineLambdas`, the followup and health-check functions are declared before the functions whose env names them (`lambdas.ts:415-463`, `lambdas.ts:518-580`).

`lambdaBundlesDir` is a machine-local input kept out of `DeploymentConfig` because the config is portable across machines and a filesystem path is not (`program.ts:42-63`). It has no default anywhere in the package because a repo-relative default would resolve inside a checkout but not inside the electron-vite bundle (`lambdas.ts:16-29`). `PulumiService` resolves it.

## Resource Areas and the Per-Game Fan-Out

| Area | Always declared | Per game | Conditional | Source |
|---|---|---|---|---|
| Network | VPC, IGW, two public subnets (`/24` carved from `vpcCidr`, `mapPublicIpOnLaunch`), one route table to `0.0.0.0/0`, two associations; no NAT | none | none | `network.ts:46`, `network.ts:96-163` |
| Security groups | game-servers SG (open egress), file-manager SG (no ingress), EFS SG (NFS 2049 from game-servers and file-manager) | ingress per deduplicated `(port, protocol)` across all games, not per game | internal-visibility ports scoped to the VPC CIDR; 443/80 when any game is HTTPS; efs-seeder SG when any game has `file_seeds`; health-check SG when any game has `healthCheck` | `securityGroups.ts:244-457` |
| IAM | task-execution role with `AmazonECSTaskExecutionRolePolicy`; watchdog, followup, interactions, dns-updater roles and inline policies; FileBrowser scheduler role | efs-seeder role and policy per game with `file_seeds` | single shared health-check role and policy | `iam.ts:322-398`, `iam.ts:423-641` |
| EFS | one encrypted file system `${projectName}-saves`, one mount target per public subnet | one access point per `(game, volume)` at `/{game}/{volume}`, uid/gid 1000 | one `{game}-caddy-data` access point per HTTPS game | `efs.ts:89-164` |
| ECS | cluster with Container Insights disabled | `/ecs/{game}-server` log group, FileBrowser log group, `{game}-server` Fargate task definition | Caddy sidecar, ipv4 boot wrapper, hostname-shim init container | `ecs.ts:163-351` |
| Lambda | interactions (+ Function URL), followup, watchdog (+ rate rule), dns-updater (+ ECS task-state rule) | efs-seeder function per game with `file_seeds` | health-check function | `lambdas.ts:362-783` |
| DynamoDB | `${projectName}-discord` (TTL on `expiresAt`, PITR off), audit table (PITR on) | none | `BASE#discord` and `CONFIG#discord` seed rows | `dynamodb.ts:111-142`, `escapes.ts:115-175` |
| Secrets Manager | bot token, public key, FileBrowser credential; each with a placeholder version, `recoveryWindowInDays: 0` | none | none | `secrets.ts:107-161` |
| Route 53 | hosted-zone lookup only | none | none | `route53.ts:62-69` |
| Discord domain | ACM certificate (us-east-1) and validation record, CloudFront distribution in front of the Function URL, A and AAAA aliases | none | none | `discordDomain.ts:117-216` |

### The task definition

Each `{game}-server` task definition is `awsvpc` / `FARGATE` with `cpu` and `memory` from the game config and only an execution role; no task role is set (`ecs.ts:333-346`). The container list is built conditionally:

- The game container maps `webPort` (HTTPS games) plus every non-ICMP ingress port; ICMP is represented only in the security group because ECS port mappings reject it (`ecs.ts:265-278`).
- `${hyveon.network.public-address}` tokens are substituted with `{game}.{zone}` at build time (`ecs.ts:118-137`). `${hyveon.network.public-ipv4}` tokens are left in place and the container's entry point is replaced with a `/bin/sh` wrapper that discovers the public IPv4 at start, validates it as a dotted quad, re-exports the token-bearing variables and execs the original command (`ecs.ts:280-290`, `envTokenWrapper.ts:47-98`).
- HTTPS games get an `essential` Caddy container running `caddy reverse-proxy --from {game}.{zone} --to localhost:{webPort}`, publishing 443/80 and mounting the `{game}-caddy-data` access point at `/data` (`ecs.ts:301-321`). The image is the floating tag `caddy:2-alpine` (`ecs.ts:305`).
- A `pinnedHostname` adds a non-essential busybox init container (`public.ecr.aws/docker/library/busybox:1.38.0`, `hostnameShim.ts:15`) on a task-ephemeral volume, makes the game container `dependsOn` it with `SUCCESS`, and merges a preload into `NODE_OPTIONS` (`ecs.ts:240-262`, `ecs.ts:295-297`, `ecs.ts:323-331`, `hostnameShim.ts:56-93`).

All containers log to the game's one log group with distinct stream prefixes (`ecs`, `caddy`, `hostname-shim`), which is why the log group is declared beside the task definition (`ecs.ts:11-19`).

### Shared keys

The access-point key `${game}-${volume.name}` is the join between EFS, ECS, Lambda and outputs, and it is re-derived at each site rather than exported once (`efs.ts:120`, `ecs.ts:212-219`, `lambdas.ts:721`, `program.ts:484`). The Caddy access point's logical name `${game}-caddy-data` (`efs.ts:145`) and task volume name (`ecs.ts:227`) share that namespace; the validator reserves the `hostname-shim` volume name (`app/packages/shared/src/gameServerValidator.ts:71-72`) but not `caddy-data`. A first-volume-only convention is also built in: the efs-seeder mounts `volumes[0]` (`lambdas.ts:719-745`), its invocation passes `volumes[0].container_path` (`escapes.ts:249`), and the `efsAccessPoints` output keys each game to its first volume (`program.ts:475-495`). `embed-file-browser` (unmerged) targets the multi-volume case.

### Security-group rule style

Groups declare their rules either fully in-line or fully as standalone `SecurityGroupRule`s, never both, because mixing the two on one group makes the provider fight itself (`securityGroups.ts:19-38`). The game-servers and EFS groups are in-line; the efs-seeder and health-check groups carry no in-line egress and get standalone rules scoped to the EFS SG (NFS) and the game-servers SG (per health-check port) respectively (`securityGroups.ts:405-446`). Health-check ingress on the game-servers SG is sourced from the health-check SG, not the internet (`securityGroups.ts:304-313`).

## Lambda Wiring and Environment Contract

Every function uses `runtime: nodejs24.x` and handler `handler.handler` from one constant each (`lambdas.ts:58-61`), with code as a single-entry archive holding `handler.cjs` (`lambdas.ts:241-243`). The `nodejs24.x` choice and the single constant are recorded in the `bump-lambda-runtime-to-nodejs24` design. Map-valued env vars are JSON, and every game-iterating builder sorts keys so the baked value is deterministic (`lambdas.ts:252-345`).

| Function | Trigger | Network | Env keys | Source |
|---|---|---|---|---|
| followup | invoked by interactions (`iam.ts:511`) | none | `AWS_REGION_`, `TABLE_NAME`, `ECS_CLUSTER`, `SUBNET_IDS`, `SECURITY_GROUP_ID`, `DOMAIN_NAME`, `GAME_NAMES`, `CONNECT_MESSAGES`, `GAME_PORTS` | `lambdas.ts:415-444` |
| interactions | Function URL, `authorizationType: NONE`, CORS `https://discord.com` POST; both `InvokeFunctionUrl` and `InvokeFunction` public grants | none | `AWS_REGION_`, `TABLE_NAME`, `DISCORD_PUBLIC_KEY_SECRET_ARN`, `FOLLOWUP_LAMBDA_NAME`, `GAME_NAMES`, `HOSTED_ZONE_NAME` | `lambdas.ts:446-516` |
| health-check | invoked by watchdog via an identity-policy grant, no resource permission | public subnets, health-check SG | `AWS_REGION_` only | `lambdas.ts:518-557`, `iam.ts:455-457` |
| watchdog | EventBridge `rate(N minutes)` from `watchdogIntervalMinutes` | none | `ECS_CLUSTER`, `GAME_NAMES`, `IDLE_CHECKS`, `MIN_PACKETS`, `CHECK_WINDOW_MINUTES`, `AWS_REGION_`, `HEALTH_CHECKS`, `HEALTH_CHECK_FUNCTION_NAME` | `lambdas.ts:560-624` |
| dns-updater | EventBridge `ECS Task State Change` on this cluster, `lastStatus` `RUNNING` or `STOPPED` | none | `HOSTED_ZONE_ID`, `DOMAIN_NAME`, `GAME_NAMES`, `DNS_TTL`, `AWS_REGION_`, `TABLE_NAME`, `CONNECT_MESSAGES`, `GAME_PORTS` | `lambdas.ts:626-703` |
| efs-seeder (per game) | `aws.lambda.Invocation` during apply, re-run when `seedsHash` of `file_seeds` changes | public subnets, efs-seeder SG, access point at `/mnt/efs` | `AWS_REGION_` | `lambdas.ts:705-760`, `escapes.ts:229-262` |

`GAME_PORTS` maps each game to its first public non-ICMP container port, or the `HTTPS_CONNECT_PORT` marker for HTTPS games, and omits games with no connectable port (`lambdas.ts:307-323`). `HEALTH_CHECKS` carries each game's full `healthCheck` declaration (`lambdas.ts:334-345`). `defineLambdas` validates up front that the conditional SG ids are present whenever their roles exist, before any resource is constructed, so a misuse never leaves half-registered mock resources (`lambdas.ts:392-410`).

The health-check row is the leaf's most serious divergence from intent. Its handler calls `requireEnv('ECS_CLUSTER')` at module load (`app/packages/lambda/health-check/src/handler.ts:39`), which throws (`env.ts:16`), but the function receives only `AWS_REGION_` (`lambdas.ts:552`) and `lambdas.test.ts:792` pins that. Its SG's only egress is to the game-servers SG on the health-check ports (`securityGroups.ts:430-446`), and it sits in a public subnet where a Lambda gets no public IP, so a path to the ECS and Secrets Manager APIs appears absent `[inferred]`.

Log groups go through `lambdaLogGroup` with 7-day retention (`logGroups.ts:12`, `logGroups.ts:27-43`). Only health-check and efs-seeder depend on their log group (`lambdas.ts:555`, `lambdas.ts:754`); the other four do not.

## Stack Outputs and Create-Only State

`buildStackOutputs` returns `StackOutputValues`, the same field set as `StackOutputs`, with resource-derived fields left as `pulumi.Output` so the Automation API resolves them and keeps dependency edges (`program.ts:359-389`). `extends Record<keyof StackOutputs, unknown>` fails the build if a `StackOutputs` field has no entry here, in one direction only (`program.ts:382-390`).

| Output | Derived from | Note |
|---|---|---|
| `awsRegion`, `gameNames`, `appliedGameServers` | config echo | `gameNames` sorted (`program.ts:513`); `appliedGameServers` is not `pulumi.secret`, so consumers redact (`program.ts:11-15`) |
| `domainName` | `config.hostedZoneName` | untrimmed, unlike the zone lookup (`program.ts:163`, `program.ts:512`) |
| `ecsClusterName`, `ecsClusterArn`, `subnetIds`, `securityGroupId`, `fileManagerSecurityGroupId`, `efsFileSystemId` | resources | `program.ts:504-509` |
| `efsAccessPoints` | first volume's access point per game | throws if a game has no volumes or an access point is missing (`program.ts:478-494`); value is `volumes[0]`'s id (`:493`) |
| `efsVolumeAccessPoints` | game name to volume name to access point id, every volume of every game | same loop and same throws (`program.ts:477-494,511`); consumed by the helper task's mount layout |
| `discordTableName`, `auditTableName` | resolved table names | `program.ts:514-515` |
| `runsTableName` | `resolveRunsTableName(projectName, runsTableName)` | not a resource (`program.ts:516`) |
| secret ARNs, `fileBrowserSchedulerRoleArn` | resources | `program.ts:517-520` |
| `interactionsInvokeUrl`, `discordInteractionsUrl` | `https://discord.{zone}/` from the alias record name | identical by design, never the raw Function URL (`program.ts:441-455`, `program.ts:500`) |

Three resource kinds are written once and then excluded from reconciliation so the app's own SDK writes survive a re-deploy: the three secret versions (`ignoreChanges: ['secretString']`, `secrets.ts:89-91`), and the `CONFIG#discord` seed row (`ignoreChanges: ['item']`, `escapes.ts:92-94`, `escapes.ts:170`). The `BASE#discord` row is the opposite: recomputed from `baseAllowedGuilds`, `baseAdminUserIds` and `baseAdminRoleIds` on every apply as an immutable floor (`escapes.ts:10-15`). It is declared only when any of the three lists is non-empty, and `CONFIG#discord` only when `discordApplicationId` is non-empty (`escapes.ts:119-150`). Slash-command registration has no Pulumi analogue because it would need the bot token as an input (`escapes.ts:23-27`).

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| IaC tool | Pulumi with `@pulumi/aws` in TypeScript | CDK for Terraform, AWS CDK, auto-downloaded OpenTofu with HCL | CDKTF archived; AWS CDK closes multi-cloud; Pulumi is multi-cloud, native TypeScript and exposes a programmatic engine (`openspec/changes/archive/2026-08-10-migrate-iac-to-pulumi/design.md:56-77`) |
| Program form | Inline `PulumiFn` closure | `workDir` project on disk | A `workDir` needs a writable `Pulumi.yaml` and `node_modules`, hostile to asar, and would be editable infra source in `userData` (`migrate-iac-to-pulumi/design.md:107-134`) |
| Secret material | Placeholder versions with `ignoreChanges`; app writes real values over the SDK | Accept Discord secrets as program inputs | Removes the one route by which a real token could reach state (`migrate-iac-to-pulumi/design.md:191-215`, `secrets.ts:8-21`) |
| HTTPS | Caddy sidecar, `essential`, certs on a dedicated EFS access point | ALB + ACM, nginx + certbot, Traefik, DNS-01 | Cost model and zero-config issuance; essential avoids an unreachable billing task; persistence avoids Let's Encrypt duplicate-cert limits (`openspec/changes/archive/2026-07-28-replace-alb-with-caddy-sidecar/design.md:37-70`) |
| Lambda runtime | `nodejs24.x` through one `LAMBDA_RUNTIME` constant | `nodejs22.x`; per-function literals | Longer support window, matches dev/CI Node; one constant prevents drift (`openspec/changes/archive/2026-08-10-bump-lambda-runtime-to-nodejs24/design.md:18-24`) |
| IAM layout | Roles and policies split into two definers | One `defineIam` | No single call satisfies both directions of the followup/interactions ARN dependency (`iam.ts:8-22`) |
| Provider wiring | Explicit `provider` into every definer; fixed `Project: hyveon` default tags; separate us-east-1 provider only for ACM | Ambient default provider; tag from `projectName` | Region and tags traceable per resource; CloudFront requires us-east-1 certificates (`program.ts:34-40`, `program.ts:133-145`, `discordDomain.ts:22-29`) |
| Discord ingress URL | CloudFront + ACM + Route 53 aliases on `discord.{zone}` | Raw Function URL | Function URLs cannot be Route 53 alias targets (`discordDomain.ts:4-11`); why a stable custom domain is wanted at all is `[inferred]` to be a URL that survives function replacement |
| Runs table | Created by bootstrap over the SDK, name computed from config | Pulumi-managed table | The apply gate needs the table before the first apply has ever succeeded (`dynamodb.ts:6-19`) |
| Lambda bundle location | Required `lambdaBundlesDir` option, no default | `import.meta.url`-relative default | A relative default breaks only inside the packaged app, which unit tests do not exercise (`lambdas.ts:16-29`) |
| Network | Two fixed public subnets, public IPs, no NAT | Private subnets with NAT; configurable subnet count | `[inferred]` NAT carries a fixed hourly cost that contradicts scale-to-zero; the count is fixed because raising it replaces subnets and mount targets (`network.ts:38-46`) |
| Health checks and seeding footprint | Conditional resources gated on the IAM role existing | Always-on functions | Zero footprint when unused, and branching on the role keeps function and policy from drifting from the role (`iam.ts:51-58`, `lambdas.ts:518-528`) |
| Per-game seeder execution | Synchronous `aws.lambda.Invocation` keyed on a hash of `file_seeds` | Seeding from the app after apply | `[inferred]` keeps seeding inside the apply so a deploy leaves volumes populated; rerun semantics documented at `escapes.ts:17-21` |
| Env wire format | JSON maps and CSV in Lambda env, parsed by `@hyveon/shared/env` | DynamoDB or SSM lookups at invoke | `[inferred]` no extra read on the start/stop critical path and nothing to keep in sync outside the stack |
| Container Insights | Disabled on the cluster | Enabled | `[inferred]` per-metric cost; the watchdog reads network metrics itself (`ecs.ts:172-178`) |

## Open Questions & Future Decisions

### Resolved

1. ✅ Pulumi over CDK/CDKTF/OpenTofu, inline program, and secrets kept out of state (`migrate-iac-to-pulumi/design.md`).
2. ✅ Caddy sidecar with HTTP-01/TLS-ALPN-01, `essential`, certs persisted on EFS (`replace-alb-with-caddy-sidecar/design.md` D1-D4).
3. ✅ `nodejs24.x` through one constant (`bump-lambda-runtime-to-nodejs24/design.md`).

### Deferred

1. Should the health-check Lambda receive `ECS_CLUSTER`, and how should it reach the ECS and Secrets Manager APIs (VPC endpoints, egress to the internet through a different placement, or no VPC)? Today it fails at init (`lambdas.ts:552`, `health-check/src/handler.ts:39`) and its egress is only to the game SG (`securityGroups.ts:430-446`); `lambdas.test.ts:792` locks the env in.
2. Is first-volume-only seeding a hard limit or a gap? The stack outputs now carry every volume (`efsVolumeAccessPoints`, `program.ts:477-494,511`), but the seeder mount (`lambdas.ts:719-745`) and its invocation input (`escapes.ts:249`) still use `volumes[0]`, and `efsAccessPoints` keeps the first-volume shape (`program.ts:493`). Can `efsAccessPoints` be retired once no consumer reads it?
3. Should the Caddy image be pinned to an exact version, as `in-task-tls-termination` requires and `hostnameShim.ts:15` does for busybox? (`ecs.ts:305`)
4. Should `lambda-runtime-currency` be corrected to list efs-seeder as conditional (`lambdas.ts:398`, `iam.ts:222-226`) and to locate the esbuild `target` in `buildLambda.mjs:20`?
5. Does the "no ACM certificate" invariant need an explicit Discord-domain carve-out in CLAUDE.md and `in-task-tls-termination`? (`discordDomain.ts:117-150`)
6. Should the secret-preservation scenario in `pulumi-infra-program` get a real write-redeploy-read test, or be relaxed to the option-shape assertion in `secrets.test.ts:125-152`?
7. Should `hostedZoneName` be normalised once (trim plus `stripTrailingDots`) and used for the zone lookup and the `domainName` output alike? Today `program.ts:163`, `program.ts:512`, `route53.ts:65` and `hostedZoneName.ts:19-25` apply three different normalisations.
8. Should the interactions, followup, watchdog and dns-updater functions `dependsOn` their log groups, as health-check and efs-seeder do? (`lambdas.ts:443,471,588,657`) An early invocation could let Lambda create the group without retention `[inferred]`.
9. Should the efs-seeder `triggers` hash include `container_path`, which `input` carries but `seedsHash` ignores? (`escapes.ts:213-214`, `escapes.ts:256-257`) Whether an `input`-only change re-invokes is `[unverified]`.
10. Should `HOSTED_ZONE_NAME` be dropped from interactions (`lambdas.ts:463`), and CloudFront's allowed methods narrowed to match the POST-only Function URL CORS? (`discordDomain.ts:178`, `lambdas.ts:480`)
11. Should the access-point key derivation move behind one helper, and should `caddy-data` become a reserved volume name for HTTPS games? A game `a-b` with volume `c` collides with game `a` volume `b-c` (`efs.ts:120`, `program.ts:484`), and a volume named `caddy-data` on an HTTPS game would share a logical name with the Caddy access point (`efs.ts:120,145`) `[inferred]`.
12. Should `src/testing/` be excluded from the `@hyveon/infra` build output, which currently compiles `testing/fixtures.ts` and `testing/pulumiMocks.ts` because `tsconfig.json` excludes only `*.test.ts`?
13. Should `buildLambda.mjs` anchor its paths to the package rather than the cwd (`buildLambda.mjs:13,16-17`), and stop emitting a sourcemap that is never zipped (`buildLambda.mjs:23`, `lambdas.ts:242`)?
14. Stale doc comments: "five Lambda functions" and "five inline IAM policies" (`program.ts:106,109`), "one EFS-seeder function per configured game" (`lambdas.ts:3-5`), "the two Discord secrets" (`secrets.ts:95`), and pointers to an "HCL→Pulumi address table" that does not exist (`lambdas.ts:63`, `escapes.ts:35`, `iam.ts:29`). Sweep them along with the remaining HCL/legacy-tool references in `infra/src`.
15. Sweep disagreement: code comments here say five Lambdas while CLAUDE.md and the packages say six. Primary owner is `operator-app/infra-logs`; this leaf only needs its own comments fixed.
16. Should game-server task definitions carry a task role? None is set (`ecs.ts:333-346`), so containers have no AWS credentials of their own; whether any game or the Caddy sidecar ever needs one is unexplained.
17. Should the Discord table enable point-in-time recovery like the audit table? (`dynamodb.ts:123` versus `dynamodb.ts:142`) The rationale for the difference is not recorded.
18. The `pulumi-infra-program` passphrase wording ("machine-bound") contradicts `pulumi-engine-runtime`; the fix is a spec edit owned by `iac/engine`, recorded here because the requirement lives in this leaf's capability.

## References

- Arrow doc: `docs/arrows/iac/program.md`
- EARS specs: `docs/intent/iac/program/program-specs.md`, prefix `IAC-PROGRAM`
- OpenSpec: `openspec/specs/pulumi-infra-program/spec.md` (program half), `openspec/specs/lambda-runtime-currency/spec.md`, `openspec/specs/in-task-tls-termination/spec.md` (infra half)
- OpenSpec design history: `openspec/changes/archive/2026-08-10-migrate-iac-to-pulumi/design.md`, `openspec/changes/archive/2026-07-28-replace-alb-with-caddy-sidecar/design.md`, `openspec/changes/archive/2026-08-10-bump-lambda-runtime-to-nodejs24/design.md`
- Active changes touching this leaf: `add-icmp-ingress`, `https-explicit-web-port`, `add-pinned-hostname`, `add-pluggable-health-checks`, `add-scripted-health-checks`, `add-vpc-flow-logs` (see the arrow doc for state); `embed-file-browser` is archived (`openspec/changes/archive/2026-10-30-embed-file-browser/`)
- Project docs: `docs/docs/components/infra.md`, `docs/docs/components/lambdas.md`, `docs/docs/architecture.md`
- Neighbouring leaf designs: `docs/intent/iac/engine/engine-design.md`, `docs/intent/iac/run/run-design.md`, `docs/intent/deployment-config/deployment-config-design.md`, `docs/intent/game-server/game-server-design.md`, `docs/intent/helper-task/helper-task-design.md`, `docs/intent/discord-bot/discord-bot-design.md`, `docs/intent/game-runtime/health-check/health-check-design.md`
