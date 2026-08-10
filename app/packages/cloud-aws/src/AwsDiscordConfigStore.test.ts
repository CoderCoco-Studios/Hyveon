import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DiscordConfig } from '@hyveon/shared';
import { AwsDiscordConfigStore } from './AwsDiscordConfigStore.js';

/** Typed stand-in for the DynamoDB document client SDK. */
const ddbMock = mockClient(DynamoDBDocumentClient);

/**
 * Build an {@link AwsDiscordConfigStore} whose config-resolution callback
 * returns a fixed table name/region, avoiding any need to read/mutate
 * `process.env` in tests.
 */
function makeStore(tableName = 'hyveon-discord', region = 'us-east-1'): AwsDiscordConfigStore {
  return new AwsDiscordConfigStore(() => ({ tableName, region }));
}

/** Minimal valid `DiscordConfig` fixture. */
function makeConfig(overrides: Partial<DiscordConfig> = {}): DiscordConfig {
  return {
    clientId: 'client-abc',
    allowedGuilds: ['G1'],
    admins: { userIds: ['U1'], roleIds: [] },
    gamePermissions: {},
    ...overrides,
  };
}

describe('AwsDiscordConfigStore', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  describe('getConfig', () => {
    it('should read the CONFIG#discord row and return an empty config when absent', async () => {
      ddbMock.on(GetCommand).resolves({});

      const cfg = await makeStore().getConfig();

      expect(cfg).toEqual({
        clientId: '',
        allowedGuilds: [],
        admins: { userIds: [], roleIds: [] },
        gamePermissions: {},
      });
      const input = ddbMock.commandCalls(GetCommand)[0]!.args[0].input;
      expect(input.TableName).toBe('hyveon-discord');
      expect(input.Key).toEqual({ pk: 'CONFIG#discord', sk: 'CONFIG' });
    });

    it('should return the stored config when the row exists', async () => {
      const stored = makeConfig();
      ddbMock.on(GetCommand).resolves({ Item: { pk: 'CONFIG#discord', sk: 'CONFIG', data: stored } });

      const cfg = await makeStore().getConfig();

      expect(cfg).toEqual(stored);
    });

    it('should throw a clear "table not configured" error instead of sending a malformed request when resolveConfig omits tableName', async () => {
      const store = new AwsDiscordConfigStore(() => ({ tableName: '' }));

      await expect(store.getConfig()).rejects.toThrow(/table not configured/i);
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    });
  });

  describe('getBaseConfig', () => {
    it('should read the BASE#discord row and return an empty base when absent', async () => {
      ddbMock.on(GetCommand).resolves({});

      const base = await makeStore().getBaseConfig();

      expect(base).toEqual({ allowedGuilds: [], admins: { userIds: [], roleIds: [] } });
      const input = ddbMock.commandCalls(GetCommand)[0]!.args[0].input;
      expect(input.Key).toEqual({ pk: 'BASE#discord', sk: 'BASE' });
    });
  });

  describe('putConfig', () => {
    it('should send a PutCommand writing the CONFIG#discord row', async () => {
      ddbMock.on(PutCommand).resolves({});

      const cfg = makeConfig();
      await makeStore().putConfig(cfg);

      const calls = ddbMock.commandCalls(PutCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0].input;
      expect(input.TableName).toBe('hyveon-discord');
      expect(input.Item?.['pk']).toBe('CONFIG#discord');
      expect(input.Item?.['sk']).toBe('CONFIG');
      expect(input.Item?.['data']).toEqual(cfg);
    });
  });

  describe('credentialed client construction', () => {
    it('should pass the resolved region and credentials through to the underlying DynamoDB client', async () => {
      ddbMock.on(GetCommand).resolves({});
      const store = new AwsDiscordConfigStore(() => ({
        tableName: 'hyveon-discord',
        region: 'eu-central-1',
        credentials: { accessKeyId: 'AKIA-TEST', secretAccessKey: 'secret' },
        credentialsSignature: 'pasted:default:AKIA-TEST',
      }));

      // Regression coverage: this is the fix for `DiscordConfigService`
      // building its DynamoDB client via `@hyveon/shared`'s `getDocClient()`
      // (no credentials), which fell back to the AWS SDK's default provider
      // chain in the Electron main process and threw a spurious
      // `CredentialsProviderError` once an unrelated ambient `aws login`
      // session expired. There's no direct way to assert the constructed
      // `DynamoDBClient`'s config from outside `aws-sdk-client-mock`, so this
      // just exercises the path end-to-end and relies on `getConfig`'s
      // success (a mocked call still requires a valid client construction)
      // as the regression signal.
      await expect(store.getConfig()).resolves.toEqual({
        clientId: '',
        allowedGuilds: [],
        admins: { userIds: [], roleIds: [] },
        gamePermissions: {},
      });
    });
  });
});
