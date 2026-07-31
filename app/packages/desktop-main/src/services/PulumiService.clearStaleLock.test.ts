/**
 * Unit tests for `PulumiService.clearStaleLock` (task 9.4 of
 * `migrate-iac-to-pulumi` — "stale-lock recovery UI with explicit
 * confirmation"). This is the human-confirmed write path a caller reaches
 * only after `PulumiUnrecognizedLockError` has already told them a backend
 * lock conflict couldn't be proven this installation's own orphaned run, and
 * the renderer's confirmation dialog has required an explicit operator
 * confirmation on top of that — see `PulumiService.ts`'s own TSDoc on this
 * method for the full safety reasoning.
 *
 * Mirrors `PulumiService.destroy.test.ts`'s `makeStore`/`makeWorkspace`-style
 * helpers where they apply (this method shares `destroy()`'s "no-op inline
 * program" + config-presence-gate shape), but is far narrower in scope: no
 * streaming, no run persistence, no token gate, no lock-classification
 * retry — this method's own job is exactly "check operationInFlight, check
 * config presence, call stack.cancel(), done".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModuleRef } from '@nestjs/core';
import type { Stack } from '@pulumi/pulumi/automation/index.js';
import type { RunLock } from '@hyveon/shared';
import {
  PulumiService,
  PulumiOperationInFlightError,
  PulumiLockClearError,
  RUN_RECORD_PERSISTER,
  RUN_LOCK_SERVICE,
  CONFIG_CACHE_INVALIDATOR,
  type RunRecordPersister,
  type RunLockService,
  type ConfigCacheInvalidator,
} from './PulumiService.js';
import type { PulumiWorkspaceService } from './PulumiWorkspaceService.js';
import type { PulumiEngineService } from './PulumiEngineService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { SafeStorageService } from './SafeStorageService.js';

/** `bootstrap`/`aws`/`pulumi` fields `clearStaleLock()` reads off the store before ever calling Pulumi — mirrors `PulumiService.destroy.test.ts`'s identical fixture. */
const FULLY_CONFIGURED = { stateBucket: 'my-state-bucket', passphrase: 'enc-secret', awsRegion: 'us-east-1' };

/** Builds a real `ElectronStoreService` (in-memory Map outside Electron) with the given fields pre-seeded — mirrors `PulumiService.destroy.test.ts`'s identical helper. */
function makeStore(opts: { stateBucket?: string; passphrase?: string; awsRegion?: string } = {}): ElectronStoreService {
  const store = new ElectronStoreService(new SafeStorageService());
  if (opts.stateBucket !== undefined) {
    store.set('bootstrap', { stateBucket: opts.stateBucket, lockTable: '', configurationBucket: '' });
  }
  if (opts.passphrase !== undefined) {
    store.set('pulumi', { passphrase: opts.passphrase });
  }
  if (opts.awsRegion !== undefined) {
    store.set('aws', { region: opts.awsRegion });
  }
  return store;
}

/** A fully-configured store (state bucket, passphrase, AWS region). */
function makeFullyConfiguredStore(): ElectronStoreService {
  return makeStore(FULLY_CONFIGURED);
}

/** Builds a `PulumiWorkspaceService` stub whose `getOrCreateStack` resolves to a stack stub wrapping the given `cancel` implementation. */
function makeWorkspace(
  cancelMock: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined),
): PulumiWorkspaceService & { getOrCreateStack: ReturnType<typeof vi.fn> } {
  const getOrCreateStack = vi.fn().mockResolvedValue({ cancel: cancelMock } as Partial<Stack> as Stack);
  return { getOrCreateStack } as unknown as PulumiWorkspaceService & { getOrCreateStack: ReturnType<typeof vi.fn> };
}

/** Stub `ModuleRef` — `clearStaleLock()` never resolves anything through it, but the constructor still requires one. */
function makeModuleRef(): ModuleRef {
  const get = vi.fn(() => {
    throw new Error('ModuleRef.get() should never be called by clearStaleLock()');
  });
  return { get } as unknown as ModuleRef;
}

/** Stub `PulumiEngineService` — an ordinary constructor dependency `clearStaleLock()` never reads. */
function makeEngine(): PulumiEngineService {
  return {
    resolve: vi.fn().mockResolvedValue({}),
    getResolvedVersion: vi.fn().mockReturnValue('3.255.0'),
  } as unknown as PulumiEngineService;
}

/** Constructs `PulumiService` with every dependency stubbed. */
function makeService(opts: { workspace: PulumiWorkspaceService; store?: ElectronStoreService }): PulumiService {
  return new PulumiService(opts.workspace, opts.store ?? makeFullyConfiguredStore(), makeModuleRef(), makeEngine());
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('PulumiService.clearStaleLock', () => {
  it('should call getOrCreateStack with a no-op program, stackExists: true, and backendReady: true, then call stack.cancel()', async () => {
    const cancelMock = vi.fn().mockResolvedValue(undefined);
    const workspace = makeWorkspace(cancelMock);
    const service = makeService({ workspace });

    await service.clearStaleLock();

    expect(workspace.getOrCreateStack).toHaveBeenCalledTimes(1);
    const input = workspace.getOrCreateStack.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({
      stateBucket: 'my-state-bucket',
      stateBucketRegion: 'us-east-1',
      backendReady: true,
      stackExists: true,
    });
    expect(typeof input['program']).toBe('function');
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it('should resolve (not throw) on a successful cancel', async () => {
    const workspace = makeWorkspace();
    const service = makeService({ workspace });

    await expect(service.clearStaleLock()).resolves.toBeUndefined();
  });

  it('should reject with PulumiOperationInFlightError, and never call getOrCreateStack, when destroy() is already in flight', async () => {
    // Uses a genuinely concurrent destroy() (rather than faking
    // `operationInFlight` directly — a private field, deliberately not
    // test-visible) as the in-flight operation, mirroring
    // `PulumiService.destroy.test.ts`'s own concurrency-guard tests.
    // destroy() is the lightest real operation to hold the lock with here —
    // like clearStaleLock() itself, it needs no REMOTE_FILE_STORE wiring
    // (its own "no-op inline program" — see that method's TSDoc).
    let resolveDestroy!: () => void;
    const destroyMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDestroy = () =>
            resolve({
              stdout: '',
              stderr: '',
              summary: {
                kind: 'destroy',
                startTime: new Date(),
                endTime: new Date(),
                message: '',
                environment: {},
                config: {},
                result: 'succeeded',
                version: 1,
              },
            });
        }),
    );
    const getOrCreateStack = vi
      .fn()
      .mockResolvedValue({ destroy: destroyMock, cancel: vi.fn() } as Partial<Stack> as Stack);
    const workspace = { getOrCreateStack } as unknown as PulumiWorkspaceService;

    // Unlike `makeModuleRef()` (which asserts clearStaleLock() itself never
    // touches ModuleRef), destroy() DOES need RUN_RECORD_PERSISTER/
    // RUN_LOCK_SERVICE/CONFIG_CACHE_INVALIDATOR to run at all — stub all
    // three here, mirroring `PulumiService.destroy.test.ts`'s own helper.
    const lock: RunLock = {
      runId: 'destroy-run-1',
      kind: 'destroy',
      initiator: 'test-initiator',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const runRecordPersister: RunRecordPersister = { getByRunId: vi.fn(), persist: vi.fn().mockResolvedValue(undefined) };
    const runLockService: RunLockService = { createRun: vi.fn().mockResolvedValue(lock), releaseRun: vi.fn().mockResolvedValue(undefined) };
    const configCacheInvalidator: ConfigCacheInvalidator = { invalidateCache: vi.fn() };
    const moduleRef = {
      get: vi.fn((token: unknown) => {
        if (token === RUN_RECORD_PERSISTER) return runRecordPersister;
        if (token === RUN_LOCK_SERVICE) return runLockService;
        if (token === CONFIG_CACHE_INVALIDATOR) return configCacheInvalidator;
        throw new Error(`unexpected ModuleRef token ${String(token)}`);
      }),
    } as unknown as ModuleRef;

    const store = makeFullyConfiguredStore();
    const service = new PulumiService(workspace, store, moduleRef, makeEngine());
    const token = service.mintDestroyConfirmationToken();

    const destroyGen = service.destroy(token);
    const destroyNext = destroyGen.next();
    // Let destroy()'s gate run to completion and commit operationInFlight = 'destroy'.
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    getOrCreateStack.mockClear();

    await expect(service.clearStaleLock()).rejects.toBeInstanceOf(PulumiOperationInFlightError);
    await expect(service.clearStaleLock()).rejects.toThrow(/destroy.*already running/i);
    expect(getOrCreateStack).not.toHaveBeenCalled();

    resolveDestroy();
    await destroyNext;
    await destroyGen.next();
  });

  it('should reject with a descriptive Error, and never call getOrCreateStack, when the state bucket / AWS region is not configured', async () => {
    const workspace = makeWorkspace();
    const store = makeStore({ passphrase: 'enc-secret' });
    const service = makeService({ workspace, store });

    await expect(service.clearStaleLock()).rejects.toThrow(/state bucket.*AWS region.*not been configured/i);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should reject with a descriptive Error, and never call getOrCreateStack, when no Pulumi stack has ever been created (no passphrase on record)', async () => {
    const workspace = makeWorkspace();
    const store = makeStore({ stateBucket: 'my-state-bucket', awsRegion: 'us-east-1' });
    const service = makeService({ workspace, store });

    await expect(service.clearStaleLock()).rejects.toThrow(/no Pulumi stack has ever been created/i);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should reject with PulumiLockClearError (wrapping the cause), and leave the lock standing, when stack.cancel() itself fails', async () => {
    const cause = new Error('cancel command failed');
    const cancelMock = vi.fn().mockRejectedValue(cause);
    const workspace = makeWorkspace(cancelMock);
    const service = makeService({ workspace });

    let caught: unknown;
    try {
      await service.clearStaleLock();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PulumiLockClearError);
    expect((caught as PulumiLockClearError).cause).toBe(cause);
    expect((caught as Error).message).toContain('cancel command failed');
  });

  it('should allow a fresh clearStaleLock() call after a prior one succeeded', async () => {
    const cancelMock = vi.fn().mockResolvedValue(undefined);
    const workspace = makeWorkspace(cancelMock);
    const service = makeService({ workspace });

    await service.clearStaleLock();
    await expect(service.clearStaleLock()).resolves.toBeUndefined();

    expect(cancelMock).toHaveBeenCalledTimes(2);
  });

  it('should allow a fresh clearStaleLock() call after a prior one failed with PulumiLockClearError', async () => {
    let shouldFail = true;
    const cancelMock = vi.fn().mockImplementation(async () => {
      if (shouldFail) throw new Error('boom');
    });
    const workspace = makeWorkspace(cancelMock);
    const service = makeService({ workspace });

    await expect(service.clearStaleLock()).rejects.toBeInstanceOf(PulumiLockClearError);

    shouldFail = false;
    await expect(service.clearStaleLock()).resolves.toBeUndefined();
  });
});
