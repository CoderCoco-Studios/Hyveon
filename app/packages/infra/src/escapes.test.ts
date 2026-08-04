import * as aws from '@pulumi/aws';
import type { GameServerConfig } from '@hyveon/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineDiscordTableItems, defineEfsSeederInvocations, escapeResourceOptions } from './escapes.js';
import { installPulumiMocks, promiseOf, type RecordedResource } from './testing/pulumiMocks.js';

// File-level, not per-`describe`: `escapeResourceOptions`'s methods are
// shared exported object properties — a `vi.spyOn` on either in one test
// must not leak into a later one, so every test that spies on either gets a
// fresh unwrapped function.
afterEach(() => {
  vi.restoreAllMocks();
});

/** Finds the single recorded resource with the given Pulumi logical name, failing loudly if there isn't exactly one. */
function findByName(resources: RecordedResource[], name: string): RecordedResource {
  const matches = resources.filter((resource) => resource.name === name);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one recorded resource named "${name}", found ${matches.length}`);
  }
  return matches[0];
}

/** Declares a real (mocked) Discord table, awaiting it before returning — the standard "arrange" step every `defineDiscordTableItems` test needs. */
async function arrangeDiscordTable(provider: aws.Provider): Promise<aws.dynamodb.Table> {
  const table = new aws.dynamodb.Table(
    'hyveon-discord',
    {
      name: 'hyveon-discord',
      billingMode: 'PAY_PER_REQUEST',
      hashKey: 'pk',
      rangeKey: 'sk',
      attributes: [
        { name: 'pk', type: 'S' },
        { name: 'sk', type: 'S' },
      ],
    },
    { provider },
  );
  await promiseOf(table.id);
  return table;
}

describe('defineDiscordTableItems', () => {
  let mocks: ReturnType<typeof installPulumiMocks>;

  beforeEach(() => {
    mocks = installPulumiMocks();
  });

  it('should declare no discordBaseConfigItem when baseAllowedGuilds/baseAdminUserIds/baseAdminRoleIds are all empty', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const discordTable = await arrangeDiscordTable(provider);

    const result = defineDiscordTableItems({
      projectName: 'hyveon',
      provider,
      discordTable,
      baseAllowedGuilds: [],
      baseAdminUserIds: [],
      baseAdminRoleIds: [],
      discordApplicationId: '',
    });

    expect(result.discordBaseConfigItem).toBeUndefined();
  });

  it('should declare discordBaseConfigItem when only baseAdminRoleIds is non-empty, with the BASE#discord row content', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const discordTable = await arrangeDiscordTable(provider);

    const result = defineDiscordTableItems({
      projectName: 'hyveon',
      provider,
      discordTable,
      baseAllowedGuilds: [],
      baseAdminUserIds: [],
      baseAdminRoleIds: ['role-1'],
      discordApplicationId: '',
    });
    expect(result.discordBaseConfigItem).toBeDefined();
    await promiseOf(result.discordBaseConfigItem!.id);

    const item = findByName(mocks.resources, 'hyveon-discord-base-config');
    expect(item.type).toBe('aws:dynamodb/tableItem:TableItem');
    expect(item.inputs.tableName).toBe('hyveon-discord');
    expect(item.inputs.hashKey).toBe('pk');
    expect(item.inputs.rangeKey).toBe('sk');
    expect(JSON.parse(item.inputs.item as string)).toEqual({
      pk: { S: 'BASE#discord' },
      sk: { S: 'BASE' },
      data: {
        M: {
          allowedGuilds: { L: [] },
          admins: { M: { userIds: { L: [] }, roleIds: { L: [{ S: 'role-1' }] } } },
        },
      },
      updatedAt: { N: '0' },
    });
  });

  it('should declare discordBaseConfigItem with the full allowedGuilds/admins lists when every base field is populated', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const discordTable = await arrangeDiscordTable(provider);

    const result = defineDiscordTableItems({
      projectName: 'hyveon',
      provider,
      discordTable,
      baseAllowedGuilds: ['guild-1', 'guild-2'],
      baseAdminUserIds: ['user-1'],
      baseAdminRoleIds: ['role-1', 'role-2'],
      discordApplicationId: '',
    });
    await promiseOf(result.discordBaseConfigItem!.id);

    const item = findByName(mocks.resources, 'hyveon-discord-base-config');
    expect(JSON.parse(item.inputs.item as string)).toEqual({
      pk: { S: 'BASE#discord' },
      sk: { S: 'BASE' },
      data: {
        M: {
          allowedGuilds: { L: [{ S: 'guild-1' }, { S: 'guild-2' }] },
          admins: {
            M: {
              userIds: { L: [{ S: 'user-1' }] },
              roleIds: { L: [{ S: 'role-1' }, { S: 'role-2' }] },
            },
          },
        },
      },
      updatedAt: { N: '0' },
    });
  });

  it('should declare no discordConfigSeedItem when discordApplicationId is empty', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const discordTable = await arrangeDiscordTable(provider);

    const result = defineDiscordTableItems({
      projectName: 'hyveon',
      provider,
      discordTable,
      baseAllowedGuilds: [],
      baseAdminUserIds: [],
      baseAdminRoleIds: [],
      discordApplicationId: '',
    });

    expect(result.discordConfigSeedItem).toBeUndefined();
  });

  it('should declare discordConfigSeedItem with the CONFIG#discord row content when discordApplicationId is set', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const discordTable = await arrangeDiscordTable(provider);

    const result = defineDiscordTableItems({
      projectName: 'hyveon',
      provider,
      discordTable,
      baseAllowedGuilds: [],
      baseAdminUserIds: [],
      baseAdminRoleIds: [],
      discordApplicationId: '123456789012345678',
    });
    expect(result.discordConfigSeedItem).toBeDefined();
    await promiseOf(result.discordConfigSeedItem!.id);

    const item = findByName(mocks.resources, 'hyveon-discord-config-seed');
    expect(item.type).toBe('aws:dynamodb/tableItem:TableItem');
    expect(JSON.parse(item.inputs.item as string)).toEqual({
      pk: { S: 'CONFIG#discord' },
      sk: { S: 'CONFIG' },
      data: {
        M: {
          clientId: { S: '123456789012345678' },
          allowedGuilds: { L: [] },
          admins: { M: { userIds: { L: [] }, roleIds: { L: [] } } },
          gamePermissions: { M: {} },
        },
      },
      updatedAt: { N: '0' },
    });
  });

  it('should declare discordConfigSeedItem via escapeResourceOptions.forDiscordConfigSeedItem, not an equivalent-but-uninspected options object', async () => {
    // Call-site coverage, not just factory-output coverage — see
    // `escapes.ts`'s file doc, the paragraph on `escapeResourceOptions`, for
    // why a test that only calls `forDiscordConfigSeedItem` directly can't
    // catch a future edit that quietly swaps the item's construction call
    // site back to the plain `{ provider }` options already in scope
    // (silently dropping the create-only `ignoreChanges` guard).
    const forSeedItemSpy = vi.spyOn(escapeResourceOptions, 'forDiscordConfigSeedItem');
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const discordTable = await arrangeDiscordTable(provider);

    defineDiscordTableItems({
      projectName: 'hyveon',
      provider,
      discordTable,
      baseAllowedGuilds: [],
      baseAdminUserIds: [],
      baseAdminRoleIds: [],
      discordApplicationId: '123456789012345678',
    });

    expect(forSeedItemSpy).toHaveBeenCalledTimes(1);
    expect(forSeedItemSpy).toHaveBeenCalledWith(provider);
    expect(forSeedItemSpy.mock.results[0].value).toEqual({ provider, ignoreChanges: ['item'] });
  });

  it('should NOT call escapeResourceOptions.forDiscordConfigSeedItem when discordApplicationId is empty (item not declared)', async () => {
    const forSeedItemSpy = vi.spyOn(escapeResourceOptions, 'forDiscordConfigSeedItem');
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const discordTable = await arrangeDiscordTable(provider);

    defineDiscordTableItems({
      projectName: 'hyveon',
      provider,
      discordTable,
      baseAllowedGuilds: [],
      baseAdminUserIds: [],
      baseAdminRoleIds: [],
      discordApplicationId: '',
    });

    expect(forSeedItemSpy).not.toHaveBeenCalled();
  });
});

describe('escapeResourceOptions.forDiscordConfigSeedItem', () => {
  it('should carry ignoreChanges: ["item"] so a re-deploy never reverts an operator-edited CONFIG#discord row', () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const opts = escapeResourceOptions.forDiscordConfigSeedItem(provider);

    expect(opts.ignoreChanges).toEqual(['item']);
    expect(opts.provider).toBe(provider);
  });
});

/** A minimal game-server config with one file seed — the fixture every `defineEfsSeederInvocations` test builds its `gameServers`/`efsSeederFunctions`/`efsSeederPolicies` maps from. */
const SEEDED_GAME: GameServerConfig = {
  image: 'example/echo:latest',
  cpu: 1024,
  memory: 2048,
  ports: [{ container: 1234, protocol: 'tcp' }],
  volumes: [{ name: 'saves', container_path: '/data' }],
  file_seeds: [{ path: '/data/config.yml', content: 'foo: bar' }],
};

describe('defineEfsSeederInvocations', () => {
  let mocks: ReturnType<typeof installPulumiMocks>;

  beforeEach(() => {
    mocks = installPulumiMocks();
  });

  it('should declare no invocations when efsSeederFunctions is empty', () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });

    const result = defineEfsSeederInvocations({
      projectName: 'hyveon',
      provider,
      gameServers: {},
      efsSeederFunctions: {},
      efsSeederPolicies: {},
    });

    expect(result).toEqual({});
  });

  it('should throw when efsSeederFunctions has a game absent from gameServers', () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const fn = new aws.lambda.Function('echo-fn', { role: 'arn:aws:iam::123456789012:role/mock' }, { provider });
    const policy = new aws.iam.RolePolicy('echo-policy', { role: 'mock-role', policy: '{}' }, { provider });

    expect(() =>
      defineEfsSeederInvocations({
        projectName: 'hyveon',
        provider,
        gameServers: {},
        efsSeederFunctions: { echo: fn },
        efsSeederPolicies: { echo: policy },
      }),
    ).toThrow(/no gameServers entry for "echo"/);
  });

  it('should throw when efsSeederFunctions has a game absent from efsSeederPolicies', () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const fn = new aws.lambda.Function('echo-fn', { role: 'arn:aws:iam::123456789012:role/mock' }, { provider });

    expect(() =>
      defineEfsSeederInvocations({
        projectName: 'hyveon',
        provider,
        gameServers: { echo: SEEDED_GAME },
        efsSeederFunctions: { echo: fn },
        efsSeederPolicies: {},
      }),
    ).toThrow(/no efsSeederPolicies entry for "echo"/);
  });

  it('should declare one invocation per game in efsSeederFunctions, with functionName/input/triggers derived from that game\'s config', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const fn = new aws.lambda.Function('hyveon-efs-seeder-echo', { role: 'arn:aws:iam::123456789012:role/mock', name: 'hyveon-efs-seeder-echo' }, { provider });
    const policy = new aws.iam.RolePolicy('hyveon-efs-seeder-echo-policy', { role: 'mock-role', policy: '{}' }, { provider });
    await Promise.all([promiseOf(fn.id), promiseOf(policy.id)]);

    const result = defineEfsSeederInvocations({
      projectName: 'hyveon',
      provider,
      gameServers: { echo: SEEDED_GAME },
      efsSeederFunctions: { echo: fn },
      efsSeederPolicies: { echo: policy },
    });
    expect(Object.keys(result)).toEqual(['echo']);
    await promiseOf(result.echo.id);

    const invocation = findByName(mocks.resources, 'hyveon-efs-seeder-echo-invocation');
    expect(invocation.type).toBe('aws:lambda/invocation:Invocation');
    expect(invocation.inputs.functionName).toBe(await promiseOf(fn.name));
    expect(JSON.parse(invocation.inputs.input as string)).toEqual({
      game: 'echo',
      seeds: SEEDED_GAME.file_seeds,
      container_path: '/data',
    });
    expect(invocation.inputs.triggers).toHaveProperty('seedsHash');
    expect(typeof (invocation.inputs.triggers as Record<string, string>).seedsHash).toBe('string');
  });

  it('should change the seedsHash trigger when file_seeds content changes, and keep it stable when unchanged', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const fn = new aws.lambda.Function('hyveon-efs-seeder-echo', { role: 'arn:aws:iam::123456789012:role/mock' }, { provider });
    const policy = new aws.iam.RolePolicy('hyveon-efs-seeder-echo-policy', { role: 'mock-role', policy: '{}' }, { provider });

    const first = defineEfsSeederInvocations({
      projectName: 'hyveon',
      provider,
      gameServers: { echo: SEEDED_GAME },
      efsSeederFunctions: { echo: fn },
      efsSeederPolicies: { echo: policy },
    });
    await promiseOf(first.echo.id);
    const firstHash = (findByName(mocks.resources, 'hyveon-efs-seeder-echo-invocation').inputs.triggers as Record<string, string>).seedsHash;

    const changedGame: GameServerConfig = { ...SEEDED_GAME, file_seeds: [{ path: '/data/config.yml', content: 'changed: true' }] };
    const second = defineEfsSeederInvocations({
      projectName: 'hyveon',
      provider,
      gameServers: { echo: changedGame },
      efsSeederFunctions: { echo: fn },
      efsSeederPolicies: { echo: policy },
    });
    await promiseOf(second.echo.id);
    const secondHash = (
      mocks.resources.filter((resource) => resource.name === 'hyveon-efs-seeder-echo-invocation').at(-1)!.inputs.triggers as Record<
        string,
        string
      >
    ).seedsHash;

    expect(secondHash).not.toBe(firstHash);

    const third = defineEfsSeederInvocations({
      projectName: 'hyveon',
      provider,
      gameServers: { echo: SEEDED_GAME },
      efsSeederFunctions: { echo: fn },
      efsSeederPolicies: { echo: policy },
    });
    await promiseOf(third.echo.id);
    const thirdHash = (
      mocks.resources.filter((resource) => resource.name === 'hyveon-efs-seeder-echo-invocation').at(-1)!.inputs.triggers as Record<
        string,
        string
      >
    ).seedsHash;
    expect(thirdHash).toBe(firstHash);
  });

  it('should declare each invocation via escapeResourceOptions.forEfsSeederInvocation, not an equivalent-but-uninspected options object', async () => {
    // Call-site coverage, not just factory-output coverage — see
    // `escapes.ts`'s file doc, the paragraph on `escapeResourceOptions`, for
    // why a test that only calls `forEfsSeederInvocation` directly can't
    // catch a future edit that quietly swaps the invocation's construction
    // call site back to the plain `{ provider }` options already in scope
    // (silently dropping the review-mandated `dependsOn` edge).
    const forInvocationSpy = vi.spyOn(escapeResourceOptions, 'forEfsSeederInvocation');
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const fn = new aws.lambda.Function('hyveon-efs-seeder-echo', { role: 'arn:aws:iam::123456789012:role/mock' }, { provider });
    const policy = new aws.iam.RolePolicy('hyveon-efs-seeder-echo-policy', { role: 'mock-role', policy: '{}' }, { provider });

    const result = defineEfsSeederInvocations({
      projectName: 'hyveon',
      provider,
      gameServers: { echo: SEEDED_GAME },
      efsSeederFunctions: { echo: fn },
      efsSeederPolicies: { echo: policy },
    });
    await promiseOf(result.echo.id);

    expect(forInvocationSpy).toHaveBeenCalledTimes(1);
    expect(forInvocationSpy).toHaveBeenCalledWith(provider, policy);
    expect(forInvocationSpy.mock.results[0].value).toEqual({ provider, dependsOn: [policy] });
  });
});

describe('escapeResourceOptions.forEfsSeederInvocation', () => {
  it('should carry dependsOn: [policy] so the invocation waits on the review-mandated IAM policy edge', () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const policy = new aws.iam.RolePolicy('mock-policy', { role: 'mock-role', policy: '{}' }, { provider });

    const opts = escapeResourceOptions.forEfsSeederInvocation(provider, policy);

    expect(opts.dependsOn).toEqual([policy]);
    expect(opts.provider).toBe(provider);
  });
});
