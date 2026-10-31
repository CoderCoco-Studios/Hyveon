# Sweep 8 — `app/packages/infra/` (Pulumi program) + `app/packages/lambda/` (six Lambda packages)

Scope enumerated with `git ls-files app/packages/infra app/packages/lambda` — 70 tracked files, ~12.9k lines. Every source file was read in full. Test files were read and are summarized by the behaviours they pin down.

## app/packages/infra

```yaml
- path: app/packages/infra/package.json
  purpose: Workspace manifest for @hyveon/infra.
  exports: "main/types ./dist/index.js; exports '.' only"
  dependencies: "@hyveon/shared (*), @pulumi/aws 7.39.0 (exact pin), @pulumi/pulumi 3.255.0 (exact pin)"
  data_shapes: none
  side_effects: none
  role: config
  observations: "ESM (type: module). Build is plain tsc; no test script here (tests run from root vitest)."

- path: app/packages/infra/tsconfig.json
  purpose: TS project config; emits dist/, excludes *.test.ts, references ../shared.
  exports: none
  dependencies: ../../tsconfig.base.json, ../shared/tsconfig.json
  data_shapes: none
  side_effects: none
  role: config
  observations: "testing/ helpers (fixtures.ts, pulumiMocks.ts) are NOT excluded, so they compile into dist/ (tsconfig.json:8 only excludes *.test.ts)."
```

## app/packages/infra/src

```yaml
- path: app/packages/infra/src/index.ts
  purpose: Package entry point (@packageDocumentation); barrel re-export of every defineX module.
  exports: "createInfraProgram, buildStackOutputs, defineNetwork, cidrSubnet, defineSecurityGroups, dedupedDirectGamePorts, hasHttpsGame, defineIamRoles, defineIamPolicies, gamesWithFileSeeds, defineEfs, defineEcs, defineLambdas, bundlePath, defineDynamoDb, defineSecrets, secretResourceOptions, defineRoute53, defineDiscordTableItems, defineEfsSeederInvocations, escapeResourceOptions, defineDiscordDomain + matching *Resources/*Args types"
  dependencies: all sibling modules
  data_shapes: n/a
  side_effects: none
  role: barrel / package entry
  observations: "defineAll, dedupedInternalGamePorts, gamesWithHealthChecks, envTokenWrapper, hostnameShim, logGroups, hostedZoneName are NOT re-exported (index.ts:10-33) — internal only."

- path: app/packages/infra/src/program.ts
  purpose: The Pulumi inline-program factory; wires every defineX in dependency order and builds stack outputs.
  exports: "InfraProgramOptions {lambdaBundlesDir}, InfraResources, defineAll(config, options), StackOutputValues, buildStackOutputs(resources, config), createInfraProgram(config, options): PulumiFn"
  dependencies: "@pulumi/aws, @pulumi/pulumi, PulumiFn type from @pulumi/pulumi/automation; @hyveon/shared resolveRunsTableName, DeploymentConfig, GameServerConfig, StackOutputs; every ./defineX module"
  data_shapes: "Consumes DeploymentConfig (projectName, awsRegion, vpcCidr, hostedZoneName, dnsTtl, watchdog*, base*Ids, discordApplicationId, auditTableName, runsTableName, gameServers). Produces StackOutputValues (awsRegion, ecsClusterName/Arn, subnetIds, securityGroupId, fileManagerSecurityGroupId, efsFileSystemId, efsAccessPoints (first-volume AP per game), domainName, gameNames (sorted), discordTableName, auditTableName, runsTableName, discordBotTokenSecretArn, discordPublicKeySecretArn, fileBrowserCredentialSecretArn, fileBrowserSchedulerRoleArn, interactionsInvokeUrl, discordInteractionsUrl, appliedGameServers)."
  side_effects: "Declares AWS resources via Pulumi when the closure runs (two aws.Provider instances: regional + us-east-1)."
  role: Pulumi program composition root
  observations: |
    - Fails fast on blank hostedZoneName after trim (program.ts:163-168).
    - DEFAULT_TAGS fixed {Project: 'hyveon'}, deliberately not derived from projectName (program.ts:40).
    - Call order is load-bearing: roles → efs → ecs → dynamo/secrets → route53 → discordTableItems → lambdas → discordDomain → iamPolicies → efsSeederInvocations (program.ts:184-338).
    - buildStackOutputs.domainName echoes the UNTRIMMED config.hostedZoneName (program.ts:501) while defineAll uses the trimmed value (program.ts:163) — whitespace/trailing dots can leak into the output.
    - interactionsInvokeUrl and discordInteractionsUrl intentionally identical (program.ts:490, 510-511), derived from discordDomain.aliasRecord.name, never the raw Function URL.
    - appliedGameServers is a plain (non-secret) config echo; file doc says downstream must redact (program.ts:11-15).
    - Doc drift: InfraResources docs say "The five Lambda functions" (program.ts:106) and "The five inline IAM policies" (program.ts:109); there are six function kinds and seven policy kinds.
    - buildStackOutputs throws on a game with zero volumes (program.ts:473-475).
    - References "legacy tool"/HCL equivalents throughout (program.ts:377-380, 458).

- path: app/packages/infra/src/network.ts
  purpose: VPC, IGW, two public subnets, public route table, associations.
  exports: "NetworkResources, DefineNetworkArgs, cidrSubnet(baseCidr,newBits,netNum), defineNetwork(args)"
  dependencies: "@pulumi/aws (ec2.Vpc, InternetGateway, Subnet, RouteTable, RouteTableAssociation, getAvailabilityZonesOutput)"
  data_shapes: "vpcCidr string → subnets cidrSubnet(vpcCidr, 8, i)"
  side_effects: "AWS resources; getAvailabilityZones data-source call."
  role: Pulumi resource definer
  observations: |
    - PUBLIC_SUBNET_COUNT hardcoded 2; changing it replaces subnets + EFS mount targets (network.ts:43-46).
    - No private subnets / NAT gateway / VPC endpoints anywhere — every VPC-attached Lambda (efs-seeder, health-check) sits in public subnets without a public IP (network.ts:122-138; see health-check observations).
    - Hand-rolled cidrSubnet with no input validation beyond prefix overflow (network.ts:67-85).

- path: app/packages/infra/src/securityGroups.ts
  purpose: game_servers, file_manager, efs, conditional efs_seeder and health-check SGs plus standalone egress rules.
  exports: "SecurityGroupResources, DefineSecurityGroupsArgs, GamePort, dedupedDirectGamePorts, dedupedInternalGamePorts, hasHttpsGame, defineSecurityGroups"
  dependencies: "@pulumi/aws (ec2.SecurityGroup, SecurityGroupRule, getVpcOutput); @hyveon/shared ingressPorts, isIcmpProtocol; ./iam gamesWithFileSeeds, gamesWithHealthChecks"
  data_shapes: "GamePort {port, protocol}; ingress entries derived from GameServerConfig.ports (via ingressPorts) with visibility 'public'|'internal'|undefined"
  side_effects: "AWS SGs/rules; optional getVpc data lookup only when an internal port exists (securityGroups.ts:259-264)."
  role: Pulumi resource definer
  observations: |
    - Visibility classification is an allowlist — unknown visibility values fail CLOSED (in neither public nor internal) (securityGroups.ts:130-143, 162-164).
    - ICMP ingress maps toPort -1 (securityGroups.ts:221-224).
    - 443/80 Caddy ingress only when any game has https: true (securityGroups.ts:269-279).
    - Health-check SG: no inline egress; one standalone egress rule per distinct healthCheck.port to gameServersSg only (securityGroups.ts:289-302, 430-446). Health-check ingress on gameServersSg is tcp-only (securityGroups.ts:305-314). Consequence: the health-check Lambda has NO egress to AWS APIs (ECS, Secrets Manager) — see lambda/health-check observations.
    - efs_seeder SG namePrefix carries "-v2-" to force replacement and revoke a legacy open egress rule; "Keep -v2-" warning (securityGroups.ts:33-38, 362-363).
    - file_manager SG has explicit empty ingress to revoke legacy 0.0.0.0/0:8080; ingress is added at runtime by the desktop app for operator IP (securityGroups.ts:340-343).
    - Non-null assertion config.healthCheck!.port (securityGroups.ts:287).
    - Inline-vs-standalone rule mixing rule documented (securityGroups.ts:19-31).
    - Function doc for defineSecurityGroups lists only four groups (securityGroups.ts:227-229), omits health-check SG.

- path: app/packages/infra/src/iam.ts
  purpose: IAM roles (defineIamRoles) and inline policies (defineIamPolicies), split for call-order reasons.
  exports: "IamRoleResources, IamPolicyResources, IamResources, DefineIamRolesArgs, DefineIamPoliciesArgs, gamesWithFileSeeds, gamesWithHealthChecks, defineIamRoles, defineIamPolicies"
  dependencies: "@pulumi/aws (iam.Role, RolePolicy, RolePolicyAttachment), @pulumi/pulumi (jsonStringify, interpolate); GameServerConfig"
  data_shapes: "IAM policy JSON documents; role set keyed by Lambda + per-game seeder roles."
  side_effects: AWS IAM resources
  role: Pulumi resource definer
  observations: |
    - Roles: task-execution (+ AmazonECSTaskExecutionRolePolicy), watchdog, followup, interactions, dns-updater, per-game efs-seeder, filebrowser-scheduler (scheduler.amazonaws.com trust), conditional health-check (iam.ts:327-395).
    - No ECS *task* role is declared — only an execution role; game containers get no task-role credentials.
    - Watchdog: ecs List/Describe/Stop/TagResource/ListTagsForResource on '*', ec2:DescribeNetworkInterfaces, cloudwatch:GetMetricStatistics, plus conditional lambda:InvokeFunction on the health-check ARN (iam.ts:445-457).
    - Followup: ecs RunTask/StopTask/ListTasks/DescribeTasks '*', ecs:TagResource conditioned on ecs:CreateAction=RunTask, iam:PassRole on the task-execution role, dynamodb Get/Put on discord table (iam.ts:480-494).
    - Interactions: dynamodb:GetItem, secretsmanager:GetSecretValue on public-key secret, lambda:InvokeFunction on followup (iam.ts:505-513).
    - DNS updater: route53 Change/List/GetChange scoped to hostedzone/<id> + change/*, dynamodb Get/Delete (iam.ts:524-537).
    - FileBrowser scheduler: ecs:StopTask scoped to arn:aws:ecs:*:*:task/<cluster>/* (iam.ts:577-593).
    - Health-check: logs, VPC ENI, ecs:DescribeTasks scoped to cluster tasks, optional secretsmanager:GetSecretValue on exactly the declared auth.secretArns (iam.ts:602-630).
    - Policies iterate roles.* rather than recomputing sets ("never drift") (iam.ts:543-549, 595-606).
    - Doc drift: "see this file's doc for the full resource table" (iam.ts:29, 65) — no table in the file doc. logStatement doc says "each of the five inline policies" (iam.ts:282-283); there are up to seven kinds.
    - dynamodbDiscordTableArn doc lists consumers (iam.ts:146-152); accurate.

- path: app/packages/infra/src/efs.ts
  purpose: Shared EFS filesystem, mount targets per public subnet, per-(game,volume) access points, per-https-game caddy-data access points.
  exports: "EfsResources, DefineEfsArgs, defineEfs"
  dependencies: "@pulumi/aws (efs.FileSystem, MountTarget, AccessPoint); GameServerConfig"
  data_shapes: "gameAccessPoints keyed `${game}-${volume.name}`; caddyDataAccessPoints keyed by game"
  side_effects: AWS EFS resources
  role: Pulumi resource definer
  observations: |
    - Access points posix uid/gid 1000, root dir /{game}/{volume} mode 0755 (efs.ts:79, 121-137).
    - Caddy cert AP root /{game}/caddy-data, tag Name `${game}-certs` (efs.ts:144-160).
    - httpsGameEntries duplicates the `https === true` predicate also in securityGroups.hasHttpsGame and ecs.ts (efs.ts:74-76).
    - Key `${game}-${volume.name}` is re-derived in ecs.ts:219, lambdas.ts:721, program.ts:477 — implicit string contract; a game "a-b" with volume "c" collides with game "a" volume "b-c".

- path: app/packages/infra/src/ecs.ts
  purpose: ECS cluster, per-game log groups (/ecs/{game}-server and filebrowser), and per-game Fargate task definitions (game container, optional Caddy sidecar, optional hostname-shim init container).
  exports: "EcsResources, DefineEcsArgs, defineEcs"
  dependencies: "@pulumi/aws (ecs.Cluster, TaskDefinition, cloudwatch.LogGroup); @hyveon/shared HOSTNAME_SHIM_MOUNT_PATH, fileManagerLogGroupName, ingressPorts, isIcmpProtocol; @hyveon/shared/envTokens HYVEON_ENV_TOKENS, substituteHyveonToken, valueUsesToken; ./envTokenWrapper buildIpv4WrapperScript; ./hostedZoneName stripTrailingDots; ./hostnameShim; ./logGroups LOG_RETENTION_DAYS"
  data_shapes: "containerDefinitions JSON (pulumi.jsonStringify), volumes (efsVolumeConfiguration, transit encryption ENABLED, iam DISABLED)"
  side_effects: AWS ECS + CloudWatch log groups
  role: Pulumi resource definer
  observations: |
    - Never declares aws.ecs.Service (ecs.ts:21-25, 153-157) — invariant.
    - containerInsights disabled (ecs.ts:176).
    - FileBrowser log group /ecs/filebrowser-{game} pre-created because task-execution role cannot CreateLogGroup; its task definition is registered at runtime by FileManagerService (ecs.ts:49-55, 195-206).
    - ${hyveon.network.public-address} resolved at build time to `${game}.${zone}`; throws if zone empty (ecs.ts:118-137).
    - ${hyveon.network.public-ipv4} triggers an entryPoint ['/bin/sh','-c', wrapper] override (ecs.ts:281-289); command is still also set (ecs.ts:290) — with entryPoint set to sh -c script, the separate `command` array becomes positional args to sh ($0...), and the wrapper itself execs config.command; appears redundant but harmless.
    - https games require webPort (requireWebPort throws) — "read games via DeploymentConfigService" (ecs.ts:140-145).
    - ICMP excluded from portMappings (ecs.ts:269-279).
    - Caddy sidecar image `caddy:2-alpine` is a floating tag (ecs.ts:305), unlike the pinned busybox in hostnameShim.ts:15. Caddy proxies `--to localhost:${webPort}`, cert storage at /data on EFS (ecs.ts:311-318).
    - pinnedHostname: ephemeral volume, read-only mount in game container, dependsOn shim container condition SUCCESS, NODE_OPTIONS merge (ecs.ts:239-262, 295-297, 323-331).
    - Caddy sidecar logs to the game's log group with prefix 'caddy' (ecs.ts:319).

- path: app/packages/infra/src/lambdas.ts
  purpose: Declares the four always-on Lambdas (interactions, followup, watchdog, dns-updater), conditional health-check Lambda, per-game efs-seeder Lambdas, their log groups, Function URL, permissions, and EventBridge rules/targets.
  exports: "LambdaResources, DefineLambdasArgs, bundlePath(lambdaBundlesDir, lambdaDirName), defineLambdas"
  dependencies: "node:path; @pulumi/aws (lambda.Function, FunctionUrl, Permission, cloudwatch.EventRule/EventTarget); @pulumi/pulumi (asset.AssetArchive/FileAsset, all, jsonStringify); @hyveon/shared HTTPS_CONNECT_PORT, isIcmpProtocol, ConnectPort, GameServerConfig, GameServerHealthCheck; ./hostedZoneName; ./logGroups lambdaLogGroup"
  data_shapes: "Env vars: followup {AWS_REGION_, TABLE_NAME, ECS_CLUSTER, SUBNET_IDS(csv), SECURITY_GROUP_ID, DOMAIN_NAME, GAME_NAMES(csv sorted), CONNECT_MESSAGES(json), GAME_PORTS(json)}; interactions {AWS_REGION_, TABLE_NAME, DISCORD_PUBLIC_KEY_SECRET_ARN, FOLLOWUP_LAMBDA_NAME, GAME_NAMES, HOSTED_ZONE_NAME}; watchdog {ECS_CLUSTER, GAME_NAMES, IDLE_CHECKS, MIN_PACKETS, CHECK_WINDOW_MINUTES, AWS_REGION_, HEALTH_CHECKS(json), HEALTH_CHECK_FUNCTION_NAME}; dns-updater {HOSTED_ZONE_ID, DOMAIN_NAME, GAME_NAMES, DNS_TTL, AWS_REGION_, TABLE_NAME, CONNECT_MESSAGES, GAME_PORTS}; health-check {AWS_REGION_}; efs-seeder {AWS_REGION_}"
  side_effects: "AWS Lambda/CloudWatch/EventBridge resources; reads bundle files from lambdaBundlesDir at Pulumi run time (FileAsset)."
  role: Pulumi resource definer
  observations: |
    - Runtime nodejs24.x, handler 'handler.handler', code = AssetArchive{'handler.cjs'} (lambdas.ts:58-61, 241-243).
    - lambdaBundlesDir required, no default — electron-vite bundling would break import.meta.url defaults (lambdas.ts:16-30).
    - dns-updater bundle dir is 'update-dns' though resource names use 'dns-updater' (lambdas.ts:633-637).
    - Function URL authorizationType NONE, CORS restricted to https://discord.com POST (lambdas.ts:473-485); two public permissions (InvokeFunctionUrl + InvokeFunction, "required since October 2025") (lambdas.ts:487-514).
    - Watchdog/dns-updater omit memorySize (128 MB default) on purpose (lambdas.ts:569-570, 639).
    - EventBridge schedule singular/plural 'minute(s)' (lambdas.ts:590-598); task-state rule matches clusterArn + lastStatus RUNNING/STOPPED (lambdas.ts:668-672).
    - GAME_PORTS: https games → HTTPS_CONNECT_PORT marker; else first non-icmp public port, falling back to ports[0] of connectable ports (lambdas.ts:307-322).
    - **Health-check function env only {AWS_REGION_} (lambdas.ts:552) but its handler requires ECS_CLUSTER at module load (lambda/health-check/src/handler.ts:39) — appears to make every health-check invocation fail at init; the infra test pins env to exactly {AWS_REGION_} (infra/src/lambdas.test.ts:~792).**
    - HOSTED_ZONE_NAME is set on interactions (lambdas.ts:463) but the interactions handler never reads it.
    - Log groups for followup/interactions/watchdog/dns-updater are declared AFTER their functions with no dependsOn (lambdas.ts:443, 471, 588, 657); only health-check and efs-seeder functions dependOn their log group (lambdas.ts:555, 754). Appears to allow Lambda to auto-create the group (without retention) if invoked before the LogGroup resource lands.
    - Up-front validation of efsSeeder/healthCheck SG ids to avoid half-constructed mock graphs (lambdas.ts:392-410).
    - efs-seeder mounts only the FIRST volume's access point at /mnt/efs (lambdas.ts:720-745).
    - Doc drift: "see this file's doc for the full HCL→Pulumi address table" (lambdas.ts:63, 348-349) — no table exists. defineLambdas doc says "all seven of whose outputs" (lambdas.ts:351-356) — muddled count.

- path: app/packages/infra/src/logGroups.ts
  purpose: LOG_RETENTION_DAYS (7) and lambdaLogGroup helper (/aws/lambda/${projectName}-${suffix}).
  exports: "LOG_RETENTION_DAYS, lambdaLogGroup(projectName, suffix, opts, extraTags?)"
  dependencies: "@pulumi/aws cloudwatch.LogGroup"
  data_shapes: none
  side_effects: AWS log group resource
  role: Pulumi helper
  observations: "Logical name `${projectName}-${suffix}-logs` must stay byte-identical or Pulumi replaces the live group (logGroups.ts:17-19). Doc lists only lambdas + per-game ECS groups (logGroups.ts:2-5), omitting the filebrowser log groups in ecs.ts."

- path: app/packages/infra/src/hostedZoneName.ts
  purpose: stripTrailingDots — manual scan (avoids CodeQL polynomial-redos) to remove trailing '.' from hosted zone name.
  exports: stripTrailingDots
  dependencies: none
  data_shapes: string → string
  side_effects: none (pure)
  role: utility
  observations: "Used by ecs.ts:170, lambdas.ts:390, discordDomain.ts:108. route53.ts getZone uses the unstripped name (route53.ts:65)."

- path: app/packages/infra/src/dynamodb.ts
  purpose: Discord table and audit table; documents that the runs table is bootstrap-managed (not Pulumi).
  exports: "DynamoDbResources, DefineDynamoDbArgs, defineDynamoDb"
  dependencies: "@pulumi/aws dynamodb.Table"
  data_shapes: "Both tables pk/sk (S) PAY_PER_REQUEST. Discord: TTL attr expiresAt, PITR off, rows CONFIG#discord, BASE#discord, PENDING#{taskArn}. Audit: PITR on, name override via auditTableName."
  side_effects: AWS DynamoDB tables
  role: Pulumi resource definer
  observations: |
    - Runs table schema documented for BootstrapService.ensureRunsTable parity (status-index GSI) but not declared (dynamodb.ts:6-28).
    - Logical names fixed regardless of name override (dynamodb.ts:93-101).
    - Discord table name not overridable (dynamodb.ts:44-46).

- path: app/packages/infra/src/secrets.ts
  purpose: Three Secrets Manager secrets (discord bot-token, discord public-key, filebrowser credential) with create-only placeholder versions.
  exports: "SecretsResources, DefineSecretsArgs, secretResourceOptions.forVersion(provider), defineSecrets"
  dependencies: "@pulumi/aws secretsmanager.Secret/SecretVersion"
  data_shapes: "Names ${projectName}/discord/bot-token, ${projectName}/discord/public-key, ${projectName}/filebrowser/credential; secretString 'placeholder'"
  side_effects: AWS secrets
  role: Pulumi resource definer
  observations: |
    - ignoreChanges ['secretString'] so real values written by DiscordConfigService are never reverted (secrets.ts:15-21, 89-91).
    - recoveryWindowInDays 0 — immediate delete on destroy (secrets.ts:112, 131, 150).
    - secretResourceOptions is an object (not bare function) to allow vi.spyOn call-site assertions (secrets.ts:76-92).
    - Doc drift: defineSecrets doc says "the two Discord secrets" (secrets.ts:95) — there are three; PLACEHOLDER doc cites "`secretsStore` (`dynamodb.ts`'s file doc...)" (secrets.ts:61-63) — dynamodb.ts doc has no such content (stale cross-reference).

- path: app/packages/infra/src/route53.ts
  purpose: Hosted-zone lookup only (getZoneOutput, privateZone false); declares no Record.
  exports: "Route53Resources {zone, zoneId}, DefineRoute53Args, defineRoute53"
  dependencies: "@pulumi/aws route53.getZoneOutput"
  data_shapes: GetZoneResult
  side_effects: AWS data lookup
  role: Pulumi data-source definer
  observations: "Invariant: no aws.route53.Record here (route53.ts:8-21); discordDomain.ts's three static records are the documented exception."

- path: app/packages/infra/src/discordDomain.ts
  purpose: discord.{zone} custom domain — us-east-1 ACM cert + DNS validation, CloudFront distribution fronting the interactions Function URL, A/AAAA ALIAS records.
  exports: "DiscordDomainResources, DefineDiscordDomainArgs, defineDiscordDomain"
  dependencies: "@pulumi/aws (acm.Certificate, CertificateValidation, cloudfront.Distribution, route53.Record), @pulumi/pulumi output; ./hostedZoneName"
  data_shapes: "Origin domain = functionUrl stripped of https:// and trailing /"
  side_effects: AWS ACM/CloudFront/Route 53
  role: Pulumi resource definer
  observations: |
    - Unconditional — always declared, no config toggle (discordDomain.ts:14-15).
    - Only cert + validation use usEast1Provider (discordDomain.ts:22-30, 124, 150).
    - Managed policy IDs hardcoded: CachingDisabled 4135ea2d-..., AllViewerExceptHostHeader b689b0a8-... (discordDomain.ts:43, 52).
    - PriceClass_100, waitForDeployment false, TLSv1.2_2021, sni-only (discordDomain.ts:160-162, 186-192).
    - Validation record allowOverwrite: true, indexes domainValidationOptions[0] (single domain) (discordDomain.ts:129-141).
    - Doc refs a section "Certificate has a single domain, so validation needs only one record." (discordDomain.ts:58, 127-128) that doesn't exist under that title.
    - CloudFront allows all methods incl. PUT/PATCH/DELETE while the Function URL CORS only lists POST (discordDomain.ts:178 vs lambdas.ts:480).

- path: app/packages/infra/src/escapes.ts
  purpose: "Imperative escapes": conditional Discord seed rows (BASE#discord, CONFIG#discord) and per-game efs-seeder aws.lambda.Invocation.
  exports: "DiscordTableItemResources, DefineDiscordTableItemsArgs, escapeResourceOptions {forDiscordConfigSeedItem, forEfsSeederInvocation}, defineDiscordTableItems, DefineEfsSeederInvocationsArgs, defineEfsSeederInvocations"
  dependencies: "node:crypto; @pulumi/aws (dynamodb.TableItem, lambda.Invocation); GameServerConfig"
  data_shapes: "BASE#discord/BASE item {data.M.allowedGuilds L, admins.M.userIds/roleIds L, updatedAt N '0'}; CONFIG#discord/CONFIG item {clientId, empty allowedGuilds/admins/gamePermissions}; invocation input {game, seeds, container_path}; triggers {seedsHash: sha256(JSON(file_seeds))}"
  side_effects: "DynamoDB writes; synchronous Lambda invocation during apply."
  role: Pulumi resource definer
  observations: |
    - CONFIG#discord created only if discordApplicationId !== '' with ignoreChanges ['item'] (escapes.ts:148-172, 92-94); BASE#discord recomputed every deploy (immutable floor) (escapes.ts:12-15, 119-146).
    - Invocation dependsOn the per-game seeder policy (escapes.ts:101-103, 259).
    - seedsHash covers only file_seeds — a change to volumes[0].container_path (which is in `input`) won't by itself change triggers (escapes.ts:213-215, 250-257); appears Pulumi still diffs `input`, behaviour depends on provider.
    - Slash-command registration is explicitly NOT here — DiscordCommandRegistrar in desktop-main (escapes.ts:23-27).
    - Doc drift: "see this file's doc for the full HCL→Pulumi address table" (escapes.ts:35) — none exists.

- path: app/packages/infra/src/envTokenWrapper.ts
  purpose: Generates a POSIX sh entrypoint wrapper that discovers the task's public IPv4 at boot and splices it into ipv4-token env vars, then execs the command.
  exports: "Ipv4WrapperArgs, shellSingleQuote, buildIpv4WrapperScript"
  dependencies: "@hyveon/shared/envTokens HYVEON_ENV_TOKENS, valueUsesToken; GameServerEnvironmentVariable"
  data_shapes: "script string"
  side_effects: "none at build; script at runtime does HTTP to https://checkip.amazonaws.com"
  role: utility / codegen
  observations: |
    - 30 attempts × 2s, wget then curl, validates dotted-quad with octet ≤255, exits 1 on failure (envTokenWrapper.ts:65-97).
    - Throws on empty command, no token var, non-identifier var name (envTokenWrapper.ts:51-62).
    - Depends on wget or curl being present in the game image; neither is guaranteed.

- path: app/packages/infra/src/hostnameShim.ts
  purpose: Pinned-hostname support — busybox init container writes a CJS preload overriding os.hostname(); NODE_OPTIONS merge.
  exports: "HOSTNAME_SHIM_IMAGE ('public.ecr.aws/docker/library/busybox:1.38.0'), HOSTNAME_SHIM_CONTAINER_NAME, hostnameShimVolumeName, buildHostnameShimSource, buildHostnameShimContainer, mergeNodeOptions"
  dependencies: "@hyveon/shared HOSTNAME_SHIM_MOUNT_PATH, HOSTNAME_SHIM_RESERVED_NAME"
  data_shapes: "container definition object; env array"
  side_effects: none
  role: utility / container-def builder
  observations: "Shim passed base64 to avoid shell quoting (hostnameShim.ts:49-50, 61-66). Existing NODE_OPTIONS kept in place, shim flag prefixed (hostnameShim.ts:84-92)."

- path: app/packages/infra/src/testing/fixtures.ts
  purpose: Shared test DeploymentConfig + FIXTURE_GAME_SERVERS (alpha/bravo share 25565/tcp, charlie 7777/udp, delta https webPort 8080).
  exports: "FIXTURE_GAME_SERVERS, buildTestDeploymentConfig(overrides)"
  dependencies: DeploymentConfig, GameServerConfig types
  data_shapes: DeploymentConfig
  side_effects: none
  role: test fixture
  observations: "Hardcodes defaults rather than importing DEPLOYMENT_CONFIG_DEFAULTS though its doc says it uses those values (fixtures.ts:58-60, 67-81)."

- path: app/packages/infra/src/testing/pulumiMocks.ts
  purpose: Pulumi setMocks harness — records resources/calls, canned data-source results, computed-state mocks.
  exports: "RecordedResource, RecordedCall, PulumiMockHandle, installPulumiMocks(), promiseOf(output)"
  dependencies: "@pulumi/pulumi runtime.setMocks"
  data_shapes: "CALL_MOCKS for getAvailabilityZones, getVpc, getZone; RESOURCE_STATE_MOCKS for acm Certificate, cloudfront Distribution, route53 Record (fqdn), lambda FunctionUrl"
  side_effects: "Process-global Pulumi mock monitor."
  role: test harness
  observations: "Strict rule: every test must await its resource outputs; never fixed-delay flushes (pulumiMocks.ts:14-27). Unknown call tokens throw (pulumiMocks.ts:212-214)."
```

### Infra test files

```yaml
- path: app/packages/infra/src/index.test.ts
  role: test
  purpose: "Pins that createInfraProgram, buildStackOutputs, network/SG helpers, defineDiscordDomain are exported functions."
- path: app/packages/infra/src/hostedZoneName.test.ts
  role: test
  purpose: "stripTrailingDots: none/one/many trailing dots, interior dots kept, all-dots and empty → ''."
- path: app/packages/infra/src/route53.test.ts
  role: test
  purpose: "getZone called with {name, privateZone:false}; zoneId resolves; NO aws:route53/record:Record and no custom resources declared."
- path: app/packages/infra/src/network.test.ts
  role: test
  purpose: "cidrSubnet math (/16→/24, non-default base, overflow throws); VPC DNS flags, IGW, two subnets (10.0.0.0/24, 10.0.1.0/24, AZ a/b, public IP), route table default route via IGW, two associations."
- path: app/packages/infra/src/dynamodb.test.ts
  role: test
  purpose: "Discord table keys/billing/TTL expiresAt/PITR off/fixed name; audit table default vs override name with stable logical name, PITR on, no GSI."
- path: app/packages/infra/src/secrets.test.ts
  role: test
  purpose: "Three secrets' names/descriptions/0-day recovery; placeholder secretString (unwraps Pulumi secret wrapper); DefineSecretsArgs keys exactly {projectName, provider} (type-level); forVersion spied 3× returning ignoreChanges ['secretString']."
- path: app/packages/infra/src/envTokenWrapper.test.ts
  role: test
  purpose: "shellSingleQuote escaping; only token vars exported; exec args quoted; adversarial values inert; throws on empty command/no token/bad identifier; executes script under real /bin/sh against local HTTP server, including rejection of garbage and out-of-range octets with retry."
- path: app/packages/infra/src/hostnameShim.test.ts
  role: test
  purpose: "Shim preloaded into a real child Node process changes os.hostname(); init container non-essential, mount, base64 command round-trips; volume naming; NODE_OPTIONS append/prefix-in-place/keeps ipv4 token/no mutation."
- path: app/packages/infra/src/efs.test.ts
  role: test
  purpose: "Encrypted FS + creation token; 2 mount targets with efs SG; one AP per (game,volume) with uid/gid 1000 and /game/volume 0755; caddy-data AP only for https game; none when no https game."
- path: app/packages/infra/src/discordDomain.test.ts
  role: test
  purpose: "Cert for discord.{zone} DNS-validated, trailing dot stripped; cert+validation on us-east-1 provider, rest on regional; validation record from DVO; origin stripping; CloudFront cache/restriction/alias attrs; viewer cert = validated ARN, sni-only, TLSv1.2_2021; A+AAAA aliases; exactly six resources."
- path: app/packages/infra/src/ecs.test.ts
  role: test
  purpose: "Cluster containerInsights disabled; /ecs/{game}-server and /ecs/filebrowser-{game} 7-day groups; task defs family/awsvpc/FARGATE/cpu-memory strings/execution role; EFS volume wiring; container defs; icmp (incl. 'ICMP') excluded from portMappings; empty env default; Caddy sidecar + cert volume only for https; webPort mapping + proxy target; never aws.ecs.Service; public-address token substitution; ipv4 wrapper entryPoint; pinnedHostname init container/dependsOn/RO mount/ephemeral volume, byte-identical when absent, coexists with wrapper; throws on token with empty zone."
- path: app/packages/infra/src/escapes.test.ts
  role: test
  purpose: "BASE#discord presence guard and content; CONFIG#discord presence guard/content and forDiscordConfigSeedItem spy (and not called when absent); ignoreChanges ['item']; seeder invocations none/throws on drift (missing gameServers or policy)/one per function with input/triggers; seedsHash changes with content, stable otherwise; forEfsSeederInvocation spy and dependsOn [policy]."
- path: app/packages/infra/src/iam.test.ts
  role: test
  purpose: "gamesWithFileSeeds/gamesWithHealthChecks filters; every role's trust principal; managed-policy attachment; seeder roles per game; scheduler role; conditional single health-check role; each policy's statements/ARN wiring; scheduler StopTask cluster scope; health-check secret ARNs exact or omitted; watchdog InvokeFunction conditional."
- path: app/packages/infra/src/lambdas.test.ts
  role: test
  purpose: "bundlePath join; per-function name/role/handler/runtime/timeout/memory and exact env maps (AWS_REGION_ trailing underscore); log groups; code from right bundle dir (update-dns); Function URL NONE + Discord CORS; two public permissions with statement ids; watchdog schedule singular/plural + target + permission; task-state event pattern; CONNECT_MESSAGES/GAME_PORTS derivation (https marker, internal-first, unknown visibility, icmp, fallback); seeder SG validation throw and per-role functions; health-check absent/throw/present with env exactly {AWS_REGION_}; watchdog HEALTH_CHECKS/HEALTH_CHECK_FUNCTION_NAME."
- path: app/packages/infra/src/program.test.ts
  role: test
  purpose: "createInfraProgram is a zero-arg PulumiFn resolving to outputs; defineAll declares full resource set and cross-module wiring (table name/ARN, secret ARN, zone id, cluster name, seed items, seeder invocation, provider region, Project=hyveon default tag, efs SG ingress, mount target SG, task-exec role ARN); buildStackOutputs every field source, custom-domain URLs, resolved audit/runs table names, throws on AP drift."
- path: app/packages/infra/src/securityGroups.test.ts
  role: test
  purpose: "Port dedup across games; https undefined≡false; https extras in, webPort out; internal vs public visibility; unknown visibility fails closed; hasHttpsGame; SG ingress shapes incl. VPC-CIDR for internal (and no getVpc call when none), 443/80 pair once; filemgr empty ingress; efs ingress sources; seeder SG + inline efs ingress + standalone NFS egress; icmp toPort -1 public/internal/dedup/'ICMP'; health-check SG no inline egress, ingress on game SG, per-port standalone egress deduped."
```

## app/packages/lambda

```yaml
- path: app/packages/lambda/buildLambda.mjs
  purpose: Shared esbuild bundler — src/handler.ts → dist/handler.cjs (cjs, node24, minified, sourcemap).
  exports: "buildLambda({external})"
  dependencies: esbuild, fs
  data_shapes: none
  side_effects: "Writes dist/ in the cwd (package dir)."
  role: build script
  observations: "Relative paths assume cwd = package dir (buildLambda.mjs:13,16-17). sourcemap emitted but only handler.cjs is zipped by infra (lambdas.ts:242), so the .map never ships."

- path: app/packages/lambda/tsconfig.lambda.json
  purpose: Shared Lambda tsconfig using ${configDir} (noEmit, non-composite).
  exports: none
  dependencies: ../../tsconfig.base.json
  data_shapes: none
  side_effects: none
  role: config
  observations: "efs-seeder does NOT extend this — its tsconfig.json extends tsconfig.base.json directly with equivalent options (efs-seeder/tsconfig.json)."
```

### app/packages/lambda/efs-seeder

```yaml
- path: app/packages/lambda/efs-seeder/package.json
  purpose: "@hyveon/lambda-efs-seeder manifest; only devDep @types/node."
  role: config
  observations: "No @hyveon/shared dependency — the only Lambda that is fully standalone."
- path: app/packages/lambda/efs-seeder/esbuild.config.mjs
  purpose: "buildLambda() with no externals."
  role: build config
  observations: "Only Lambda that bundles everything (it imports no AWS SDK)."
- path: app/packages/lambda/efs-seeder/tsconfig.json
  purpose: "Standalone tsconfig (extends ../../../tsconfig.base.json)."
  role: config
  observations: "Diverges from the other five packages, which extend ../tsconfig.lambda.json."
- path: app/packages/lambda/efs-seeder/src/handler.ts
  purpose: Writes file_seeds onto the EFS access point mounted at /mnt/efs during Pulumi apply.
  exports: "handler(event: {game, seeds: FileSeed[], container_path})"
  dependencies: "fs (writeFileSync, mkdirSync), path"
  data_shapes: "FileSeed {path, content?, content_base64?, mode?}"
  side_effects: "Filesystem writes under /mnt/efs; console logs."
  role: Lambda handler
  observations: |
    - MOUNT_POINT '/mnt/efs' must match infra lambdas.ts localMountPath (handler.ts:19-20).
    - Rejects paths not under container_path, path == container_path, traversal outside mount (handler.ts:27-49).
    - Exactly one of content / content_base64 required; mode regex ^0?[0-7]{3,4}$ default 0644 (handler.ts:65-84).
    - writeFileSync mode only applies on file creation — an existing file's permissions are not changed on re-seed (handler.ts:87).
    - Throws on any error so Pulumi apply fails (handler.ts:51-56).
    - Event shape not validated (seeds undefined would throw TypeError).
- path: app/packages/lambda/efs-seeder/src/handler.test.ts
  role: test
  purpose: "Mocks fs; pins UTF-8 and base64 writes to correct path, custom mode, multiple seeds, throws on prefix mismatch/no file component/traversal/neither/both content/invalid mode, empty list ok."
```

### app/packages/lambda/followup

```yaml
- path: app/packages/lambda/followup/package.json
  purpose: "@hyveon/lambda-followup; deps @hyveon/shared; devDeps client-ec2, client-ecs, @types/aws-lambda."
  role: config
  observations: "AWS SDK only as devDeps — relies on runtime-provided SDK via external @aws-sdk/*."
- path: app/packages/lambda/followup/esbuild.config.mjs
  purpose: "buildLambda({external: ['@aws-sdk/*']})"
  role: build config
- path: app/packages/lambda/followup/tsconfig.json
  purpose: "extends ../tsconfig.lambda.json, references shared."
  role: config
- path: app/packages/lambda/followup/src/handler.ts
  purpose: Async-invoked by interactions; does ECS RunTask/StopTask/Describe and PATCHes the original Discord interaction; writes PENDING row on start.
  exports: "handler(event: FollowupEvent {kind start|stop|status|list, applicationId, interactionToken, userId, guildId, roleIds, game?})"
  dependencies: "@aws-sdk/client-ecs (ListTasks, DescribeTasks, RunTask, StopTask), @aws-sdk/client-ec2 DescribeNetworkInterfaces; @hyveon/shared canRun, formatGameStatus, gameNamesFromEnv, getEffectiveDiscordConfig, getTaskEniId, parseGameMapEnv, patchInteractionOriginal, putPending, renderConnectMessage, requireEnv, resolveEniPublicIp"
  data_shapes: "GameStatus {game, state running|starting|stopped|error, publicIp?, hostname?, taskArn?}; pending row {taskArn, applicationId, interactionToken, userId, guildId, game, action:'start'}"
  side_effects: "ECS RunTask/StopTask; EC2 describe; DynamoDB GetItem (config) and PutItem (pending); HTTPS PATCH to Discord webhook; console.error."
  role: Lambda handler
  observations: |
    - RunTask: FARGATE, assignPublicIp ENABLED, propagateTags TASK_DEFINITION, taskDefinition `${game}-server` (handler.ts:127-138).
    - Refuses to start if a non-STOPPED/DEPROVISIONING task exists for the family (handler.ts:79-86, 123-124).
    - Defensive canRun re-check per action (handler.ts:219-228); list filters games by canRun 'status' (handler.ts:164-179). 'list' and status-with-no-game skip recheck (handler.ts:244-251).
    - getEffectiveDiscordConfig (handler.ts:240) and patchInteractionOriginal (handler.ts:272) are OUTSIDE the try — a DynamoDB or Discord failure leaves the deferred interaction unresolved with no user-visible message.
    - On start with connect_message, renders it with ip '' (handler.ts:201-208).
    - region() fallback chain AWS_REGION_ → AWS_REGION → AWS_DEFAULT_REGION → us-east-1 (handler.ts:53-61) — duplicated verbatim in interactions:57-58, health-check:34-37, update-dns:51-59, watchdog:53-61.
    - Errors stringified into user-facing Discord messages (`String(err)`) (handler.ts:114, 146, 160) — may surface AWS error text to Discord users.
    - Lazily-created SDK clients (handler.ts:50-71) unlike update-dns/watchdog module-scope clients.
- path: app/packages/lambda/followup/src/handler.test.ts
  role: test
  purpose: "Mocks shared + SDK; start → RunTask + putPending keyed by taskArn + PATCH; no pending row when RunTask returns no task; canRun denial; stop → StopTask + confirmation, friendly not-running; status includes hostname when running; list filters by permission and newline-joins, helpful message when none visible."
```

### app/packages/lambda/health-check

```yaml
- path: app/packages/lambda/health-check/package.json
  purpose: "@hyveon/lambda-health-check; deps shared; devDeps client-ecs, client-secrets-manager, @types/aws-lambda, @types/node."
  role: config
- path: app/packages/lambda/health-check/esbuild.config.mjs
  purpose: "buildLambda external @aws-sdk/*"
  role: build config
- path: app/packages/lambda/health-check/tsconfig.json
  purpose: "extends ../tsconfig.lambda.json, references shared."
  role: config
- path: app/packages/lambda/health-check/src/engine.ts
  purpose: Pure verdict engine — evaluates HTTP status + JSON body against healthCheck.activeWhen {jsonPath, operator, value}.
  exports: "HealthCheckVerdict {active, reason, failureDerived}, evaluateHealthCheck(config, status, rawBody)"
  dependencies: "GameServerHealthCheck type"
  data_shapes: "Operators exists/equals/notEquals/greaterThan/lessThan/contains; JSONPath subset (dot fields + numeric [i])"
  side_effects: none (pure)
  role: domain logic
  observations: |
    - Every non-conclusive outcome is fail-active (active: true, failureDerived: true): non-2xx, bad JSON, missing path, non-scalar, incomparable (engine.ts:156-211).
    - 'exists' with missing path → idle (not failure) (engine.ts:175-179).
    - equals/notEquals type mismatch → incomparable, but null vs anything is compared directly (engine.ts:117).
    - Reasons never include resolved values (engine.ts:8-11).
    - Unsupported JSONPath syntax silently tokenizes to a non-resolving path; a leading '$' would be treated as a field name '$' (engine.ts:26-60) — appears to make "$.players" style paths never resolve.
- path: app/packages/lambda/health-check/src/handler.ts
  purpose: Invoked synchronously by watchdog; resolves task private IP from ECS, optional credential from Secrets Manager, issues the declared HTTP request, returns engine verdict.
  exports: "HealthCheckEvent {game, taskArn, healthCheck}, handler(event) → HealthCheckVerdict"
  dependencies: "@aws-sdk/client-ecs DescribeTasks, @aws-sdk/client-secrets-manager GetSecretValue; @hyveon/shared getTaskPrivateIp, requireEnv, GameServerHealthCheck(Auth); ./engine; global fetch"
  data_shapes: "auth.type raw|bearer|basic ({username,password} JSON secret)"
  side_effects: "ECS DescribeTasks, Secrets Manager read, HTTP(S) fetch to task private IP; JSON-line console.debug/warn."
  role: Lambda handler
  observations: |
    - **ECS_CLUSTER is read via requireEnv at module scope (handler.ts:39), but infra declares the function with env {AWS_REGION_} only (infra/src/lambdas.ts:552) — appears to throw on cold start, producing a FunctionError on every invoke; watchdog then fail-actives (watchdog/src/handler.ts:130-131), so opted-in games would never be idle-stopped. Unit test masks this by setting process.env.ECS_CLUSTER (handler.test.ts:18).**
    - Even with env fixed, the function runs in public subnets with no public IP/NAT/VPC endpoints and an SG whose only egress is to game tasks on health ports (securityGroups.ts:430-446) — ECS DescribeTasks and Secrets Manager calls appear unreachable, so the handler would time out (30 s, infra/src/lambdas.ts:547) → watchdog fail-active.
    - Host always from ECS attachment, never config (handler.ts:53-71).
    - Injected Authorization overrides any case-variant operator header (handler.ts:131-142).
    - redirect: 'manual' — a 3xx is non-2xx → fail-active (handler.ts:170; engine.ts:157).
    - All errors caught → fail-active verdict, logged at warn (handler.ts:178-187).
    - getTaskPrivateIp is in @hyveon/shared; doc comment refers to "the watchdog's own getEniId" (handler.ts:55-57) — watchdog actually uses shared getTaskEniId.
- path: app/packages/lambda/health-check/src/engine.test.ts
  role: test
  purpose: "Fail-active for non-2xx (incl. 1xx/3xx), bad JSON, missing/non-scalar path; nested and indexed resolution; each operator's active/idle/fail-active branches incl. type mismatch and non-numeric; reasons never leak values."
- path: app/packages/lambda/health-check/src/handler.test.ts
  role: test
  purpose: "Host from ECS attachment only; no secret fetch without auth; Authorization injection and override; basic/bearer/raw formats; malformed basic secret fail-active; secrets/basic creds/response body never logged; fail-active on no attachment, task not found, secret unavailable, timeout/refused; success delegated to engine. Sets ECS_CLUSTER env (line 18)."
```

### app/packages/lambda/interactions

```yaml
- path: app/packages/lambda/interactions/package.json
  purpose: "@hyveon/lambda-interactions; deps shared, @noble/ed25519 ^3.1.0; devDeps client-lambda, @types/aws-lambda."
  role: config
- path: app/packages/lambda/interactions/esbuild.config.mjs
  purpose: "buildLambda external @aws-sdk/*"
  role: build config
- path: app/packages/lambda/interactions/tsconfig.json
  purpose: "extends ../tsconfig.lambda.json, references shared."
  role: config
- path: app/packages/lambda/interactions/src/handler.ts
  purpose: Discord HTTP interactions entry point behind the Function URL (via CloudFront) — Ed25519 verify, PING, autocomplete, command dispatch to followup.
  exports: "handler(event: APIGatewayProxyEventV2) → APIGatewayProxyResultV2"
  dependencies: "@noble/ed25519 verifyAsync; @aws-sdk/client-lambda InvokeCommand; @hyveon/shared canRun, gameNamesFromEnv, getEffectiveDiscordConfig, getPublicKey, requireEnv"
  data_shapes: "Interaction {id, application_id, type, token, guild_id?, member?, user?, data?}; response types 1/4/5/8; EPHEMERAL flag 64; FollowupPayload"
  side_effects: "Secrets Manager read (public key), DynamoDB read (config), async Lambda invoke (InvocationType Event)."
  role: Lambda handler
  observations: |
    - Signature verified over timestamp + raw body before any config read; 401 on missing headers, unset key, bad hex, failed verify (handler.ts:268-280, 79-93).
    - No timestamp freshness/replay window check (handler.ts:269-280) — appears to rely solely on Discord's signature.
    - Command map: server-start→start, server-stop→stop, server-status/server-list→status (handler.ts:138-150).
    - Guild allowlist checked (cfg.allowedGuilds) before canRun for commands (handler.ts:188-191); autocomplete does NOT check allowedGuilds separately (relies on canRun) (handler.ts:152-178).
    - server-status without game → list dispatch (handler.ts:209-219).
    - Autocomplete capped at 25 choices (handler.ts:172).
    - Deferred ack (type 5, ephemeral) returned only after invokeFollowup resolves (handler.ts:198-206) — invoke latency counts against Discord's 3s budget.
    - HOSTED_ZONE_NAME env (set by infra) is unused here.
    - hexToBytes uses deprecated String.prototype.substr (handler.ts:72).
    - FollowupPayload interface duplicates followup's FollowupEvent (handler.ts:239-247 vs followup/src/handler.ts:40-48).
- path: app/packages/lambda/interactions/src/handler.test.ts
  role: test
  purpose: "401 on missing headers/unset key/failed verify/non-hex; verify over timestamp+rawBody; PING→PONG; guild allowlist refusal; permission refusal; deferred ack + async followup invoke; server-start requires game; server-list and game-less server-status dispatch as list; admin bypass; autocomplete filtering by permission + partial, 25 cap, empty when unfocused."
```

### app/packages/lambda/update-dns

```yaml
- path: app/packages/lambda/update-dns/package.json
  purpose: "@hyveon/lambda-update-dns; deps shared; devDeps client-ec2, client-ecs, client-route-53, @types/aws-lambda."
  role: config
- path: app/packages/lambda/update-dns/esbuild.config.mjs
  purpose: "buildLambda external @aws-sdk/*"
  role: build config
- path: app/packages/lambda/update-dns/tsconfig.json
  purpose: "extends ../tsconfig.lambda.json, references shared."
  role: config
- path: app/packages/lambda/update-dns/src/handler.ts
  purpose: EventBridge ECS Task State Change handler — UPSERT A record on RUNNING, DELETE on STOPPED, PATCH pending Discord interaction.
  exports: "handler(event: EcsStateChangeEvent) → HandlerResult {status, game?, ip?, reason?, lastStatus?}"
  dependencies: "@aws-sdk/client-ecs, client-ec2, client-route-53 (ChangeResourceRecordSets, ListResourceRecordSets); @hyveon/shared deletePending, familyToGameMap, formatGameStatus, gameNamesFromEnv, getPending, getTaskEniId, parseGameMapEnv, patchInteractionOriginal, requireEnv, resolveEniPublicIp"
  data_shapes: "detail {lastStatus, taskArn, clusterArn, group 'family:<game>-server'}"
  side_effects: "Route 53 writes, ECS/EC2 reads, DynamoDB Get/Delete pending, HTTPS PATCH to Discord, logs full event JSON."
  role: Lambda handler
  observations: |
    - HOSTED_ZONE_ID and DOMAIN_NAME required at module load (handler.ts:37-38); TABLE_NAME optional — Discord notify skipped when empty (handler.ts:41, 181).
    - IP resolution retries 5×, 3s sleep (handler.ts:67-96) — comment cites retired "update_dns.py" (handler.ts:69).
    - DELETE reads the current record IP first and sends DELETE with the CURRENT DNS_TTL (handler.ts:141-170); Route 53 DELETE requires an exact TTL match, so a dnsTtl change between UPSERT and DELETE appears to make DELETE fail (warned, swallowed) and orphan the record.
    - STOPPED deletes the record without checking it belongs to this taskArn (handler.ts:235-238).
    - Pending row not cleared on STOPPED / no-IP-at-all paths beyond the notify call (handler.ts:224-238); relies on DynamoDB TTL.
    - Route53Client({}) — no region (global) (handler.ts:63).
    - HTTPS games follow the same A-record path (handler.ts:6-7, 245-247).
    - Unknown family → skipped (handler.ts:260-263).
    - Logs the full event payload (handler.ts:252).
- path: app/packages/lambda/update-dns/src/handler.test.ts
  role: test
  purpose: "Unknown family skipped; RUNNING → UPSERT A to resolved IP; STOPPED → DELETE existing record; https-flagged game same path; pending row → PATCH + deletePending; none → no PATCH/delete."
```

### app/packages/lambda/watchdog

```yaml
- path: app/packages/lambda/watchdog/package.json
  purpose: "@hyveon/lambda-watchdog; deps shared; devDeps client-cloudwatch, client-ecs, client-lambda, client-route-53, @smithy/core, @types/aws-lambda."
  role: config
  observations: "client-route-53 devDep unused by watchdog src (DNS cleanup moved to update-dns). @smithy/core devDep appears test-only."
- path: app/packages/lambda/watchdog/esbuild.config.mjs
  purpose: "buildLambda external @aws-sdk/*"
  role: build config
- path: app/packages/lambda/watchdog/tsconfig.json
  purpose: "extends ../tsconfig.lambda.json, references shared."
  role: config
- path: app/packages/lambda/watchdog/src/handler.ts
  purpose: Scheduled idle-shutdown — per running game task, verdict via CloudWatch NetworkPacketsIn or the health-check Lambda; counts idle windows in an ECS task tag; StopTask at threshold.
  exports: "handler() → {checked}"
  dependencies: "@aws-sdk/client-ecs (ListTasks, DescribeTasks, StopTask, TagResource, ListTagsForResource), client-cloudwatch GetMetricStatistics, client-lambda Invoke; @hyveon/shared familyToGameMap, gameNamesFromEnv, getTaskEniId, parseGameMapEnv, requireEnv, GameServerHealthCheck"
  data_shapes: "Task tag idle_checks=<n>; HealthCheckInvokeResult {active, reason, failureDerived?} (locally duplicated)"
  side_effects: "ECS list/describe/tag/stop, CloudWatch read, synchronous Lambda invoke, logs."
  role: Lambda handler
  observations: |
    - Idle state lives in ECS task tag 'idle_checks' (handler.ts:146-168) — invariant.
    - Missing CloudWatch datapoints or query failure → assume active (MIN_PACKETS+1) (handler.ts:94-101).
    - Health-check invoke failure / FunctionError / malformed payload / unset function name → fail-active (handler.ts:113-144).
    - Exactly one verdict source per task (handler.ts:211-228).
    - Does NOT delete DNS; relies on STOPPED event → update-dns (handler.ts:13-17).
    - Single DescribeTasks over all listed ARNs (handler.ts:200) — DescribeTasks accepts max 100 tasks; >100 running tasks appears to throw.
    - StopTask not wrapped in try/catch (handler.ts:239-245) — one failure aborts the remaining tasks in the run.
    - Tasks with no ENI are skipped without counting (handler.ts:223-224) after already incrementing `checked` (handler.ts:209).
    - Counter not reset after StopTask (task is gone anyway).
    - Handler doc still says it reads only NetworkPacketsIn and uses legacy var names `watchdog_interval_minutes`/`watchdog_idle_checks` (handler.ts:183-190).
    - HealthCheckInvokeResult duplicated from health-check's HealthCheckVerdict by design (handler.ts:67-72).
- path: app/packages/lambda/watchdog/src/handler.test.ts
  role: test
  purpose: "No-op with no tasks; unknown families ignored; idle counter increments below threshold, resets on activity, no tag write when already 0; StopTask at IDLE_CHECKS for direct and https games; missing datapoints = active; health-check routing exclusive (CloudWatch vs invoke); idle from health check increments; invoke failure / FunctionError do not increment."
```

## Observed behaviours

- Infra program is an in-process Pulumi Automation API inline program; config captured by closure, not pulumi.Config — app/packages/infra/src/program.ts:545-549.
- Blank `hostedZoneName` fails the program before any resource is declared — app/packages/infra/src/program.ts:163-168.
- Every resource is tagged `Project=hyveon` through provider `defaultTags`, independent of projectName — app/packages/infra/src/program.ts:40, 170-182.
- A second provider pinned to us-east-1 is used only for the Discord ACM cert + validation — app/packages/infra/src/program.ts:179-182; app/packages/infra/src/discordDomain.ts:124,150.
- IAM is split into roles-then-policies so the interactions policy can reference the followup function ARN — app/packages/infra/src/iam.ts:8-22; app/packages/infra/src/program.ts:309-326.
- Only ECS TaskDefinitions are declared (family `${game}-server`); no ECS Service exists — app/packages/infra/src/ecs.ts:333-347.
- Tasks are launched on demand by followup via RunTask FARGATE with public IP and propagateTags TASK_DEFINITION — app/packages/lambda/followup/src/handler.ts:127-138.
- Followup refuses to start a game whose family already has a non-stopped task — app/packages/lambda/followup/src/handler.ts:79-86,123-124.
- TLS for https games terminates in a `caddy:2-alpine` sidecar reverse-proxying to localhost:webPort, certs persisted on a per-game EFS access point — app/packages/infra/src/ecs.ts:301-321; app/packages/infra/src/efs.ts:141-161.
- 443/80 ingress is opened only when at least one game is https — app/packages/infra/src/securityGroups.ts:269-279.
- Port visibility: public/omitted → 0.0.0.0/0; 'internal' → VPC CIDR; anything else → no rule (fails closed) — app/packages/infra/src/securityGroups.ts:141-164, 249-264.
- ICMP declarations become SG rules with toPort -1 and are excluded from ECS portMappings and from GAME_PORTS — app/packages/infra/src/securityGroups.ts:221-224; app/packages/infra/src/ecs.ts:269-279; app/packages/infra/src/lambdas.ts:314.
- GAME_PORTS advertises the https marker for https games, else the first public connectable port, falling back to the first connectable port — app/packages/infra/src/lambdas.ts:307-322.
- `${hyveon.network.public-address}` is substituted at deploy time with `${game}.${zone}` — app/packages/infra/src/ecs.ts:118-137.
- `${hyveon.network.public-ipv4}` triggers a sh boot wrapper that queries checkip.amazonaws.com (30×2s) and exits 1 if no valid IPv4 — app/packages/infra/src/envTokenWrapper.ts:65-97; app/packages/infra/src/ecs.ts:281-289.
- pinnedHostname adds a busybox init container that writes an os.hostname() preload, gated by dependsOn SUCCESS and NODE_OPTIONS --require — app/packages/infra/src/hostnameShim.ts:56-92; app/packages/infra/src/ecs.ts:239-262,295-331.
- DNS records for games are never Pulumi-managed; route53.ts only looks up the zone — app/packages/infra/src/route53.ts:8-21,62-69.
- update-dns UPSERTs `${game}.${DOMAIN_NAME}` A record on RUNNING after up to 5×3s IP resolution retries — app/packages/lambda/update-dns/src/handler.ts:71-96,224-234.
- update-dns DELETEs the A record on STOPPED using the current record value and current DNS_TTL — app/packages/lambda/update-dns/src/handler.ts:141-170,235-238.
- The DNS EventBridge rule filters on the deployed cluster ARN and RUNNING/STOPPED only — app/packages/infra/src/lambdas.ts:668-672.
- Watchdog runs on `rate(N minute|minutes)` with singular for 1 — app/packages/infra/src/lambdas.ts:593-601.
- Watchdog idle state is the `idle_checks` ECS task tag; stop at IDLE_CHECKS consecutive idle windows — app/packages/lambda/watchdog/src/handler.ts:146-168,230-254.
- Watchdog treats missing/failed CloudWatch metrics and any health-check invoke failure as active — app/packages/lambda/watchdog/src/handler.ts:94-101,113-144.
- Watchdog never touches DNS; STOPPED event drives deletion — app/packages/lambda/watchdog/src/handler.ts:13-17.
- Health-check Lambda + role + SG exist only when a game declares healthCheck (zero footprint otherwise) — app/packages/infra/src/iam.ts:387-395; app/packages/infra/src/lambdas.ts:529-557; app/packages/infra/src/securityGroups.ts:289-302.
- Health-check host is always the task's private IP from ECS DescribeTasks, never config — app/packages/lambda/health-check/src/handler.ts:53-71.
- Health-check verdicts are fail-active for every inconclusive outcome; reasons never include response values — app/packages/lambda/health-check/src/engine.ts:144-211.
- Health-check handler requires ECS_CLUSTER at module load, but infra gives it only AWS_REGION_ (apparent init crash → permanent fail-active) — app/packages/lambda/health-check/src/handler.ts:39; app/packages/infra/src/lambdas.ts:552.
- Interactions verifies Ed25519 over timestamp+rawBody before reading any config; 401 on any failure — app/packages/lambda/interactions/src/handler.ts:268-280.
- Interactions defers (type 5, ephemeral) and async-invokes followup (InvocationType Event) — app/packages/lambda/interactions/src/handler.ts:227-236,249-258.
- Guild allowlist is enforced before canRun for slash commands — app/packages/lambda/interactions/src/handler.ts:188-191.
- canRun is imported from @hyveon/shared in both interactions and followup (no fork) — app/packages/lambda/interactions/src/handler.ts:20-21; app/packages/lambda/followup/src/handler.ts:24-37.
- Followup re-checks canRun before start/stop/status with a game — app/packages/lambda/followup/src/handler.ts:219-263.
- On start, followup writes PENDING#{taskArn}; update-dns later PATCHes the same interaction and deletes the row — app/packages/lambda/followup/src/handler.ts:187-200; app/packages/lambda/update-dns/src/handler.ts:176-198.
- Discord interactions reach the Lambda through discord.{zone} → CloudFront (CachingDisabled, AllViewerExceptHostHeader) → Function URL — app/packages/infra/src/discordDomain.ts:154-196.
- Function URL needs both InvokeFunctionUrl and InvokeFunction public permissions — app/packages/infra/src/lambdas.ts:487-514.
- Stack outputs `interactionsInvokeUrl`/`discordInteractionsUrl` are the custom domain URL, never the raw Function URL — app/packages/infra/src/program.ts:490,510-511.
- Secrets are created with literal 'placeholder' and ignoreChanges ['secretString']; real values are written by the app via SDK — app/packages/infra/src/secrets.ts:7-21,73,89-91.
- CONFIG#discord seed row is create-only (ignoreChanges ['item']); BASE#discord row is rewritten every deploy — app/packages/infra/src/escapes.ts:10-15,119-172.
- Runs table is NOT Pulumi-managed; runsTableName output computed via resolveRunsTableName — app/packages/infra/src/dynamodb.ts:6-28; app/packages/infra/src/program.ts:505.
- Per-game EFS seeder Lambda is invoked synchronously during apply; re-runs iff sha256(file_seeds) changes; explicit dependsOn on its policy — app/packages/infra/src/escapes.ts:213-262.
- EFS seeder mounts only the first volume at /mnt/efs and rejects traversal / paths outside container_path — app/packages/infra/src/lambdas.ts:739-745; app/packages/lambda/efs-seeder/src/handler.ts:27-49.
- efs_seeder SG has no inline egress; a standalone rule allows only NFS to the EFS SG; `-v2-` namePrefix forces replacement — app/packages/infra/src/securityGroups.ts:33-38,358-424.
- file_manager SG declares empty ingress; runtime operator-IP rules are added by the desktop app — app/packages/infra/src/securityGroups.ts:336-348.
- FileBrowser helper log groups are pre-created because the execution role cannot create log groups — app/packages/infra/src/ecs.ts:49-55,195-206.
- FileBrowser auto-stop is done by EventBridge Scheduler assuming a role limited to ecs:StopTask on cluster tasks — app/packages/infra/src/iam.ts:380-385,571-593.
- All log groups use 7-day retention — app/packages/infra/src/logGroups.ts:12.
- Lambda env uses AWS_REGION_ everywhere; handlers fall back AWS_REGION → AWS_DEFAULT_REGION → us-east-1 — app/packages/infra/src/lambdas.ts:427 etc.; app/packages/lambda/watchdog/src/handler.ts:53-61.
- Lambda bundles are esbuild CJS node24 with @aws-sdk/* external (runtime SDK), efs-seeder bundles everything — app/packages/lambda/buildLambda.mjs:12-27; app/packages/lambda/*/esbuild.config.mjs.
- lambdaBundlesDir has no default; PulumiService must supply it — app/packages/infra/src/lambdas.ts:16-30; app/packages/infra/src/program.ts:51-63.
- Public subnets fixed at 2, carved as /+8 subnets 0 and 1 of the VPC CIDR — app/packages/infra/src/network.ts:46,124-138.

## Cross-scope references

Outbound (this scope calls into):

- `@hyveon/shared` barrel — `DeploymentConfig`, `GameServerConfig`, `GameServerEnvironmentVariable`, `GameServerHealthCheck(Auth)`, `StackOutputs`, `ConnectPort`, `HTTPS_CONNECT_PORT`, `resolveRunsTableName`, `ingressPorts`, `isIcmpProtocol`, `fileManagerLogGroupName`, `HOSTNAME_SHIM_MOUNT_PATH`, `HOSTNAME_SHIM_RESERVED_NAME` (infra); `canRun`, `formatGameStatus`, `renderConnectMessage`, `gameNamesFromEnv`, `familyToGameMap`, `parseGameMapEnv`, `requireEnv`, `getEffectiveDiscordConfig`, `getPublicKey`, `putPending`/`getPending`/`deletePending`, `patchInteractionOriginal`, `getTaskEniId`, `getTaskPrivateIp`, `resolveEniPublicIp`, `DiscordAction`, `DiscordConfig`, `GameStatus` (lambdas).
- `@hyveon/shared/envTokens` subpath — `HYVEON_ENV_TOKENS`, `substituteHyveonToken`, `valueUsesToken` (infra ecs.ts, envTokenWrapper.ts).
- `@hyveon/shared` gameServerValidator `checkPortCollisions` and `GameServerConfig.https`/`visibility` contracts are referenced in docs (securityGroups.ts:124-157).
- External: `@pulumi/aws`, `@pulumi/pulumi` (+ `/automation` PulumiFn), `@noble/ed25519`, AWS SDK v3 clients (ecs, ec2, route-53, cloudwatch, lambda, secrets-manager; dynamodb/secrets-manager transitively via shared), esbuild, Discord webhook API, checkip.amazonaws.com.

Inbound (called by / depends on this scope from outside):

- `@hyveon/desktop-main` `PulumiService` — calls `createInfraProgram(config, {lambdaBundlesDir})`, resolves the bundle dir, reads stack outputs (`StackOutputs`), and must redact `appliedGameServers` (program.ts:8-15, 51-63).
- `@hyveon/desktop-main` `BootstrapService.ensureRunsTable` — creates the runs table outside Pulumi; must match the schema documented in dynamodb.ts:21-28.
- `@hyveon/desktop-main` `RunRecordService` — depends on the runs table existing before first apply (dynamodb.ts:9-14).
- `@hyveon/desktop-main` `DiscordConfigService` — writes real secret values and CONFIG#discord rows that Pulumi ignores (secrets.ts:12-13; escapes.ts:10-12).
- `@hyveon/desktop-main` `DiscordCommandRegistrar` — guild slash-command registration, out of Pulumi (escapes.ts:23-27).
- `@hyveon/desktop-main` `FileManagerService` — registers FileBrowser task definitions at runtime, uses `/ecs/filebrowser-{game}` log groups, `fileManagerSecurityGroupId`, `fileBrowserCredentialSecretArn`, `fileBrowserSchedulerRoleArn` outputs and adds operator-IP ingress to the file_manager SG (ecs.ts:49-55; securityGroups.ts:340-343).
- `@hyveon/desktop-main` `DeploymentConfigService` — the normalising read path ecs.ts expects for https games' `webPort` (ecs.ts:139-145).
- Root `npm run app:build:lambdas` / `desktop:run` — run each package's `esbuild.config.mjs` to produce `dist/handler.cjs` consumed by `bundlePath` (lambdas.ts:230-232).
- `@hyveon/web` add/edit-game wizard — produces the `GameServerConfig` fields (ports/visibility, https/webPort, healthCheck, file_seeds, pinnedHostname, environment tokens) this scope consumes.
- `docs/docs/components/infra.md`, `docs/docs/components/lambdas.md`, `docs/docs/setup.md` (HyveonDeployAll IAM policy) document this scope; `openspec/specs/in-task-tls-termination`, `lambda-runtime-currency`, `game-health-checks` are cited by comments.
