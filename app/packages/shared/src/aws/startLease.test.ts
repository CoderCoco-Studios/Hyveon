import { describe, it, expect, vi } from 'vitest';
import {
  START_LEASE_TTL_SECONDS,
  acquireUploadLease,
  leaseBusyMessage,
  releaseUploadLease,
  renewUploadLease,
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
    expect(out).toEqual({ status: 'in-progress', holder: 'start' });
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

describe('upload lease', () => {
  const opts = (put: StartLeasePut) => ({ put, tableName: 'tbl', game: 'palworld', now: () => NOW_MS });

  // @spec HELPER-FB-042
  it('should record the holder on a start lease and ask for the row back on a failed condition', async () => {
    const { put, inputs } = fakePut();
    await startWithLease(base(put));
    expect(inputs[0]).toMatchObject({ Item: { holder: 'start' }, ReturnValuesOnConditionCheckFailure: 'ALL_OLD' });
  });

  // @spec HELPER-FB-042
  it('should report in-progress with holder upload, plain or DynamoDB-JSON, when an upload holds the lease', async () => {
    for (const Item of [{ holder: 'upload' }, { holder: { S: 'upload' } }]) {
      const { put } = fakePut(() => {
        throw Object.assign(conditionFailure(), { Item });
      });
      expect(await startWithLease(base(put))).toEqual({ status: 'in-progress', holder: 'upload' });
    }
  });

  // @spec HELPER-FB-042
  it('should word the refusal by holder', () => {
    expect(leaseBusyMessage('palworld', 'start')).toBe('A start for palworld is already in progress.');
    expect(leaseBusyMessage('palworld', 'upload')).toMatch(/upload into palworld is in progress/i);
  });

  // @spec HELPER-FB-042
  it('should acquire the lease as holder upload under the start lease condition', async () => {
    const { put, inputs } = fakePut();
    const out = await acquireUploadLease(opts(put));
    expect(out.status).toBe('acquired');
    expect(inputs[0]).toMatchObject({
      Item: { pk: 'LAUNCH#palworld', sk: 'LOCK', holder: 'upload', expiresAt: NOW_S + 120 },
      ConditionExpression: 'attribute_not_exists(pk) OR expiresAt < :now',
    });
  });

  // @spec HELPER-FB-045
  it('should report busy with the holder when a start holds the lease, and propagate other errors', async () => {
    expect(await acquireUploadLease(opts(fakePut(() => { throw conditionFailure(); }).put))).toEqual({ status: 'busy', holder: 'start' });
    await expect(acquireUploadLease(opts(fakePut(() => { throw new Error('net'); }).put))).rejects.toThrow('net');
  });

  // @spec HELPER-FB-044
  it('should renew only while the row still carries the lease id', async () => {
    const { put, inputs } = fakePut();
    expect(await renewUploadLease(opts(put), 'L1')).toBe('renewed');
    expect(inputs[0]).toMatchObject({ Item: { leaseId: 'L1', expiresAt: NOW_S + 120 }, ConditionExpression: 'leaseId = :id' });
    expect(await renewUploadLease(opts(fakePut(() => { throw conditionFailure(); }).put), 'L1')).toBe('lost');
    await expect(renewUploadLease(opts(fakePut(() => { throw new Error('net'); }).put), 'L1')).rejects.toThrow('net');
  });

  // @spec HELPER-FB-043
  it('should release by writing an expired row guarded by the lease id, and never throw', async () => {
    const { put, inputs } = fakePut();
    await releaseUploadLease(opts(put), 'L1');
    expect(inputs[0]).toMatchObject({ Item: { leaseId: 'L1', expiresAt: 0 }, ConditionExpression: 'leaseId = :id' });
    await expect(releaseUploadLease(opts(fakePut(() => { throw new Error('net'); }).put), 'L1')).resolves.toBeUndefined();
  });
});
