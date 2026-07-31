import { beforeEach, describe, expect, it } from 'vitest';
import { buildStackOutputs, createInfraProgram, defineAll, type InfraProgramOptions } from './program.js';
import { buildTestDeploymentConfig } from './testing/fixtures.js';
import { installPulumiMocks, promiseOf } from './testing/pulumiMocks.js';

/**
 * Literal placeholder `InfraProgramOptions` for every test below.
 * `lambdaBundlesDir` IS exercised — `defineAll` calls `defineLambdas`, which
 * resolves each function's bundle path against it — but a literal string
 * that never touches disk is still sufficient: `pulumi.asset.FileAsset`/
 * `AssetArchive` construction never touches the filesystem (wraps the given
 * path in `Promise.resolve(...)`), and `pulumi.runtime.setMocks`
 * (`testing/pulumiMocks.ts`) intercepts every resource registration before
 * any real engine or upload is involved. See `lambdas.test.ts`'s
 * identically-reasoned `LAMBDA_BUNDLES_DIR` constant.
 */
const TEST_INFRA_PROGRAM_OPTIONS: InfraProgramOptions = { lambdaBundlesDir: '/fixtures/lambda-bundles' };

/**
 * Resolves every leaf resource `defineAll` declares (the network's route
 * table associations, which transitively depend on the VPC/IGW/subnets/route
 * table, plus each independent security group), guaranteeing the mock
 * recorder has captured the entire resource set — including the provider
 * itself, which every one of those resources depends on via `{ provider }`
 * — before assertions run. See `pulumiMocks.ts`'s `promiseOf` doc: this is
 * the same precise-handle pattern `network.test.ts`/`securityGroups.test.ts`
 * use, deliberately NOT the fixed-flush pattern this file used to use (a
 * `setImmediate` guess that only happened to work for a resource graph this
 * small, and risked leaving registrations in flight past the end of a test
 * — see `installPulumiMocks`'s doc on why every test must fully settle
 * before it ends).
 */
async function runDefineAll(config: Parameters<typeof defineAll>[0]): Promise<ReturnType<typeof defineAll>> {
  const result = defineAll(config, TEST_INFRA_PROGRAM_OPTIONS);
  await Promise.all([
    ...result.network.routeTableAssociations.map((association) => promiseOf(association.id)),
    promiseOf(result.securityGroups.gameServers.id),
    promiseOf(result.securityGroups.fileManager.id),
    promiseOf(result.securityGroups.efs.id),
    promiseOf(result.iamRoles.ecsTaskExecutionPolicyAttachment.id),
    promiseOf(result.iamRoles.watchdogLambdaRole.id),
    promiseOf(result.iamRoles.followupLambdaRole.id),
    promiseOf(result.iamRoles.interactionsLambdaRole.id),
    promiseOf(result.iamRoles.dnsUpdaterLambdaRole.id),
    ...Object.values(result.iamRoles.efsSeederRoles).map((role) => promiseOf(role.id)),
    ...result.efs.mountTargets.map((target) => promiseOf(target.id)),
    ...Object.values(result.efs.gameAccessPoints).map((ap) => promiseOf(ap.id)),
    ...Object.values(result.efs.caddyDataAccessPoints).map((ap) => promiseOf(ap.id)),
    promiseOf(result.ecs.cluster.id),
    ...Object.values(result.ecs.logGroups).map((lg) => promiseOf(lg.id)),
    ...Object.values(result.ecs.taskDefinitions).map((td) => promiseOf(td.id)),
    promiseOf(result.dynamoDb.discordTable.id),
    promiseOf(result.dynamoDb.auditTable.id),
    promiseOf(result.secrets.discordBotTokenSecretVersion.id),
    promiseOf(result.secrets.discordPublicKeySecretVersion.id),
    promiseOf(result.route53.zoneId),
    promiseOf(result.lambdas.interactionsFunctionUrl.id),
    promiseOf(result.lambdas.followupFunction.id),
    promiseOf(result.lambdas.watchdogEventBridgePermission.id),
    promiseOf(result.lambdas.dnsUpdaterEventBridgePermission.id),
    ...Object.values(result.lambdas.efsSeederFunctions).map((fn) => promiseOf(fn.id)),
    promiseOf(result.iamPolicies.watchdogLambdaPolicy.id),
    promiseOf(result.iamPolicies.followupLambdaPolicy.id),
    promiseOf(result.iamPolicies.interactionsLambdaPolicy.id),
    promiseOf(result.iamPolicies.dnsUpdaterLambdaPolicy.id),
    ...Object.values(result.iamPolicies.efsSeederPolicies).map((policy) => promiseOf(policy.id)),
    ...(result.discordTableItems.discordBaseConfigItem ? [promiseOf(result.discordTableItems.discordBaseConfigItem.id)] : []),
    ...(result.discordTableItems.discordConfigSeedItem ? [promiseOf(result.discordTableItems.discordConfigSeedItem.id)] : []),
    ...Object.values(result.efsSeederInvocations).map((invocation) => promiseOf(invocation.id)),
    // Awaiting the two alias records is sufficient to settle the whole
    // `discordDomain` chain: both transitively depend (via
    // `viewerCertificate.acmCertificateArn`/`aliases[0].name`) on
    // `distribution`, which itself depends on `certificateValidation` and,
    // through it, `certificate`/`certificateValidationRecord` — see
    // `pulumiMocks.ts`'s `promiseOf` doc on transitive settlement.
    promiseOf(result.discordDomain.aliasRecord.id),
    promiseOf(result.discordDomain.aliasRecordAaaa.id),
  ]);
  return result;
}

describe('createInfraProgram', () => {
  it('should return a zero-argument PulumiFn', () => {
    // No mocks needed: constructing the closure does not construct any
    // resource, so there is nothing for `installPulumiMocks` to intercept.
    const programFn = createInfraProgram(buildTestDeploymentConfig(), TEST_INFRA_PROGRAM_OPTIONS);
    expect(typeof programFn).toBe('function');
    expect(programFn.length).toBe(0);
  });

  it('should resolve to the stack-outputs object when invoked', async () => {
    // Deliberately does not inspect individual resources or await any
    // returned Output field to its underlying value: `buildStackOutputs`
    // (task 3.11) builds every field synchronously off `defineAll`'s
    // resource handles (`.apply(...)` registers a callback but does not
    // await it) — so, same as the closure's previous `void`-returning form,
    // this test's own promise resolution does not depend on when the mocked
    // resource-registration promise chains settle, and needs no completion
    // barrier. `defineAll` and `buildStackOutputs` field derivation are
    // covered field-by-field by the `buildStackOutputs` describe block below.
    installPulumiMocks();
    const programFn = createInfraProgram(buildTestDeploymentConfig(), TEST_INFRA_PROGRAM_OPTIONS);
    const result = await programFn();
    expect(result).toBeDefined();
    expect(Object.keys(result as Record<string, unknown>).sort()).toEqual(
      [
        'awsRegion',
        'ecsClusterName',
        'ecsClusterArn',
        'subnetIds',
        'securityGroupId',
        'fileManagerSecurityGroupId',
        'efsFileSystemId',
        'efsAccessPoints',
        'domainName',
        'gameNames',
        'discordTableName',
        'auditTableName',
        'runsTableName',
        'discordBotTokenSecretArn',
        'discordPublicKeySecretArn',
        'interactionsInvokeUrl',
        'discordInteractionsUrl',
        'appliedGameServers',
      ].sort(),
    );
  });
});

describe('defineAll', () => {
  let mocks: ReturnType<typeof installPulumiMocks>;

  beforeEach(() => {
    mocks = installPulumiMocks();
  });

  it('should declare the full networking, security-group, IAM, EFS, ECS, DynamoDB, secrets, route53, and Lambda resource set', async () => {
    await runDefineAll(buildTestDeploymentConfig({ projectName: 'hyveon' }));

    const types = mocks.resources.map((resource) => resource.type);
    expect(types).toContain('aws:ec2/vpc:Vpc');
    expect(types).toContain('aws:ec2/internetGateway:InternetGateway');
    expect(types.filter((type) => type === 'aws:ec2/subnet:Subnet')).toHaveLength(2);
    expect(types).toContain('aws:ec2/routeTable:RouteTable');
    expect(types.filter((type) => type === 'aws:ec2/routeTableAssociation:RouteTableAssociation')).toHaveLength(2);
    expect(types.filter((type) => type === 'aws:ec2/securityGroup:SecurityGroup')).toHaveLength(3);
    expect(types).toContain('aws:iam/role:Role');
    expect(types).toContain('aws:efs/fileSystem:FileSystem');
    expect(types.filter((type) => type === 'aws:efs/mountTarget:MountTarget')).toHaveLength(2);
    // FIXTURE_GAME_SERVERS: 4 games × 1 volume each = 4 game access points, plus 1 https (delta) cert access point.
    expect(types.filter((type) => type === 'aws:efs/accessPoint:AccessPoint')).toHaveLength(5);
    expect(types).toContain('aws:ecs/cluster:Cluster');
    // 4 ECS per-game log groups + 4 Lambda log groups (interactions/followup/watchdog/dns-updater;
    // FIXTURE_GAME_SERVERS declares no file_seeds, so no efs-seeder log group).
    expect(types.filter((type) => type === 'aws:cloudwatch/logGroup:LogGroup')).toHaveLength(8);
    expect(types.filter((type) => type === 'aws:ecs/taskDefinition:TaskDefinition')).toHaveLength(4);
    expect(types).not.toContain('aws:ecs/service:Service');

    // Task 3.8: DynamoDB tables + Secrets Manager. Only 2 tables now
    // (discord + audit) — the runs table was removed from Pulumi management
    // by the bootstrap-deadlock fix; see `dynamodb.ts`'s file doc.
    expect(types.filter((type) => type === 'aws:dynamodb/table:Table')).toHaveLength(2);
    expect(types.filter((type) => type === 'aws:secretsmanager/secret:Secret')).toHaveLength(2);
    expect(types.filter((type) => type === 'aws:secretsmanager/secretVersion:SecretVersion')).toHaveLength(2);

    // Task 3.9's `route53.zone` lookup itself is a pure data-source — no
    // resource. Task 3.x's `discordDomain` DOES declare Route 53 records (the
    // ACM DNS-validation CNAME + the A/AAAA aliases to CloudFront) — static
    // custom-domain infrastructure, not per-game records, so they do NOT
    // violate the "DNS records are Lambda-managed" invariant (see
    // `discordDomain.ts`'s file doc). Assert the FULL expected record set —
    // by name, not just count — so a sneaky extra record (e.g. a per-game
    // record slipping in) still fails this test.
    const recordNames = mocks.resources.filter((resource) => resource.type === 'aws:route53/record:Record').map((resource) => resource.name);
    expect(recordNames.sort()).toEqual(
      ['hyveon-discord-acm-validation', 'hyveon-discord-alias-a', 'hyveon-discord-alias-aaaa'].sort(),
    );

    // Tasks 3.6/3.7: the five Lambda functions — FIXTURE_GAME_SERVERS has no
    // file_seeds, so only the four non-per-game functions are declared here.
    expect(types.filter((type) => type === 'aws:lambda/function:Function')).toHaveLength(4);
    expect(types).toContain('aws:lambda/functionUrl:FunctionUrl');
    expect(types.filter((type) => type === 'aws:cloudwatch/eventRule:EventRule')).toHaveLength(2);

    // Task 3.5's other half: the five inline IAM policies (no efs-seeder policy for this fixture).
    expect(types.filter((type) => type === 'aws:iam/rolePolicy:RolePolicy')).toHaveLength(4);

    // Task 3.10: no table item/invocation for this fixture — buildTestDeploymentConfig's
    // defaults have empty base-allowlist/admin arrays, an empty discordApplicationId,
    // and FIXTURE_GAME_SERVERS declares no file_seeds.
    expect(types).not.toContain('aws:dynamodb/tableItem:TableItem');
    expect(types).not.toContain('aws:lambda/invocation:Invocation');

    // Task 3.x: the Discord custom domain — one certificate, one validation, one distribution.
    expect(types.filter((type) => type === 'aws:acm/certificate:Certificate')).toHaveLength(1);
    expect(types.filter((type) => type === 'aws:acm/certificateValidation:CertificateValidation')).toHaveLength(1);
    expect(types.filter((type) => type === 'aws:cloudfront/distribution:Distribution')).toHaveLength(1);

    // The distribution's origin must be the REAL interactions Function URL's
    // host (mocked by `pulumiMocks.ts`'s `RESOURCE_STATE_MOCKS` entry for
    // `aws:lambda/functionUrl:FunctionUrl`) — the one assertion that would
    // catch the distribution being wired to the wrong Lambda's URL.
    const distribution = mocks.resources.find((resource) => resource.type === 'aws:cloudfront/distribution:Distribution');
    const origins = distribution?.inputs.origins as Array<Record<string, unknown>>;
    expect(origins[0].domainName).toBe('mock-function-url.lambda-url.us-east-1.on.aws');

    const names = mocks.resources.map((resource) => resource.name);
    expect(names).toContain('hyveon-vpc');
    expect(names).toContain('hyveon-sg');
    expect(names).toContain('hyveon-filemgr-sg');
    expect(names).toContain('hyveon-efs-sg');
    expect(names).toContain('hyveon-saves');
    expect(names).toContain('hyveon-cluster');
    expect(names).toContain('hyveon-discord');
    // No 'hyveon-runs' resource any more — the runs table is bootstrap-
    // managed (AWS SDK), not a Pulumi resource; see `dynamodb.ts`'s file doc.
    expect(names).not.toContain('hyveon-runs');
    expect(names).toContain('hyveon-audit');
    expect(names).toContain('hyveon-discord-bot-token');
    expect(names).toContain('hyveon-discord-public-key');
    expect(names).toContain('hyveon-interactions');
    expect(names).toContain('hyveon-followup');
    expect(names).toContain('hyveon-watchdog');
    expect(names).toContain('hyveon-dns-updater');
    expect(names).toContain('hyveon-discord-cert');
    expect(names).toContain('hyveon-discord-cf');
  });

  it('should wire the interactions/followup/dns-updater Lambdas to the real discord table name, secret ARN, and hosted-zone id', async () => {
    const result = await runDefineAll(buildTestDeploymentConfig({ projectName: 'hyveon' }));

    const discordTableName = await promiseOf(result.dynamoDb.discordTable.name);
    const publicKeySecretArn = await promiseOf(result.secrets.discordPublicKeySecret.arn);
    const zoneId = await promiseOf(result.route53.zoneId);

    const interactionsFn = mocks.resources.find((resource) => resource.name === 'hyveon-interactions');
    const interactionsVars = (interactionsFn?.inputs.environment as { variables: Record<string, unknown> }).variables;
    expect(interactionsVars.TABLE_NAME).toBe(discordTableName);
    expect(interactionsVars.DISCORD_PUBLIC_KEY_SECRET_ARN).toBe(publicKeySecretArn);

    const dnsUpdaterFn = mocks.resources.find((resource) => resource.name === 'hyveon-dns-updater');
    const dnsUpdaterVars = (dnsUpdaterFn?.inputs.environment as { variables: Record<string, unknown> }).variables;
    expect(dnsUpdaterVars.TABLE_NAME).toBe(discordTableName);
    expect(dnsUpdaterVars.HOSTED_ZONE_ID).toBe(zoneId);
  });

  it('should wire the interactions Lambda policy and dns-updater Lambda policy to the real discord table ARN and hosted-zone id', async () => {
    const result = await runDefineAll(buildTestDeploymentConfig({ projectName: 'hyveon' }));

    const discordTableArn = await promiseOf(result.dynamoDb.discordTable.arn);
    const zoneId = await promiseOf(result.route53.zoneId);

    const interactionsPolicy = mocks.resources.find((resource) => resource.name === 'hyveon-interactions-lambda-policy');
    const interactionsStatements = (JSON.parse(interactionsPolicy?.inputs.policy as string) as { Statement: Array<Record<string, unknown>> })
      .Statement;
    expect(interactionsStatements).toContainEqual({ Effect: 'Allow', Action: ['dynamodb:GetItem'], Resource: discordTableArn });

    const dnsUpdaterPolicy = mocks.resources.find((resource) => resource.name === 'hyveon-dns-updater-lambda-policy');
    const dnsUpdaterStatements = (JSON.parse(dnsUpdaterPolicy?.inputs.policy as string) as { Statement: Array<Record<string, unknown>> })
      .Statement;
    expect(dnsUpdaterStatements).toContainEqual({
      Effect: 'Allow',
      Action: ['route53:ChangeResourceRecordSets', 'route53:ListResourceRecordSets', 'route53:GetChange'],
      Resource: [`arn:aws:route53:::hostedzone/${zoneId}`, 'arn:aws:route53:::change/*'],
    });
  });

  it('should declare the discordBaseConfigItem and discordConfigSeedItem when baseAllowedGuilds and discordApplicationId are configured', async () => {
    const result = await runDefineAll(
      buildTestDeploymentConfig({ projectName: 'hyveon', baseAllowedGuilds: ['guild-1'], discordApplicationId: '123456789012345678' }),
    );

    expect(result.discordTableItems.discordBaseConfigItem).toBeDefined();
    expect(result.discordTableItems.discordConfigSeedItem).toBeDefined();
    const types = mocks.resources.map((resource) => resource.type);
    expect(types.filter((type) => type === 'aws:dynamodb/tableItem:TableItem')).toHaveLength(2);
  });

  it('should declare one efs-seeder invocation wired to the real seeder function name for a game with file_seeds', async () => {
    const gameServersWithSeeds = {
      ...buildTestDeploymentConfig({ projectName: 'hyveon' }).gameServers,
      echo: {
        image: 'example/echo:latest',
        cpu: 1024,
        memory: 2048,
        ports: [{ container: 1234, protocol: 'tcp' }],
        volumes: [{ name: 'saves', container_path: '/data' }],
        file_seeds: [{ path: '/data/config.yml', content: 'foo: bar' }],
      },
    };
    const result = await runDefineAll(buildTestDeploymentConfig({ projectName: 'hyveon', gameServers: gameServersWithSeeds }));

    expect(Object.keys(result.efsSeederInvocations)).toEqual(['echo']);
    const invocation = mocks.resources.find((resource) => resource.name === 'hyveon-efs-seeder-echo-invocation');
    expect(invocation?.type).toBe('aws:lambda/invocation:Invocation');
    expect(invocation?.inputs.functionName).toBe(await promiseOf(result.lambdas.efsSeederFunctions.echo.name));
  });

  it('should construct the AWS provider with the region from config.awsRegion', async () => {
    await runDefineAll(buildTestDeploymentConfig({ awsRegion: 'eu-west-1' }));

    const provider = mocks.resources.find((resource) => resource.type === 'pulumi:providers:aws');
    expect(provider?.inputs.region).toBe('eu-west-1');
  });

  it('should apply the fixed Project=hyveon default tag via the provider regardless of projectName', async () => {
    await runDefineAll(buildTestDeploymentConfig({ projectName: 'renamed-project' }));

    // Provider resources serialize their config as flat, JSON-stringified
    // string properties under the mock protocol (confirmed empirically),
    // unlike regular resources' nested-object inputs — hence the parse.
    const provider = mocks.resources.find((resource) => resource.type === 'pulumi:providers:aws');
    expect(JSON.parse(provider?.inputs.defaultTags as string)).toEqual({ tags: { Project: 'hyveon' } });

    // Resource *naming* does follow the (renamed) projectName, unlike the tag value above.
    const names = mocks.resources.map((resource) => resource.name);
    expect(names).toContain('renamed-project-vpc');
  });

  it('should wire the efs security group ingress to the game-servers and file-manager group ids', async () => {
    const result = await runDefineAll(buildTestDeploymentConfig());

    const efsSg = mocks.resources.find((resource) => resource.name === 'hyveon-efs-sg');
    expect(efsSg?.inputs.ingress).toEqual([
      {
        description: 'NFS from game servers',
        fromPort: 2049,
        toPort: 2049,
        protocol: 'tcp',
        securityGroups: [
          await promiseOf(result.securityGroups.gameServers.id),
          await promiseOf(result.securityGroups.fileManager.id),
        ],
      },
    ]);
  });

  it('should wire each mount target to the efs security group id and each task definition to the ecs task-execution role arn', async () => {
    const result = await runDefineAll(buildTestDeploymentConfig());

    const efsSecurityGroupId = await promiseOf(result.securityGroups.efs.id);
    for (const target of mocks.resources.filter((resource) => resource.type === 'aws:efs/mountTarget:MountTarget')) {
      expect(target.inputs.securityGroups).toEqual([efsSecurityGroupId]);
    }

    const executionRoleArn = await promiseOf(result.iamRoles.ecsTaskExecutionRole.arn);
    const alphaTaskDef = mocks.resources.find((resource) => resource.name === 'alpha-server');
    expect(alphaTaskDef?.inputs.executionRoleArn).toBe(executionRoleArn);

    const alphaAccessPointId = await promiseOf(result.efs.gameAccessPoints['alpha-saves'].id);
    expect(alphaTaskDef?.inputs.volumes).toEqual([
      {
        name: 'alpha-saves',
        efsVolumeConfiguration: {
          fileSystemId: await promiseOf(result.efs.fileSystem.id),
          transitEncryption: 'ENABLED',
          authorizationConfig: { accessPointId: alphaAccessPointId, iam: 'DISABLED' },
        },
      },
    ]);
  });
});

describe('buildStackOutputs', () => {
  beforeEach(() => {
    installPulumiMocks();
  });

  it('should populate every StackOutputs field from its documented source resource', async () => {
    const config = buildTestDeploymentConfig({ projectName: 'hyveon', hostedZoneName: 'example.com', awsRegion: 'us-east-1' });
    const resources = await runDefineAll(config);
    const outputs = buildStackOutputs(resources, config);

    expect(outputs.awsRegion).toBe('us-east-1');
    expect(await promiseOf(outputs.ecsClusterName)).toBe(await promiseOf(resources.ecs.cluster.name));
    expect(await promiseOf(outputs.ecsClusterArn)).toBe(await promiseOf(resources.ecs.cluster.arn));
    expect(await promiseOf(outputs.subnetIds)).toEqual(
      await Promise.all(resources.network.publicSubnets.map((subnet) => promiseOf(subnet.id))),
    );
    expect(await promiseOf(outputs.securityGroupId)).toBe(await promiseOf(resources.securityGroups.gameServers.id));
    expect(await promiseOf(outputs.fileManagerSecurityGroupId)).toBe(await promiseOf(resources.securityGroups.fileManager.id));
    expect(await promiseOf(outputs.efsFileSystemId)).toBe(await promiseOf(resources.efs.fileSystem.id));

    // `efsAccessPoints` is keyed by game, one entry per game's FIRST volume
    // only — not every `(game, volume)` pair `efs.gameAccessPoints` holds.
    const expectedAccessPoints: Record<string, string> = {};
    for (const [game, gameConfig] of Object.entries(config.gameServers)) {
      const key = `${game}-${gameConfig.volumes[0].name}`;
      expectedAccessPoints[game] = await promiseOf(resources.efs.gameAccessPoints[key].id);
    }
    expect(await promiseOf(outputs.efsAccessPoints)).toEqual(expectedAccessPoints);

    expect(outputs.domainName).toBe('example.com');
    expect(outputs.gameNames).toEqual(Object.keys(config.gameServers).sort());
    expect(await promiseOf(outputs.discordTableName)).toBe(await promiseOf(resources.dynamoDb.discordTable.name));
    expect(await promiseOf(outputs.auditTableName)).toBe(await promiseOf(resources.dynamoDb.auditTable.name));
    // `runsTableName` is a plain config echo now (the runs table is no
    // longer a Pulumi resource — see `dynamodb.ts`'s file doc), so it's
    // compared against the resolved value directly rather than a resource
    // handle, unlike every other table-name assertion in this test.
    expect(outputs.runsTableName).toBe(`${config.projectName}-runs`);
    expect(await promiseOf(outputs.discordBotTokenSecretArn)).toBe(await promiseOf(resources.secrets.discordBotTokenSecret.arn));
    expect(await promiseOf(outputs.discordPublicKeySecretArn)).toBe(await promiseOf(resources.secrets.discordPublicKeySecret.arn));

    const expectedCustomDomainUrl = `https://${await promiseOf(resources.discordDomain.aliasRecord.name)}/`;
    expect(await promiseOf(outputs.interactionsInvokeUrl)).toBe(expectedCustomDomainUrl);
    expect(await promiseOf(outputs.discordInteractionsUrl)).toBe(expectedCustomDomainUrl);

    expect(outputs.appliedGameServers).toEqual(config.gameServers);
  });

  it('should resolve interactionsInvokeUrl and discordInteractionsUrl to the discord custom domain, not the raw Lambda Function URL', async () => {
    const config = buildTestDeploymentConfig({ hostedZoneName: 'example.com' });
    const resources = await runDefineAll(config);
    const outputs = buildStackOutputs(resources, config);

    const rawFunctionUrl = await promiseOf(resources.lambdas.interactionsFunctionUrl.functionUrl);
    const invokeUrl = await promiseOf(outputs.interactionsInvokeUrl);
    const interactionsUrl = await promiseOf(outputs.discordInteractionsUrl);

    expect(invokeUrl).toBe('https://discord.example.com/');
    expect(interactionsUrl).toBe('https://discord.example.com/');
    expect(invokeUrl).not.toBe(rawFunctionUrl);
    expect(interactionsUrl).not.toBe(rawFunctionUrl);
  });

  it('should resolve auditTableName and runsTableName to the resolved (project-prefixed) name, not the raw config override', async () => {
    const config = buildTestDeploymentConfig({ projectName: 'hyveon', auditTableName: '', runsTableName: '' });
    const resources = await runDefineAll(config);
    const outputs = buildStackOutputs(resources, config);

    expect(await promiseOf(outputs.auditTableName)).toBe('hyveon-audit');
    expect(outputs.runsTableName).toBe('hyveon-runs');
  });

  it('should resolve runsTableName to the configured override, not the project-prefixed default, when one is set', async () => {
    const config = buildTestDeploymentConfig({ projectName: 'hyveon', runsTableName: 'custom-runs-table' });
    const resources = await runDefineAll(config);
    const outputs = buildStackOutputs(resources, config);

    expect(outputs.runsTableName).toBe('custom-runs-table');
  });

  it('should throw when a game name in config.gameServers has no matching efs.gameAccessPoints entry', async () => {
    const config = buildTestDeploymentConfig({
      gameServers: { orphan: { image: 'x', cpu: 512, memory: 512, ports: [], volumes: [{ name: 'saves', container_path: '/data' }] } },
    });
    const resources = await runDefineAll(config);
    // Simulate drift AFTER the resource graph has fully settled (never leave
    // an unawaited mock registration in flight past the end of a test — see
    // `pulumiMocks.ts`'s doc): `resources.efs.gameAccessPoints` is a plain
    // `Record`, not a resource, so mutating it post-settlement is safe.
    resources.efs.gameAccessPoints = {};

    expect(() => buildStackOutputs(resources, config)).toThrow(/no efs\.gameAccessPoints entry for "orphan-saves"/);
  });
});
