import * as aws from '@pulumi/aws';
import { beforeEach, describe, expect, it } from 'vitest';
import { defineDynamoDb, type DynamoDbResources } from './dynamodb.js';
import { installPulumiMocks, promiseOf, type RecordedResource } from './testing/pulumiMocks.js';

/** Resolves every leaf table `defineDynamoDb` declares, guaranteeing the mock recorder has captured the full set before assertions run (see `pulumiMocks.ts`'s `promiseOf` doc). */
async function runDefineDynamoDb(args: Parameters<typeof defineDynamoDb>[0]): Promise<DynamoDbResources> {
  const result = defineDynamoDb(args);
  await Promise.all([promiseOf(result.discordTable.id), promiseOf(result.runsTable.id), promiseOf(result.auditTable.id)]);
  return result;
}

/** Finds the single recorded resource with the given Pulumi logical name, failing loudly if there isn't exactly one. */
function findByName(resources: RecordedResource[], name: string): RecordedResource {
  const matches = resources.filter((resource) => resource.name === name);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one recorded resource named "${name}", found ${matches.length}`);
  }
  return matches[0];
}

describe('defineDynamoDb', () => {
  let mocks: ReturnType<typeof installPulumiMocks>;

  beforeEach(() => {
    mocks = installPulumiMocks();
  });

  describe('discord table', () => {
    it('should declare pk/sk keys, PAY_PER_REQUEST billing, the expiresAt TTL, and point-in-time recovery disabled', async () => {
      const provider = new aws.Provider('aws', { region: 'us-east-1' });
      await runDefineDynamoDb({ projectName: 'hyveon', auditTableName: '', runsTableName: '', provider });

      const table = findByName(mocks.resources, 'hyveon-discord');
      expect(table.type).toBe('aws:dynamodb/table:Table');
      expect(table.inputs.name).toBe('hyveon-discord');
      expect(table.inputs.billingMode).toBe('PAY_PER_REQUEST');
      expect(table.inputs.hashKey).toBe('pk');
      expect(table.inputs.rangeKey).toBe('sk');
      expect(table.inputs.attributes).toEqual([
        { name: 'pk', type: 'S' },
        { name: 'sk', type: 'S' },
      ]);
      expect(table.inputs.ttl).toEqual({ attributeName: 'expiresAt', enabled: true });
      expect(table.inputs.pointInTimeRecovery).toEqual({ enabled: false });
      expect(table.inputs.tags).toEqual({ Name: 'hyveon-discord' });
    });

    it('should always use "${projectName}-discord" as its name, ignoring any table-name override variables', async () => {
      const provider = new aws.Provider('aws', { region: 'us-east-1' });
      await runDefineDynamoDb({ projectName: 'renamed', auditTableName: 'custom-audit', runsTableName: 'custom-runs', provider });

      const table = findByName(mocks.resources, 'renamed-discord');
      expect(table.inputs.name).toBe('renamed-discord');
    });
  });

  describe('runs table', () => {
    it('should default its name to "${projectName}-runs" when runsTableName is empty', async () => {
      const provider = new aws.Provider('aws', { region: 'us-east-1' });
      await runDefineDynamoDb({ projectName: 'hyveon', auditTableName: '', runsTableName: '', provider });

      const table = findByName(mocks.resources, 'hyveon-runs');
      expect(table.inputs.name).toBe('hyveon-runs');
      expect(table.inputs.tags).toEqual({ Name: 'hyveon-runs' });
    });

    it('should use the configured override name when runsTableName is non-empty, keeping the logical name stable', async () => {
      const provider = new aws.Provider('aws', { region: 'us-east-1' });
      await runDefineDynamoDb({ projectName: 'hyveon', auditTableName: '', runsTableName: 'custom-runs-table', provider });

      const table = findByName(mocks.resources, 'hyveon-runs');
      expect(table.inputs.name).toBe('custom-runs-table');
      expect(table.inputs.tags).toEqual({ Name: 'custom-runs-table' });
    });

    it('should declare pk/sk keys, the status/startedAt attributes, PAY_PER_REQUEST billing, and point-in-time recovery enabled', async () => {
      const provider = new aws.Provider('aws', { region: 'us-east-1' });
      await runDefineDynamoDb({ projectName: 'hyveon', auditTableName: '', runsTableName: '', provider });

      const table = findByName(mocks.resources, 'hyveon-runs');
      expect(table.inputs.billingMode).toBe('PAY_PER_REQUEST');
      expect(table.inputs.hashKey).toBe('pk');
      expect(table.inputs.rangeKey).toBe('sk');
      expect(table.inputs.attributes).toEqual([
        { name: 'pk', type: 'S' },
        { name: 'sk', type: 'S' },
        { name: 'status', type: 'S' },
        { name: 'startedAt', type: 'S' },
      ]);
      expect(table.inputs.pointInTimeRecovery).toEqual({ enabled: true });
    });

    it('should declare the status-index GSI with status as hash key, startedAt as range key, and ALL projection', async () => {
      const provider = new aws.Provider('aws', { region: 'us-east-1' });
      await runDefineDynamoDb({ projectName: 'hyveon', auditTableName: '', runsTableName: '', provider });

      const table = findByName(mocks.resources, 'hyveon-runs');
      expect(table.inputs.globalSecondaryIndexes).toEqual([
        { name: 'status-index', hashKey: 'status', rangeKey: 'startedAt', projectionType: 'ALL' },
      ]);
    });
  });

  describe('audit table', () => {
    it('should default its name to "${projectName}-audit" when auditTableName is empty', async () => {
      const provider = new aws.Provider('aws', { region: 'us-east-1' });
      await runDefineDynamoDb({ projectName: 'hyveon', auditTableName: '', runsTableName: '', provider });

      const table = findByName(mocks.resources, 'hyveon-audit');
      expect(table.inputs.name).toBe('hyveon-audit');
      expect(table.inputs.tags).toEqual({ Name: 'hyveon-audit' });
    });

    it('should use the configured override name when auditTableName is non-empty, keeping the logical name stable', async () => {
      const provider = new aws.Provider('aws', { region: 'us-east-1' });
      await runDefineDynamoDb({ projectName: 'hyveon', auditTableName: 'custom-audit-table', runsTableName: '', provider });

      const table = findByName(mocks.resources, 'hyveon-audit');
      expect(table.inputs.name).toBe('custom-audit-table');
    });

    it('should declare pk/sk keys, PAY_PER_REQUEST billing, no GSI, and point-in-time recovery enabled', async () => {
      const provider = new aws.Provider('aws', { region: 'us-east-1' });
      const result = await runDefineDynamoDb({ projectName: 'hyveon', auditTableName: '', runsTableName: '', provider });

      const table = findByName(mocks.resources, 'hyveon-audit');
      expect(table.inputs.billingMode).toBe('PAY_PER_REQUEST');
      expect(table.inputs.hashKey).toBe('pk');
      expect(table.inputs.rangeKey).toBe('sk');
      expect(table.inputs.attributes).toEqual([
        { name: 'pk', type: 'S' },
        { name: 'sk', type: 'S' },
      ]);
      expect(table.inputs.globalSecondaryIndexes).toBeUndefined();
      expect(table.inputs.pointInTimeRecovery).toEqual({ enabled: true });
      expect(await promiseOf(result.auditTable.name)).toBe('hyveon-audit');
    });
  });
});
