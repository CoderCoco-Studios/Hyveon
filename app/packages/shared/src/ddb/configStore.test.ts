import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { getBaseDiscordConfig, getDiscordConfig, getEffectiveDiscordConfig, putDiscordConfig } from './configStore.js';
import { __resetDocClient } from './client.js';

const ddb = mockClient(DynamoDBDocumentClient);

const TABLE = 'test-discord';

// @spec DISCORD-CFG-001, DISCORD-CFG-004
describe('getDiscordConfig', () => {
  beforeEach(() => {
    ddb.reset();
    __resetDocClient();
  });

  it('should return an empty config when the row is missing so a fresh deploy still boots', async () => {
    ddb.on(GetCommand).resolves({});
    const cfg = await getDiscordConfig(TABLE);
    expect(cfg).toEqual({
      clientId: '',
      allowedGuilds: [],
      admins: { userIds: [], roleIds: [] },
      gamePermissions: {},
    });
  });

  it('should parse a well-formed stored config verbatim', async () => {
    ddb.on(GetCommand).resolves({
      Item: {
        pk: 'CONFIG#discord',
        sk: 'CONFIG',
        data: {
          clientId: 'abc123',
          allowedGuilds: ['G1', 'G2'],
          admins: { userIds: ['U1'], roleIds: ['R1'] },
          gamePermissions: {
            palworld: { userIds: ['U2'], roleIds: [], actions: ['start'] },
          },
        },
      },
    });
    const cfg = await getDiscordConfig(TABLE);
    expect(cfg.clientId).toBe('abc123');
    expect(cfg.allowedGuilds).toEqual(['G1', 'G2']);
    expect(cfg.admins).toEqual({ userIds: ['U1'], roleIds: ['R1'] });
    expect(cfg.gamePermissions.palworld).toEqual({
      userIds: ['U2'],
      roleIds: [],
      actions: ['start'],
    });
  });

  it('should sanitize malformed stored data instead of throwing', async () => {
    ddb.on(GetCommand).resolves({
      Item: {
        pk: 'CONFIG#discord',
        sk: 'CONFIG',
        data: {
          clientId: 42,
          allowedGuilds: 'not-an-array',
          admins: { userIds: [null, 'U1'] },
          gamePermissions: {
            palworld: { userIds: 'nope', roleIds: ['R1'], actions: ['start', 'invalid'] },
          },
        },
      },
    });
    const cfg = await getDiscordConfig(TABLE);
    expect(cfg.clientId).toBe('');
    expect(cfg.allowedGuilds).toEqual([]);
    expect(cfg.admins.userIds).toEqual(['U1']);
    expect(cfg.gamePermissions.palworld).toEqual({
      userIds: [],
      roleIds: ['R1'],
      actions: ['start'],
    });
  });

  it('should drop prototype-pollution game keys on read', async () => {
    ddb.on(GetCommand).resolves({
      Item: {
        data: {
          gamePermissions: {
            __proto__: { userIds: ['attacker'], roleIds: [], actions: ['start'] },
            palworld: { userIds: [], roleIds: [], actions: ['start'] },
          },
        },
      },
    });
    const cfg = await getDiscordConfig(TABLE);
    expect(Object.keys(cfg.gamePermissions)).toEqual(['palworld']);
  });

  it('should issue a strongly consistent read for config', async () => {
    ddb.on(GetCommand).resolves({});
    await getDiscordConfig(TABLE);
    const calls = ddb.commandCalls(GetCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0]!.input.ConsistentRead).toBe(true);
  });
});

// @spec DISCORD-CFG-002, DISCORD-CFG-004
describe('getBaseDiscordConfig', () => {
  beforeEach(() => {
    ddb.reset();
    __resetDocClient();
  });

  it('should return an empty base when the BASE#discord row is absent', async () => {
    ddb.on(GetCommand).resolves({});
    const base = await getBaseDiscordConfig(TABLE);
    expect(base).toEqual({ allowedGuilds: [], admins: { userIds: [], roleIds: [] } });
  });

  it('should parse allowedGuilds and admins from a stored base row', async () => {
    ddb.on(GetCommand).resolves({
      Item: {
        pk: 'BASE#discord',
        sk: 'BASE',
        data: {
          allowedGuilds: ['G-base'],
          admins: { userIds: ['U-base'], roleIds: ['R-base'] },
        },
      },
    });
    const base = await getBaseDiscordConfig(TABLE);
    expect(base.allowedGuilds).toEqual(['G-base']);
    expect(base.admins).toEqual({ userIds: ['U-base'], roleIds: ['R-base'] });
  });

  it('should sanitize malformed base data without throwing', async () => {
    ddb.on(GetCommand).resolves({
      Item: {
        pk: 'BASE#discord',
        sk: 'BASE',
        data: { allowedGuilds: 'not-an-array', admins: null },
      },
    });
    const base = await getBaseDiscordConfig(TABLE);
    expect(base.allowedGuilds).toEqual([]);
    expect(base.admins).toEqual({ userIds: [], roleIds: [] });
  });

  it('should issue a strongly consistent read for the base row', async () => {
    ddb.on(GetCommand).resolves({});
    await getBaseDiscordConfig(TABLE);
    const calls = ddb.commandCalls(GetCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0]!.input.ConsistentRead).toBe(true);
  });
});

// @spec DISCORD-CFG-003
describe('getEffectiveDiscordConfig', () => {
  beforeEach(() => {
    ddb.reset();
    __resetDocClient();
  });

  it('should merge base and dynamic guild lists without duplicates', async () => {
    ddb
      .on(GetCommand, { Key: { pk: 'CONFIG#discord', sk: 'CONFIG' } })
      .resolves({
        Item: { data: { clientId: 'c1', allowedGuilds: ['G1', 'G-shared'], admins: { userIds: [], roleIds: [] }, gamePermissions: {} } },
      })
      .on(GetCommand, { Key: { pk: 'BASE#discord', sk: 'BASE' } })
      .resolves({
        Item: { data: { allowedGuilds: ['G-base', 'G-shared'], admins: { userIds: [], roleIds: [] } } },
      });
    const cfg = await getEffectiveDiscordConfig(TABLE);
    expect(cfg.allowedGuilds).toEqual(expect.arrayContaining(['G1', 'G-base', 'G-shared']));
    expect(cfg.allowedGuilds).toHaveLength(3);
  });

  it('should merge base and dynamic admin lists without duplicates', async () => {
    ddb
      .on(GetCommand, { Key: { pk: 'CONFIG#discord', sk: 'CONFIG' } })
      .resolves({
        Item: { data: { clientId: '', allowedGuilds: [], admins: { userIds: ['U1'], roleIds: ['R-shared'] }, gamePermissions: {} } },
      })
      .on(GetCommand, { Key: { pk: 'BASE#discord', sk: 'BASE' } })
      .resolves({
        Item: { data: { allowedGuilds: [], admins: { userIds: ['U-base'], roleIds: ['R-shared'] } } },
      });
    const cfg = await getEffectiveDiscordConfig(TABLE);
    expect(cfg.admins.userIds).toEqual(expect.arrayContaining(['U1', 'U-base']));
    expect(cfg.admins.userIds).toHaveLength(2);
    expect(cfg.admins.roleIds).toEqual(['R-shared']);
  });

  it('should preserve dynamic gamePermissions and clientId in the effective config', async () => {
    ddb
      .on(GetCommand, { Key: { pk: 'CONFIG#discord', sk: 'CONFIG' } })
      .resolves({
        Item: {
          data: {
            clientId: 'my-client',
            allowedGuilds: [],
            admins: { userIds: [], roleIds: [] },
            gamePermissions: { palworld: { userIds: ['U1'], roleIds: [], actions: ['start'] } },
          },
        },
      })
      .on(GetCommand, { Key: { pk: 'BASE#discord', sk: 'BASE' } })
      .resolves({});
    const cfg = await getEffectiveDiscordConfig(TABLE);
    expect(cfg.clientId).toBe('my-client');
    expect(cfg.gamePermissions).toEqual({ palworld: { userIds: ['U1'], roleIds: [], actions: ['start'] } });
  });
});

// @spec DISCORD-CFG-001
describe('putDiscordConfig', () => {
  beforeEach(() => {
    ddb.reset();
    __resetDocClient();
  });

  it('should write the config under the fixed partition key', async () => {
    ddb.on(PutCommand).resolves({});
    await putDiscordConfig(TABLE, {
      clientId: 'abc',
      allowedGuilds: ['G1'],
      admins: { userIds: [], roleIds: [] },
      gamePermissions: {},
    });
    const calls = ddb.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    const item = calls[0]!.args[0]!.input.Item!;
    expect(item['pk']).toBe('CONFIG#discord');
    expect(item['sk']).toBe('CONFIG');
    expect(item['data']).toMatchObject({ clientId: 'abc', allowedGuilds: ['G1'] });
    expect(typeof item['updatedAt']).toBe('number');
  });
});
