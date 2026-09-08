/**
 * Tests for `RunService` — the in-memory + DynamoDB apply lock (issue #106).
 * `RunRecordStore` is stubbed here; the real `AwsRunRecordStore` has its own
 * tests under `@hyveon/cloud-aws`. Covers `createRun` rejecting a second
 * concurrent submission with `RunLockHeldError`, `getCurrentLock` surfacing
 * the in-flight lock, `releaseRun` freeing it for the next `createRun`, and
 * the table-not-deployed path still enforcing the in-memory mutex.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunLockHeldError } from '@hyveon/shared';
import type { RunLock, RunRecordStore } from '@hyveon/shared';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  DEFAULT_LOCK_TTL_MS,
  RUN_LOCK_CLEAR_CONFIRMATION_TTL_MS,
  RunLockChangedError,
  RunLockClearNotConfirmedError,
  RunService,
} from './RunService.js';
import { ConfigService } from './ConfigService.js';
import { logger } from '../logger.js';
import type { StackOutputs } from '@hyveon/shared';
import { stackOutputs } from '../testing/stack-outputs.fixture.js';

/** Minimal `StackOutputs` stub exposing just `runsTableName`. */
const STACK_OUTPUTS: StackOutputs = stackOutputs({
  ecsClusterName: '',
  ecsClusterArn: '',
  subnetIds: [],
  securityGroupId: '',
  fileManagerSecurityGroupId: '',
  efsFileSystemId: '',
  efsAccessPoints: {},
  domainName: '',
  gameNames: [],
  discordTableName: '',
  auditTableName: '',
  runsTableName: 'test-runs',
  discordBotTokenSecretArn: '',
  discordPublicKeySecretArn: '',
  fileBrowserCredentialSecretArn: '',
  fileBrowserSchedulerRoleArn: '',
});

const acquireRunLockMock = vi.fn<RunRecordStore['acquireRunLock']>();
const getRunLockMock = vi.fn<RunRecordStore['getRunLock']>();
const releaseRunLockMock = vi.fn<RunRecordStore['releaseRunLock']>();

/** Builds a `RunRecordStore`-shaped stub, only implementing the lock methods `RunService` calls. */
function makeStore(): RunRecordStore {
  return {
    putRecord: vi.fn(),
    putLog: vi.fn(),
    getLogUrl: vi.fn(),
    acquireRunLock: acquireRunLockMock,
    getRunLock: getRunLockMock,
    releaseRunLock: releaseRunLockMock,
  };
}

/** Builds a `RunService` with a `ConfigService` stub returning `outputs` and the given (or default) store stub. */
function makeService(outputs: StackOutputs | null = STACK_OUTPUTS, store: RunRecordStore = makeStore()): RunService {
  const config = { getStackOutputs: async () => outputs } as Partial<ConfigService> as ConfigService;
  return new RunService(config, store);
}

beforeEach(() => {
  acquireRunLockMock.mockReset();
  getRunLockMock.mockReset();
  releaseRunLockMock.mockReset();
  acquireRunLockMock.mockResolvedValue(undefined);
  getRunLockMock.mockResolvedValue(undefined);
  releaseRunLockMock.mockResolvedValue(undefined);
});

describe('RunService', () => {
  describe('createRun', () => {
    it('should acquire the lock, mirror it to the DynamoDB-backed store, and return it', async () => {
      const service = makeService();

      const lock = await service.createRun('apply', 'alice');

      expect(lock.kind).toBe('apply');
      expect(lock.initiator).toBe('alice');
      expect(typeof lock.runId).toBe('string');
      expect(lock.runId.length).toBeGreaterThan(0);
      expect(acquireRunLockMock).toHaveBeenCalledTimes(1);
      expect(acquireRunLockMock).toHaveBeenCalledWith(lock);
    });

    it('should reject the second of two simultaneous createRun calls with RunLockHeldError', async () => {
      const service = makeService();
      // Never resolves within this test — proves the in-memory guard rejects
      // the second call before the first call's DynamoDB round-trip settles.
      acquireRunLockMock.mockReturnValue(new Promise(() => {}));

      const firstCall = service.createRun('apply', 'alice');
      const secondCall = service.createRun('plan', 'bob');

      await expect(secondCall).rejects.toBeInstanceOf(RunLockHeldError);
      await expect(secondCall).rejects.toMatchObject({ lock: { initiator: 'alice', kind: 'apply' } });
      // The first call is intentionally left in-flight (never awaited to
      // resolution) since acquireRunLockMock never resolves in this test.
      void firstCall.catch(() => {});
    });

    it('should roll back the in-memory lock when the DynamoDB acquisition is rejected by another holder', async () => {
      const service = makeService();
      const remoteLock: RunLock = {
        runId: 'remote-run',
        kind: 'destroy',
        initiator: 'carol',
        acquiredAt: '2026-07-20T00:00:00.000Z',
        expiresAt: '2026-07-20T01:00:00.000Z',
      };
      acquireRunLockMock.mockRejectedValueOnce(new RunLockHeldError(remoteLock));

      await expect(service.createRun('apply', 'alice')).rejects.toBeInstanceOf(RunLockHeldError);

      expect(service.getCurrentLock()).toBeUndefined();

      acquireRunLockMock.mockResolvedValueOnce(undefined);
      const nextLock = await service.createRun('plan', 'dave');
      expect(nextLock.initiator).toBe('dave');
    });

    it('should log a warning (not throw a raw SDK error uncaught) when the DynamoDB apply lock acquisition fails', async () => {
      const service = makeService();
      const remoteLock: RunLock = {
        runId: 'remote-run',
        kind: 'destroy',
        initiator: 'carol',
        acquiredAt: '2026-07-20T00:00:00.000Z',
        expiresAt: '2026-07-20T01:00:00.000Z',
      };
      acquireRunLockMock.mockRejectedValueOnce(new RunLockHeldError(remoteLock));

      await expect(service.createRun('apply', 'alice')).rejects.toBeInstanceOf(RunLockHeldError);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('RunService.createRun'),
        expect.objectContaining({ runId: expect.any(String) }),
      );
    });

    it('should log a debug entry line when starting to acquire the apply lock', async () => {
      const service = makeService();

      await service.createRun('apply', 'alice');

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('RunService.createRun'),
        expect.objectContaining({ kind: 'apply', initiator: 'alice' }),
      );
    });

    it('should skip the DynamoDB call but still enforce the in-memory mutex when runs_table_name is not configured', async () => {
      const service = makeService(null);

      const lock = await service.createRun('apply', 'alice');

      expect(acquireRunLockMock).not.toHaveBeenCalled();
      expect(service.getCurrentLock()).toEqual(lock);

      await expect(service.createRun('plan', 'bob')).rejects.toBeInstanceOf(RunLockHeldError);
      expect(acquireRunLockMock).not.toHaveBeenCalled();
    });

    it('should allow a new run to be created once the previous run releases the lock', async () => {
      const service = makeService();

      const first = await service.createRun('apply', 'alice');
      await service.releaseRun(first.runId);

      const second = await service.createRun('plan', 'bob');

      expect(second.initiator).toBe('bob');
      expect(service.getCurrentLock()).toEqual(second);
    });

    it('should acquire the lock under a pre-minted runId when one is passed, and release it by that runId', async () => {
      const service = makeService();

      const lock = await service.createRun('apply', 'alice', 'some-id');

      expect(lock.runId).toBe('some-id');
      expect(acquireRunLockMock).toHaveBeenCalledWith(lock);
      expect(service.getCurrentLock()).toEqual(lock);

      await service.releaseRun('some-id');

      expect(releaseRunLockMock).toHaveBeenCalledWith('some-id');
      expect(service.getCurrentLock()).toBeUndefined();
    });

    it('should take over an expired in-memory lock instead of throwing RunLockHeldError', async () => {
      const service = makeService();

      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'));
        const first = await service.createRun('apply', 'alice');

        // Advance past DEFAULT_LOCK_TTL_MS without releasing the first lock
        // (simulates a crashed run that never called releaseRun).
        vi.setSystemTime(new Date(Date.parse(first.acquiredAt) + DEFAULT_LOCK_TTL_MS + 1));

        const second = await service.createRun('plan', 'bob');

        expect(second.initiator).toBe('bob');
        expect(service.getCurrentLock()).toEqual(second);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('getCurrentLock', () => {
    it('should return undefined when no run is in flight', () => {
      const service = makeService();

      expect(service.getCurrentLock()).toBeUndefined();
    });

    it('should surface the in-flight lock acquired by createRun', async () => {
      const service = makeService();

      const lock = await service.createRun('apply', 'alice');

      expect(service.getCurrentLock()).toEqual(lock);
    });

    it('should return undefined once the held lock has expired, without releaseRun being called', async () => {
      const service = makeService();

      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'));
        const lock = await service.createRun('apply', 'alice');
        expect(service.getCurrentLock()).toEqual(lock);

        vi.setSystemTime(new Date(Date.parse(lock.acquiredAt) + DEFAULT_LOCK_TTL_MS + 1));

        expect(service.getCurrentLock()).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('releaseRun', () => {
    it('should free the lock for the next createRun call and release the DynamoDB-backed lock', async () => {
      const service = makeService();
      const lock = await service.createRun('apply', 'alice');

      await service.releaseRun(lock.runId);

      expect(releaseRunLockMock).toHaveBeenCalledWith(lock.runId);
      expect(service.getCurrentLock()).toBeUndefined();
    });

    it('should no-op when runId does not match the currently held lock', async () => {
      const service = makeService();
      const lock = await service.createRun('apply', 'alice');

      await service.releaseRun('some-other-run-id');

      expect(service.getCurrentLock()).toEqual(lock);
      expect(releaseRunLockMock).toHaveBeenCalledWith('some-other-run-id');
    });

    it('should skip the DynamoDB release call when runs_table_name is not configured', async () => {
      const service = makeService(null);
      const lock = await service.createRun('apply', 'alice');

      await service.releaseRun(lock.runId);

      expect(releaseRunLockMock).not.toHaveBeenCalled();
      expect(service.getCurrentLock()).toBeUndefined();
    });

    it('should resolve rather than throw when the DynamoDB release call rejects with a transient error', async () => {
      const service = makeService();
      const lock = await service.createRun('apply', 'alice');
      releaseRunLockMock.mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));

      // Must not reject: RunRecordService.persist() releases the lock from a
      // `finally` block, so a non-conflict DynamoDB error here must be
      // swallowed (with a warning logged) rather than propagated — the lock
      // self-heals via TTL expiry regardless.
      await expect(service.releaseRun(lock.runId)).resolves.toBeUndefined();
      expect(service.getCurrentLock()).toBeUndefined();
    });

    it('should log a debug entry line when starting to release the apply lock', async () => {
      const service = makeService();
      const lock = await service.createRun('apply', 'alice');

      await service.releaseRun(lock.runId);

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('RunService.releaseRun'),
        expect.objectContaining({ runId: lock.runId }),
      );
    });
  });

  describe('RunLockClearNotConfirmedError', () => {
    it('should carry a descriptive message naming the required mint/clear sequence', () => {
      const err = new RunLockClearNotConfirmedError();
      expect(err.name).toBe('RunLockClearNotConfirmedError');
      expect(err.message).toMatch(/mintLockClearConfirmationToken/);
      expect(err.message).toMatch(/clearLock/);
    });
  });

  describe('RunService.mintLockClearConfirmationToken', () => {
    it('should throw when no lock is currently held, in-memory or durable', async () => {
      const service = makeService();
      getRunLockMock.mockResolvedValue(undefined);
      await expect(service.mintLockClearConfirmationToken('any-run-id')).rejects.toThrow(
        /no run lock is currently held/i,
      );
    });

    it('should mint a token when a lock is held in-memory and expectedRunId matches it', async () => {
      const service = makeService();
      const lock = await service.createRun('apply', 'chris');
      const token = await service.mintLockClearConfirmationToken(lock.runId);
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });

    it('should mint a token bound to the durable lock when this process has no in-memory lock (cross-process/restart recovery)', async () => {
      const service = makeService(); // fresh instance: currentLock is null
      const durableLock: RunLock = {
        runId: 'other-process-run-id',
        kind: 'apply',
        initiator: 'someone-else',
        acquiredAt: '2026-08-10T03:52:26.761Z',
        expiresAt: '2026-08-10T04:52:26.761Z',
      };
      getRunLockMock.mockResolvedValue(durableLock);
      const token = await service.mintLockClearConfirmationToken(durableLock.runId);
      expect(typeof token).toBe('string');
      // bound to the durable lock's runId, not this process's (empty) in-memory state
      await expect(service.clearLock(token)).resolves.toBeUndefined();
      expect(releaseRunLockMock).toHaveBeenCalledWith(durableLock.runId);
    });

    it('should treat a rejected durable lock read as no lock held, not let the raw error escape', async () => {
      const service = makeService(); // fresh instance: currentLock is null
      getRunLockMock.mockRejectedValue(new Error('DynamoDB throttled'));
      await expect(service.mintLockClearConfirmationToken('any-run-id')).rejects.toThrow(
        /no run lock is currently held/i,
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('RunService.mintLockClearConfirmationToken'),
        expect.objectContaining({ error: expect.stringContaining('DynamoDB throttled') }),
      );
    });

    it('should supersede a previously minted, unconsumed token', async () => {
      const service = makeService();
      const lock = await service.createRun('apply', 'chris');
      const first = await service.mintLockClearConfirmationToken(lock.runId);
      const second = await service.mintLockClearConfirmationToken(lock.runId);
      expect(first).not.toBe(second);
      await expect(service.clearLock(first)).rejects.toThrow(RunLockClearNotConfirmedError);
    });

    it('should refuse to mint with RunLockChangedError when expectedRunId does not match the currently held lock', async () => {
      // Closes the TOCTOU gap Finding 1 identified: the operator's dialog
      // displayed a lock that has since been released and replaced by a
      // different, legitimate lock — minting must refuse rather than
      // silently binding a token to the NEW lock.
      const service = makeService();
      await service.createRun('apply', 'chris');

      await expect(service.mintLockClearConfirmationToken('some-other-run-id')).rejects.toThrow(
        RunLockChangedError,
      );
    });

    it('should not mint (leaving any prior pending token usable) when expectedRunId mismatches', async () => {
      const service = makeService();
      const lock = await service.createRun('apply', 'chris');
      const validToken = await service.mintLockClearConfirmationToken(lock.runId);

      await expect(service.mintLockClearConfirmationToken('wrong-run-id')).rejects.toThrow(RunLockChangedError);

      // The mismatch attempt above minted nothing new — the prior valid
      // token is still usable.
      await expect(service.clearLock(validToken)).resolves.toBeUndefined();
    });
  });

  describe('RunService.clearLock', () => {
    it('should throw RunLockClearNotConfirmedError when no token has ever been minted', async () => {
      const service = makeService();
      await service.createRun('apply', 'chris');
      await expect(service.clearLock('bogus-token')).rejects.toThrow(RunLockClearNotConfirmedError);
    });

    it('should throw RunLockClearNotConfirmedError when the supplied token does not match the most recently minted one', async () => {
      const service = makeService();
      const lock = await service.createRun('apply', 'chris');
      await service.mintLockClearConfirmationToken(lock.runId);
      await expect(service.clearLock('wrong-token')).rejects.toThrow(RunLockClearNotConfirmedError);
    });

    it('should throw RunLockClearNotConfirmedError when the minted token has expired', async () => {
      vi.useFakeTimers();
      const service = makeService();
      const lock = await service.createRun('apply', 'chris');
      const token = await service.mintLockClearConfirmationToken(lock.runId);
      vi.advanceTimersByTime(RUN_LOCK_CLEAR_CONFIRMATION_TTL_MS + 1);
      await expect(service.clearLock(token)).rejects.toThrow(RunLockClearNotConfirmedError);
      vi.useRealTimers();
    });

    it('should clear the lock and allow a subsequent createRun on a valid, fresh token', async () => {
      const service = makeService();
      const lock = await service.createRun('apply', 'chris');
      const token = await service.mintLockClearConfirmationToken(lock.runId);
      await service.clearLock(token);
      expect(service.getCurrentLock()).toBeUndefined();
      expect(releaseRunLockMock).toHaveBeenCalledWith(lock.runId);
      await expect(service.createRun('apply', 'someone-else')).resolves.toMatchObject({ initiator: 'someone-else' });
    });

    it('should refuse to clear (token no longer bound to the current lock) when a different run has since acquired the lock', async () => {
      const service = makeService();
      const originalLock = await service.createRun('apply', 'chris');
      const token = await service.mintLockClearConfirmationToken(originalLock.runId);
      await service.releaseRun(originalLock.runId); // original run finishes on its own
      const newLock = await service.createRun('apply', 'someone-else'); // a new, legitimate run starts
      await expect(service.clearLock(token)).rejects.toThrow(RunLockClearNotConfirmedError);
      expect(service.getCurrentLock()).toMatchObject({ runId: newLock.runId }); // untouched
    });

    it('should consume the token: a second clearLock() call reusing an already-consumed token is rejected', async () => {
      const service = makeService();
      const lock = await service.createRun('apply', 'chris');
      const token = await service.mintLockClearConfirmationToken(lock.runId);
      await service.clearLock(token);
      await service.createRun('apply', 'someone-else');
      await expect(service.clearLock(token)).rejects.toThrow(RunLockClearNotConfirmedError);
    });

    it('should clear a durable-only lock (no in-memory lock in this process) on a valid, fresh token', async () => {
      const service = makeService(); // fresh instance: currentLock is null
      const durableLock: RunLock = {
        runId: 'other-process-run-id',
        kind: 'apply',
        initiator: 'someone-else',
        acquiredAt: '2026-08-10T03:52:26.761Z',
        expiresAt: '2026-08-10T04:52:26.761Z',
      };
      getRunLockMock.mockResolvedValue(durableLock);
      const token = await service.mintLockClearConfirmationToken(durableLock.runId);
      getRunLockMock.mockResolvedValue(durableLock); // still held at confirm time
      await service.clearLock(token);
      expect(releaseRunLockMock).toHaveBeenCalledWith(durableLock.runId);
    });

    it('should mint and clear an in-memory-only lock via createRun/clearLock without touching the DynamoDB-backed calls when runs_table_name is not configured', async () => {
      const service = makeService(null);
      const lock = await service.createRun('apply', 'chris');
      expect(acquireRunLockMock).not.toHaveBeenCalled();

      const token = await service.mintLockClearConfirmationToken(lock.runId);
      expect(getRunLockMock).not.toHaveBeenCalled();

      await service.clearLock(token);

      expect(releaseRunLockMock).not.toHaveBeenCalled();
      expect(service.getCurrentLock()).toBeUndefined();
      await expect(service.createRun('apply', 'someone-else')).resolves.toMatchObject({ initiator: 'someone-else' });
    });
  });

  describe('RunLockChangedError', () => {
    it('should carry a descriptive message naming the TOCTOU it guards against', () => {
      const err = new RunLockChangedError();
      expect(err.name).toBe('RunLockChangedError');
      expect(err.message).toMatch(/run lock has changed/i);
    });
  });
});
