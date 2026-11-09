import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const send = vi.fn();

import type { CloudProvider } from '@hyveon/shared';
import { UploadLeaseService } from './UploadLeaseService.js';

const HEARTBEAT_MS = 30_000;
const conditionFailure = (Item?: Record<string, unknown>) =>
  Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException', Item });

/** Items written so far, in order. */
const writes = () => send.mock.calls.map(([cmd]: [{ input: Record<string, unknown> }]) => cmd.input);

/**
 * Builds the service over a stub provider whose lease writer is the shared `send` mock; `access` overrides what
 * `getStartLeaseAccess` resolves (`null` for nothing deployed).
 */
function service(access: Awaited<ReturnType<NonNullable<CloudProvider['getStartLeaseAccess']>>> | Error = {
  put: async (input) => send({ input }),
  tableName: 'discord-table',
}): UploadLeaseService {
  const provider: Partial<CloudProvider> = {
    getStartLeaseAccess: async () => {
      if (access instanceof Error) throw access;
      return access;
    },
  };
  return new UploadLeaseService(provider as CloudProvider);
}

beforeEach(() => {
  vi.useFakeTimers();
  send.mockReset();
  send.mockResolvedValue({});
});
afterEach(() => vi.useRealTimers());

describe('UploadLeaseService', () => {
  // @spec HELPER-FB-042, HELPER-FB-043
  it('should take one lease for concurrent uploads of a game and release it only after the last drops', async () => {
    const leases = service();
    const results = await Promise.all([leases.hold('minecraft', 'upload:a'), leases.hold('minecraft', 'upload:b')]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ TableName: 'discord-table', Item: { pk: 'LAUNCH#minecraft', holder: 'upload' } });

    await leases.drop('minecraft', 'upload:a');
    expect(writes()).toHaveLength(1);
    await leases.drop('minecraft', 'upload:b');
    expect(writes()).toHaveLength(2);
    expect(writes()[1]).toMatchObject({ Item: { expiresAt: 0 } });
  });

  // @spec HELPER-FB-043
  it('should lease different games independently', async () => {
    const leases = service();
    await leases.hold('minecraft', 'upload:a');
    await leases.hold('valheim', 'upload:b');
    expect(writes()).toHaveLength(2);
  });

  // @spec HELPER-FB-044
  it('should renew the lease on a heartbeat inside the TTL and stop renewing once released', async () => {
    const leases = service();
    await leases.hold('minecraft', 'upload:a');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(writes()).toHaveLength(2);
    expect(writes()[1]).toMatchObject({ ConditionExpression: 'leaseId = :id' });
    expect(HEARTBEAT_MS / 1000).toBeLessThan(120);

    await leases.drop('minecraft', 'upload:a');
    send.mockClear();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(send).not.toHaveBeenCalled();
  });

  // @spec HELPER-FB-045
  it.each([
    ['start', undefined, /start for minecraft is already in progress/i],
    ['upload', { holder: 'upload' }, /another upload into 'minecraft'/i],
  ])('should refuse an upload while a %s holds the lease and leave nothing registered', async (_who, item, message) => {
    const leases = service();
    send.mockRejectedValueOnce(conditionFailure(item));
    const refused = await leases.hold('minecraft', 'upload:a');
    expect(refused).toEqual({ ok: false, message: expect.stringMatching(message) });

    await expect(leases.hold('minecraft', 'upload:b')).resolves.toEqual({ ok: true });
  });

  // @spec HELPER-FB-045
  it('should fail closed when the lease cannot be taken', async () => {
    const leases = service();
    send.mockRejectedValueOnce(new Error('network down'));
    expect(await leases.hold('minecraft', 'upload:a')).toEqual({ ok: false, message: expect.stringContaining('network down') });
  });

  // @spec HELPER-FB-045
  it('should refuse when the stack has no start-lease table', async () => {
    const leases = service(new Error('Infrastructure is out of date (no start-lease table). Run Apply on the IaC page first.'));
    expect(await leases.hold('minecraft', 'upload:a')).toEqual({ ok: false, message: expect.stringMatching(/out of date/i) });
  });

  // @spec HELPER-FB-042
  it('should take no lease when nothing is deployed', async () => {
    const leases = service(null);
    expect(await leases.hold('minecraft', 'upload:a')).toEqual({ ok: true });
    expect(send).not.toHaveBeenCalled();
  });

  // @spec HELPER-FB-046
  it('should report the lease lost at once when another holder took it', async () => {
    const leases = service();
    const lost = vi.fn();
    leases.onLost(lost);
    await leases.hold('minecraft', 'upload:a');
    send.mockRejectedValueOnce(conditionFailure());
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(lost).toHaveBeenCalledWith('minecraft', expect.stringMatching(/lost its hold/i));
  });

  // @spec HELPER-FB-046
  it('should tolerate one failed renewal, reset on success, and report lost after two in a row', async () => {
    const leases = service();
    const lost = vi.fn();
    leases.onLost(lost);
    await leases.hold('minecraft', 'upload:a');

    send.mockRejectedValueOnce(new Error('blip'));
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(lost).not.toHaveBeenCalled();

    send.mockRejectedValue(new Error('down'));
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(lost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(lost).toHaveBeenCalledWith('minecraft', expect.stringMatching(/could not keep its hold/i));

    send.mockClear();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(send).not.toHaveBeenCalled();
  });
});
