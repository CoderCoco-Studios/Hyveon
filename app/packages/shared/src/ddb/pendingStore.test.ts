import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { deletePending, getPending, putPending } from './pendingStore.js';
import { __resetDocClient } from './client.js';

const ddb = mockClient(DynamoDBDocumentClient);

const TABLE = 'test-discord';
const ARN = 'arn:aws:ecs:us-east-1:123:task/abc';

// @spec DISCORD-PEND-001, DISCORD-PEND-002
describe('putPending', () => {
  beforeEach(() => {
    ddb.reset();
    __resetDocClient();
  });

  it('should write a pending row keyed by the task ARN with a TTL 15 minutes out', async () => {
    ddb.on(PutCommand).resolves({});
    const before = Math.floor(Date.now() / 1000);
    await putPending(TABLE, {
      taskArn: ARN,
      applicationId: 'app1',
      interactionToken: 'tok1',
      userId: 'U1',
      guildId: 'G1',
      game: 'palworld',
      action: 'start',
    });
    const after = Math.floor(Date.now() / 1000);

    const calls = ddb.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    const item = calls[0]!.args[0]!.input.Item!;
    expect(item['pk']).toBe(`PENDING#${ARN}`);
    expect(item['sk']).toBe('PENDING');
    const data = item['data'] as Record<string, unknown>;
    expect(data['applicationId']).toBe('app1');
    expect(data['interactionToken']).toBe('tok1');
    expect(data['game']).toBe('palworld');
    expect(data['action']).toBe('start');

    const ttl = item['expiresAt'] as number;
    // Accept a small window to account for test runtime jitter.
    expect(ttl).toBeGreaterThanOrEqual(before + 15 * 60);
    expect(ttl).toBeLessThanOrEqual(after + 15 * 60 + 2);
  });
});

// @spec DISCORD-PEND-003, DISCORD-PEND-004
describe('getPending', () => {
  beforeEach(() => {
    ddb.reset();
    __resetDocClient();
  });

  it('should return null when no row exists for the ARN', async () => {
    ddb.on(GetCommand).resolves({});
    const result = await getPending(TABLE, ARN);
    expect(result).toBeNull();
  });

  it('should return the stored pending interaction when it has not expired', async () => {
    const futureEpoch = Math.floor(Date.now() / 1000) + 600;
    ddb.on(GetCommand).resolves({
      Item: {
        pk: `PENDING#${ARN}`,
        sk: 'PENDING',
        data: {
          taskArn: ARN,
          applicationId: 'app1',
          interactionToken: 'tok1',
          userId: 'U1',
          guildId: 'G1',
          game: 'palworld',
          action: 'start',
          expiresAt: futureEpoch,
        },
      },
    });
    const result = await getPending(TABLE, ARN);
    expect(result).toMatchObject({
      taskArn: ARN,
      game: 'palworld',
      action: 'start',
    });
    // Clean reads should not delete the row.
    expect(ddb.commandCalls(DeleteCommand)).toHaveLength(0);
  });

  it('should return null and best-effort delete the row when the pending interaction has expired', async () => {
    // expiresAt in the past — Discord interaction tokens are valid for 15m,
    // so anything stale here would be rejected by Discord if we PATCHed it.
    const pastEpoch = Math.floor(Date.now() / 1000) - 10;
    ddb.on(GetCommand).resolves({
      Item: {
        pk: `PENDING#${ARN}`,
        sk: 'PENDING',
        data: {
          taskArn: ARN,
          applicationId: 'app1',
          interactionToken: 'tok1',
          userId: 'U1',
          guildId: 'G1',
          game: 'palworld',
          action: 'start',
          expiresAt: pastEpoch,
        },
      },
    });
    ddb.on(DeleteCommand).resolves({});
    const result = await getPending(TABLE, ARN);
    expect(result).toBeNull();

    // The cleanup is async and fire-and-forget — wait a tick for it to land.
    await new Promise((r) => setImmediate(r));
    const deletes = ddb.commandCalls(DeleteCommand);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.args[0]!.input.Key!['pk']).toBe(`PENDING#${ARN}`);
  });

  it('should not reject the call when the best-effort delete of an expired row fails', async () => {
    const pastEpoch = Math.floor(Date.now() / 1000) - 10;
    ddb.on(GetCommand).resolves({
      Item: {
        pk: `PENDING#${ARN}`,
        sk: 'PENDING',
        data: {
          taskArn: ARN,
          applicationId: 'app1',
          interactionToken: 'tok1',
          userId: 'U1',
          guildId: 'G1',
          game: 'palworld',
          action: 'start',
          expiresAt: pastEpoch,
        },
      },
    });
    ddb.on(DeleteCommand).rejects(new Error('DynamoDB throttled'));
    // Even if the delete throws, the read still resolves to null (not rejects).
    await expect(getPending(TABLE, ARN)).resolves.toBeNull();
  });

  it('should perform a strongly consistent read to avoid races with RunTask', async () => {
    ddb.on(GetCommand).resolves({});
    await getPending(TABLE, ARN);
    const calls = ddb.commandCalls(GetCommand);
    expect(calls[0]!.args[0]!.input.ConsistentRead).toBe(true);
  });
});

describe('deletePending', () => {
  beforeEach(() => {
    ddb.reset();
    __resetDocClient();
  });

  it('should delete the row keyed by the task ARN', async () => {
    ddb.on(DeleteCommand).resolves({});
    await deletePending(TABLE, ARN);
    const calls = ddb.commandCalls(DeleteCommand);
    expect(calls).toHaveLength(1);
    const key = calls[0]!.args[0]!.input.Key!;
    expect(key['pk']).toBe(`PENDING#${ARN}`);
    expect(key['sk']).toBe('PENDING');
  });
});
