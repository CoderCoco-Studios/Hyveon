import { describe, it, expect, vi } from 'vitest';
import {
  START_LEASE_TTL_SECONDS,
  startWithLease,
  type StartLeasePut,
  type StartWithLeaseOptions,
} from './startLease.js';

const NOW_MS = 1_700_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

/** A `put` seam that records each request and behaves per the supplied callback (1-based call number). */
function fakePut(behaviour: (call: number) => unknown = () => ({})) {
  const inputs: Array<Record<string, unknown>> = [];
  const put: StartLeasePut = async (input) => {
    inputs.push({ ...input });
    return behaviour(inputs.length);
  };
  return { put, inputs };
}

/** Builds the SDK's condition-failure error shape. */
const conditionFailure = () => Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });

/** Default options for a clean first-time start, with per-test overrides. */
const base = (
  put: StartLeasePut,
  over: Partial<StartWithLeaseOptions<string>> = {},
): StartWithLeaseOptions<string> => ({
  put,
  tableName: 'tbl',
  game: 'palworld',
  now: () => NOW_MS,
  findRunning: async () => false,
  launch: async () => ({ launched: true, value: 'arn-1' }),
  ...over,
});

const throwingLaunch = async (): Promise<{ launched: boolean; value: string }> => {
  throw new Error('boom');
};

describe('startWithLease', () => {
  // @spec RT-TASK-LAUNCH-010, RT-TASK-LAUNCH-015, RT-TASK-LAUNCH-016
  it('should acquire a conditional lease on LAUNCH#{game}/LOCK that expires 120s out', async () => {
    const { put, inputs } = fakePut();
    const out = await startWithLease(base(put));
    expect(out).toEqual({ status: 'started', value: 'arn-1' });
    expect(START_LEASE_TTL_SECONDS).toBe(120);
    expect(inputs[0]).toMatchObject({
      TableName: 'tbl',
      Item: { pk: 'LAUNCH#palworld', sk: 'LOCK', expiresAt: NOW_S + 120 },
      ConditionExpression: 'attribute_not_exists(pk) OR expiresAt < :now',
      ExpressionAttributeValues: { ':now': NOW_S },
    });
  });

  // @spec RT-TASK-LAUNCH-010, RT-TASK-LAUNCH-015, RT-TASK-LAUNCH-016
  it('should report in-progress and never check or launch when the lease is held', async () => {
    const { put } = fakePut(() => {
      throw conditionFailure();
    });
    const findRunning = vi.fn(async () => false);
    const launch = vi.fn();
    const out = await startWithLease(base(put, { findRunning, launch }));
    expect(out).toEqual({ status: 'in-progress' });
    expect(findRunning).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  // @spec RT-TASK-LAUNCH-010, RT-TASK-LAUNCH-015, RT-TASK-LAUNCH-016
  it('should fail closed when DynamoDB errors during acquisition', async () => {
    const { put } = fakePut(() => {
      throw new Error('throttled');
    });
    const launch = vi.fn();
    await expect(startWithLease(base(put, { launch }))).rejects.toThrow('throttled');
    expect(launch).not.toHaveBeenCalled();
  });

  // @spec RT-TASK-LAUNCH-010, RT-TASK-LAUNCH-015, RT-TASK-LAUNCH-016
  it('should report already-running, skip launch, and release the lease when a task exists', async () => {
    const { put, inputs } = fakePut();
    const launch = vi.fn();
    const out = await startWithLease(base(put, { findRunning: async () => true, launch }));
    expect(out).toEqual({ status: 'already-running' });
    expect(launch).not.toHaveBeenCalled();
    expect(inputs[1]).toMatchObject({ Item: { pk: 'LAUNCH#palworld', sk: 'LOCK', expiresAt: 0 } });
    expect(inputs[1]!['ConditionExpression']).toBeUndefined();
  });

  // @spec RT-TASK-LAUNCH-010, RT-TASK-LAUNCH-015, RT-TASK-LAUNCH-016
  it('should fail closed (rethrow, no launch) when the running-task pre-check errors', async () => {
    const { put, inputs } = fakePut();
    const launch = vi.fn();
    const findRunning = async (): Promise<boolean> => {
      throw new Error('ListTasks denied');
    };
    await expect(startWithLease(base(put, { findRunning, launch }))).rejects.toThrow('ListTasks denied');
    expect(launch).not.toHaveBeenCalled();
    expect(inputs).toHaveLength(2);
  });

  // @spec RT-TASK-LAUNCH-010, RT-TASK-LAUNCH-015, RT-TASK-LAUNCH-016
  it('should hand launch a client token equal to the lease id and keep the lease after success', async () => {
    const { put, inputs } = fakePut();
    const launch = vi.fn(async (_token: string) => ({ launched: true, value: 'arn' }));
    await startWithLease(base(put, { launch }));
    const token = launch.mock.calls[0]![0];
    expect(token).toBe((inputs[0]!['Item'] as Record<string, unknown>)['leaseId']);
    expect(token.length).toBeLessThanOrEqual(64);
    expect(inputs).toHaveLength(1);
  });

  // @spec RT-TASK-LAUNCH-010, RT-TASK-LAUNCH-015, RT-TASK-LAUNCH-016
  it('should release the lease when launch reports failure or throws', async () => {
    const failed = fakePut();
    await startWithLease(base(failed.put, { launch: async () => ({ launched: false, value: 'x' }) }));
    expect(failed.inputs[1]).toMatchObject({ Item: { expiresAt: 0 } });

    const thrown = fakePut();
    await expect(startWithLease(base(thrown.put, { launch: throwingLaunch }))).rejects.toThrow('boom');
    expect(thrown.inputs[1]).toMatchObject({ Item: { expiresAt: 0 } });
  });

  // @spec RT-TASK-LAUNCH-010, RT-TASK-LAUNCH-015, RT-TASK-LAUNCH-016
  it('should not mask the original failure when the release write itself fails', async () => {
    const { put } = fakePut((call) => {
      if (call === 2) throw new Error('release failed');
      return {};
    });
    await expect(startWithLease(base(put, { launch: throwingLaunch }))).rejects.toThrow('boom');
  });
});
