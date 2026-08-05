import 'reflect-metadata';
import * as os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IacController } from './iac.controller.js';
import {
  PulumiOperationInFlightError,
  PulumiRollbackPlanFailedError,
  PulumiStackInitializationError,
  type PulumiService,
  type PulumiRunChunk,
  type PulumiPreviewResult,
  type PulumiUpResult,
  type PulumiDestroyResult,
  type PulumiRunRecord,
} from '../services/PulumiService.js';
import type { ConfigService } from '../services/ConfigService.js';
import type { AuditService, RecordAuditEntryParams } from '../services/AuditService.js';
import {
  RunRecordNotFoundError,
  RunRecordNotPlanError,
  RunRecordNotSuccessfulError,
  RunRecordTableNotConfiguredError,
  type RunRecordService,
} from '../services/RunRecordService.js';
import { RunLockHeldError, type DeploymentConfigDiff, type RunLock, type StackOutputs } from '@hyveon/shared';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Hoisted mock state — must be declared before any vi.mock() factory runs.
// ---------------------------------------------------------------------------

/**
 * Captures every `ipcMain.handle`/`ipcMain.removeHandler` call so tests can
 * assert on routing registration without a real Electron main process.
 */
const { mockIpcMainHandle, mockIpcMainRemoveHandler } = vi.hoisted(() => {
  const mockIpcMainHandle = vi.fn();
  const mockIpcMainRemoveHandler = vi.fn();
  return { mockIpcMainHandle, mockIpcMainRemoveHandler };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: mockIpcMainHandle,
    removeHandler: mockIpcMainRemoveHandler,
  },
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// `IacController.approve` resolves the approver identity via
// `os.userInfo().username` rather than trusting a client-supplied field —
// stub it the same way `AuditService.test.ts` does so tests can assert on a
// deterministic resolved username.
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    userInfo: vi.fn(() => ({ username: 'test-operator' })),
  };
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A `PulumiPreviewResult` fixture, overridable per-test. Mirrors the old file's `TerraformPlanResult` builder. */
function buildPreviewResult(overrides: Partial<PulumiPreviewResult> = {}): PulumiPreviewResult {
  return {
    runId: 'plan-run-1',
    artifactPath: '/runs/plan-run-1/plan-run-1.tfplan',
    changeSummary: { create: 1 },
    planHash: 'plan-hash-abc',
    engineVersion: '3.255.0',
    ...overrides,
  };
}

/** A `PulumiUpResult` fixture, overridable per-test. Mirrors the old file's `TerraformApplyResult` builder. */
function buildUpResult(overrides: Partial<PulumiUpResult> = {}): PulumiUpResult {
  return {
    runId: 'plan-run-1',
    changeSummary: { create: 1 },
    ...overrides,
  };
}

/** A `PulumiDestroyResult` fixture, overridable per-test. Mirrors the old file's `TerraformDestroyResult` builder. */
function buildDestroyResult(overrides: Partial<PulumiDestroyResult> = {}): PulumiDestroyResult {
  return {
    runId: 'destroy-run-1',
    changeSummary: { delete: 3 },
    ...overrides,
  };
}

/** A `PulumiRunRecord` fixture, overridable per-test — used by `confirmRollback`'s `readRunRecord` recovery step. */
function buildRunRecord(overrides: Partial<PulumiRunRecord> = {}): PulumiRunRecord {
  return {
    runId: 'rollback-plan-run-1',
    kind: 'plan',
    startedAt: '2026-07-21T00:00:00.000Z',
    completedAt: '2026-07-21T00:00:05.000Z',
    exitCode: 0,
    configVersionId: 'config-v-new-head',
    ...overrides,
  };
}

/**
 * Build a `PulumiService` stub as a plain object of `vi.fn()`s (mirroring
 * `iac-runs.controller.test.ts`'s `makePulumi` — never a real `PulumiService`
 * instance, whose constructor deps are far heavier than a controller unit
 * test needs).
 *
 * Defaults: `getOperationInFlight` reports `null` (workspace free);
 * `preview`/`apply`/`destroy`/`confirmRollback` are empty async generators
 * that yield nothing and return `undefined`; `mintDestroyConfirmationToken`
 * and `mintLockClearConfirmationToken` return fixed tokens; `resolveRollbackTarget` resolves a fixed prior
 * version; `computeRollbackDiff` resolves `undefined` (mirrors its
 * documented "no diff available" default); `readRunRecord`
 * returns `null` (no persisted record) unless a test overrides it;
 * `getStackOutputs` resolves `null`; `clearStaleLock` resolves
 * `undefined` by default — i.e. "cleared successfully";
 * `initializeStack` resolves immediately without ever calling its
 * `onPhase` callback, unless a test overrides it.
 */
function makePulumi(): PulumiService {
  const stub = {
    getOperationInFlight: vi.fn().mockReturnValue(null),
    preview: vi.fn().mockImplementation(async function* () { /* empty */ }),
    apply: vi.fn().mockImplementation(async function* () { /* empty */ }),
    destroy: vi.fn().mockImplementation(async function* () { /* empty */ }),
    confirmRollback: vi.fn().mockImplementation(async function* () { /* empty */ }),
    mintDestroyConfirmationToken: vi.fn().mockReturnValue('token-abc'),
    mintLockClearConfirmationToken: vi.fn().mockReturnValue('lock-clear-token-abc'),
    resolveRollbackTarget: vi.fn().mockResolvedValue({
      versionId: 'config-v-prior',
      lastModified: new Date('2026-07-20T00:00:00.000Z'),
    }),
    computeRollbackDiff: vi.fn().mockResolvedValue(undefined),
    readRunRecord: vi.fn().mockReturnValue(null),
    getStackOutputs: vi.fn().mockResolvedValue(null),
    clearStaleLock: vi.fn().mockResolvedValue(undefined),
    initializeStack: vi.fn().mockResolvedValue(undefined),
  };
  return stub as unknown as PulumiService;
}

/** Build an AuditService stub whose `record` resolves immediately by default and captures every call. */
function makeAudit(): { audit: AuditService; record: ReturnType<typeof vi.fn> } {
  const record = vi.fn().mockResolvedValue(undefined);
  const stub: Partial<AuditService> = { record };
  return { audit: stub as AuditService, record };
}

/**
 * Build a `RunRecordService` stub whose `approveRun` resolves with the
 * approved record (`approvedBy`/`approvedAt` matching whatever it was called
 * with) by default. Tests override the implementation to simulate any of
 * `RunRecordService.approveRun`'s documented failure modes.
 */
function makeRunRecord(): { runRecord: RunRecordService; approveRun: ReturnType<typeof vi.fn> } {
  const approveRun = vi.fn().mockImplementation(async (runId: string, approvedBy: string) => ({
    sk: `2026-07-21T00:00:00.000Z#${runId}`,
    runId,
    kind: 'plan',
    status: 'success',
    startedAt: '2026-07-21T00:00:00.000Z',
    completedAt: '2026-07-21T00:00:05.000Z',
    exitCode: 0,
    approvedBy,
    approvedAt: '2026-07-21T00:05:00.000Z',
  }));
  const stub: Partial<RunRecordService> = { approveRun };
  return { runRecord: stub as RunRecordService, approveRun };
}

/** Build a `ConfigService` stub whose `getStackOutputs` resolves `outputs` (defaults to `null`) — {@link output}'s preferred delegate. */
function makeConfig(outputs: StackOutputs | null = null): { config: ConfigService; getStackOutputs: ReturnType<typeof vi.fn> } {
  const getStackOutputs = vi.fn().mockResolvedValue(outputs);
  const stub: Partial<ConfigService> = { getStackOutputs };
  return { config: stub as ConfigService, getStackOutputs };
}

/**
 * Build a minimal `IpcMainInvokeEvent` stub with a controlled `sender`
 * (WebContents). Tests can inspect calls on `sender.send` and control the
 * return value of `sender.isDestroyed()`.
 */
function makeCtx(isDestroyed = false) {
  const sender = {
    send: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(isDestroyed),
    // `plan()`/`apply()`/`destroy()`/`confirmRollback()` register a
    // `'destroyed'` listener (and remove it once the run settles) so they can
    // abort immediately when the WebContents goes away instead of only
    // checking `isDestroyed()` between chunks.
    once: vi.fn(),
    removeListener: vi.fn(),
  };
  const ctx: { evt: { sender: typeof sender } } = { evt: { sender } };
  return { ctx, sender };
}

/** Flush the microtask queue so async fire-and-forget loops fully settle. */
function flushPromises(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * The metadata key NestJS stores on each method decorated with
 * `@MessagePattern`. Asserting this value guards against typos in the
 * channel name that would silently break IPC routing.
 */
const PATTERN_METADATA_KEY = 'microservices:pattern';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('IacController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.userInfo).mockReturnValue({ username: 'test-operator' } as ReturnType<typeof os.userInfo>);
  });

  // -------------------------------------------------------------------------
  // @MessagePattern channel name registration
  // -------------------------------------------------------------------------

  describe('@MessagePattern channel names', () => {
    it('should register initializeStack on the "iac.stack.initialize" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, IacController.prototype.initializeStack);
      expect(pattern).toEqual(['iac.stack.initialize']);
    });

    it('should register output on the "iac.output" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, IacController.prototype.output);
      expect(pattern).toEqual(['iac.output']);
    });

    it('should register plan on the "iac.plan" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, IacController.prototype.plan);
      expect(pattern).toEqual(['iac.plan']);
    });

    it('should register approve on the "iac.approve" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, IacController.prototype.approve);
      expect(pattern).toEqual(['iac.approve']);
    });

    it('should register apply on the "iac.apply" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, IacController.prototype.apply);
      expect(pattern).toEqual(['iac.apply']);
    });

    it('should register mintDestroyToken on the "iac.destroy.mintToken" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, IacController.prototype.mintDestroyToken);
      expect(pattern).toEqual(['iac.destroy.mintToken']);
    });

    it('should register destroy on the "iac.destroy" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, IacController.prototype.destroy);
      expect(pattern).toEqual(['iac.destroy']);
    });

    it('should register resolveRollback on the "iac.rollback.resolve" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, IacController.prototype.resolveRollback);
      expect(pattern).toEqual(['iac.rollback.resolve']);
    });

    it('should register confirmRollback on the "iac.rollback.confirm" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, IacController.prototype.confirmRollback);
      expect(pattern).toEqual(['iac.rollback.confirm']);
    });

    it('should register clearStaleLock on the "iac.lock.clear" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, IacController.prototype.clearStaleLock);
      expect(pattern).toEqual(['iac.lock.clear']);
    });

    it('should register mintLockClearToken on the "iac.lock.clear.mintToken" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, IacController.prototype.mintLockClearToken);
      expect(pattern).toEqual(['iac.lock.clear.mintToken']);
    });
  });

  // -------------------------------------------------------------------------
  // onModuleInit — ipcMain.handle bridge for iac.plan/apply/destroy/stack.initialize
  // -------------------------------------------------------------------------

  describe('onModuleInit', () => {
    // onModuleInit only wires the bridge when running inside a real Electron
    // main process, detected via `process.versions.electron`. Vitest runs under
    // plain Node where it's undefined, so fake it for the "is Electron" cases
    // and restore afterwards.
    const realElectronVersion = process.versions.electron;
    const setElectron = (value: string | undefined): void => {
      if (value === undefined) {
        delete (process.versions as { electron?: string }).electron;
      } else {
        Object.defineProperty(process.versions, 'electron', { value, configurable: true });
      }
    };
    beforeEach(() => setElectron('30.0.0'));
    afterEach(() => setElectron(realElectronVersion));

    it('should skip the ipcMain bridge when not running inside an Electron main process', async () => {
      // Plain-Node runtimes (integration test server, Docker, CI) have no
      // `process.versions.electron`; importing electron there would throw, so
      // the bridge must be skipped without touching ipcMain at all.
      setElectron(undefined);
      await new IacController(makePulumi()).onModuleInit();
      expect(mockIpcMainHandle).not.toHaveBeenCalled();
      expect(mockIpcMainRemoveHandler).not.toHaveBeenCalled();
    });

    it('should register ipcMain.handle for "iac.stack.initialize" so ipcRenderer.invoke can resolve', async () => {
      // Streams `onPhase` progress the same way `iac.plan` streams chunks,
      // so it self-bridges too.
      await new IacController(makePulumi()).onModuleInit();
      expect(mockIpcMainHandle).toHaveBeenCalledWith('iac.stack.initialize', expect.any(Function));
    });

    it('should remove any existing "iac.stack.initialize" handler before registering so hot-reload re-bootstrap does not throw', async () => {
      await new IacController(makePulumi()).onModuleInit();
      expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith('iac.stack.initialize');
      const removeCalls = mockIpcMainRemoveHandler.mock.calls
        .map(([pattern]: [string]) => pattern)
        .filter((pattern: string) => pattern === 'iac.stack.initialize');
      const handleCalls = mockIpcMainHandle.mock.calls
        .map(([pattern]: [string]) => pattern)
        .filter((pattern: string) => pattern === 'iac.stack.initialize');
      expect(removeCalls).toHaveLength(1);
      expect(handleCalls).toHaveLength(1);
    });

    it('should invoke initializeStack as initializeStack(payload, { evt }) when the registered ipcMain.handle callback fires', async () => {
      const pulumi = makePulumi();
      const controller = new IacController(pulumi);
      const initializeStackSpy = vi
        .spyOn(controller, 'initializeStack')
        .mockResolvedValue({ started: true, streamId: 'stub-stream' });

      await controller.onModuleInit();

      const [, registeredCallback] = mockIpcMainHandle.mock.calls.find(
        ([pattern]: [string]) => pattern === 'iac.stack.initialize',
      ) as [string, (evt: unknown, payload: unknown) => unknown];
      expect(registeredCallback).toBeTypeOf('function');

      const fakeEvt = { sender: { id: 9 } };
      await registeredCallback(fakeEvt, undefined);

      expect(initializeStackSpy).toHaveBeenCalledWith(undefined, { evt: fakeEvt });
    });

    it('should register ipcMain.handle for "iac.plan" so ipcRenderer.invoke can resolve', async () => {
      await new IacController(makePulumi()).onModuleInit();
      expect(mockIpcMainHandle).toHaveBeenCalledWith('iac.plan', expect.any(Function));
    });

    it('should remove any existing "iac.plan" handler before registering so hot-reload re-bootstrap does not throw', async () => {
      // A second bootstrap (hot-reload / dev restart) would otherwise hit
      // "Attempted to register a second handler for 'iac.plan'".
      // Clearing the handler first keeps re-registration idempotent.
      await new IacController(makePulumi()).onModuleInit();
      expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith('iac.plan');
      expect(mockIpcMainRemoveHandler.mock.invocationCallOrder[0]).toBeLessThan(
        mockIpcMainHandle.mock.invocationCallOrder[0],
      );
    });

    it('should register ipcMain.handle for "iac.apply" so ipcRenderer.invoke can resolve', async () => {
      await new IacController(makePulumi()).onModuleInit();
      expect(mockIpcMainHandle).toHaveBeenCalledWith('iac.apply', expect.any(Function));
    });

    it('should remove any existing "iac.apply" handler before registering so hot-reload re-bootstrap does not throw', async () => {
      await new IacController(makePulumi()).onModuleInit();
      expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith('iac.apply');
    });

    it('should register ipcMain.handle for "iac.destroy" so ipcRenderer.invoke can resolve', async () => {
      await new IacController(makePulumi()).onModuleInit();
      expect(mockIpcMainHandle).toHaveBeenCalledWith('iac.destroy', expect.any(Function));
    });

    it('should remove any existing "iac.destroy" handler before registering so hot-reload re-bootstrap does not throw', async () => {
      await new IacController(makePulumi()).onModuleInit();
      expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith('iac.destroy');
    });

    it('should not manually register "iac.destroy.mintToken" — the generic bridge handles it', async () => {
      await new IacController(makePulumi()).onModuleInit();
      expect(mockIpcMainHandle).not.toHaveBeenCalledWith('iac.destroy.mintToken', expect.any(Function));
    });

    // -------------------------------------------------------------------------
    // "iac.rollback.confirm" must stay in this manual-registration set: left
    // off, it would fall through to the GENERIC ipcMain.handle bridge, which
    // invokes the underlying NestJS handler as `handler(payload, { evt })` via
    // the transport's own RpcContextCreator — but confirmRollback's `ctx`
    // parameter carries no `@Payload()`/etc decorator, so RpcContextCreator
    // would size its internal args array to the one decorated parameter it
    // saw and silently drop `ctx`, arriving as `undefined` at runtime and
    // throwing `TypeError: Cannot read properties of undefined (reading
    // 'evt')` on confirmRollback's first line. These tests prove both that
    // the registration exists AND that the registered callback constructs
    // `ctx` from `evt` correctly, dispatching through the same
    // `(evt, payload) => ...` shape the real ipcMain.handle callback fires
    // with, rather than calling controller.confirmRollback(payload, ctx)
    // directly.
    // -------------------------------------------------------------------------

    it('should register ipcMain.handle for "iac.rollback.confirm" so ipcRenderer.invoke can resolve', async () => {
      await new IacController(makePulumi()).onModuleInit();
      expect(mockIpcMainHandle).toHaveBeenCalledWith('iac.rollback.confirm', expect.any(Function));
    });

    it('should remove any existing "iac.rollback.confirm" handler before registering so hot-reload re-bootstrap does not throw', async () => {
      await new IacController(makePulumi()).onModuleInit();
      expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith('iac.rollback.confirm');
      const removeCalls = mockIpcMainRemoveHandler.mock.calls
        .map(([pattern]: [string]) => pattern)
        .filter((pattern: string) => pattern === 'iac.rollback.confirm');
      const handleCalls = mockIpcMainHandle.mock.calls
        .map(([pattern]: [string]) => pattern)
        .filter((pattern: string) => pattern === 'iac.rollback.confirm');
      expect(removeCalls).toHaveLength(1);
      expect(handleCalls).toHaveLength(1);
    });

    it('should invoke confirmRollback as confirmRollback(payload, { evt }) when the registered ipcMain.handle callback fires — the exact ctx-construction step the original bug dropped', async () => {
      const pulumi = makePulumi();
      const controller = new IacController(pulumi);
      const confirmRollbackSpy = vi
        .spyOn(controller, 'confirmRollback')
        .mockResolvedValue({ confirmed: false, error: 'stub' });

      await controller.onModuleInit();

      const [, registeredCallback] = mockIpcMainHandle.mock.calls.find(
        ([pattern]: [string]) => pattern === 'iac.rollback.confirm',
      ) as [string, (evt: unknown, payload: unknown) => unknown];
      expect(registeredCallback).toBeTypeOf('function');

      const fakeEvt = { sender: { id: 7 } };
      const payload = { applyRunId: 'apply-run-1' };
      await registeredCallback(fakeEvt, payload);

      expect(confirmRollbackSpy).toHaveBeenCalledWith(payload, { evt: fakeEvt });
    });
  });

  // -------------------------------------------------------------------------
  // initializeStack
  // -------------------------------------------------------------------------

  describe('initializeStack', () => {
    it('should return { started: true, streamId } immediately without waiting for the run to settle', async () => {
      const pulumi = makePulumi();
      let resolveInit!: () => void;
      vi.mocked(pulumi.initializeStack).mockReturnValue(
        new Promise<void>((resolve) => {
          resolveInit = resolve;
        }),
      );
      const { ctx } = makeCtx();

      const result = await new IacController(pulumi).initializeStack(undefined, ctx);

      expect(result.started).toBe(true);
      expect(typeof result.streamId).toBe('string');
      resolveInit();
    });

    it('should forward the mock streamId-tagged onPhase callback to PulumiService.initializeStack', async () => {
      const pulumi = makePulumi();
      const { ctx } = makeCtx();

      await new IacController(pulumi).initializeStack(undefined, ctx);

      expect(pulumi.initializeStack).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should send each onPhase event to the renderer via sender.send, tagged with streamId, on the chunk channel', async () => {
      const pulumi = makePulumi();
      vi.mocked(pulumi.initializeStack).mockImplementation(async (onPhase) => {
        onPhase?.('engine', 'start');
        onPhase?.('engine', 'end');
      });
      const { ctx, sender } = makeCtx();

      const result = await new IacController(pulumi).initializeStack(undefined, ctx);
      await flushPromises();

      expect(sender.send).toHaveBeenCalledWith('iac.stack.initialize.chunk', {
        streamId: result.streamId,
        phase: 'engine',
        status: 'start',
      });
      expect(sender.send).toHaveBeenCalledWith('iac.stack.initialize.chunk', {
        streamId: result.streamId,
        phase: 'engine',
        status: 'end',
      });
    });

    it('should send an end message with no error when the run succeeds', async () => {
      const pulumi = makePulumi();
      const { ctx, sender } = makeCtx();

      const result = await new IacController(pulumi).initializeStack(undefined, ctx);
      await flushPromises();

      expect(sender.send).toHaveBeenCalledWith('iac.stack.initialize.end', { streamId: result.streamId });
    });

    it('should send an end message with only streamId and error (no structured failedPhase field) when PulumiService.initializeStack throws a PulumiStackInitializationError', async () => {
      // `failedPhase` is not included in the renderer-facing end message —
      // it never reliably crosses the contextBridge (see
      // `IacController.initializeStack`'s own TSDoc, "Why no structured
      // failedPhase field"). The phase is still named in `error`'s prose
      // (via `PulumiStackInitializationError`'s own message format) and
      // still logged server-side with the structured field intact (see the
      // logger.error assertion below).
      const pulumi = makePulumi();
      vi.mocked(pulumi.initializeStack).mockRejectedValue(
        new PulumiStackInitializationError('plugins', new Error('network unreachable')),
      );
      const { ctx, sender } = makeCtx();

      const result = await new IacController(pulumi).initializeStack(undefined, ctx);
      await flushPromises();

      expect(sender.send).toHaveBeenCalledWith('iac.stack.initialize.end', {
        streamId: result.streamId,
        error: expect.stringContaining('plugins'),
      });
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'stack initialization error',
        expect.objectContaining({ failedPhase: 'plugins' }),
      );
    });

    it('should send an end message with only streamId and error for a non-PulumiStackInitializationError failure, logging failedPhase: undefined server-side', async () => {
      const pulumi = makePulumi();
      vi.mocked(pulumi.initializeStack).mockRejectedValue(new Error('unexpected'));
      const { ctx, sender } = makeCtx();

      const result = await new IacController(pulumi).initializeStack(undefined, ctx);
      await flushPromises();

      expect(sender.send).toHaveBeenCalledWith('iac.stack.initialize.end', {
        streamId: result.streamId,
        error: 'unexpected',
      });
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'stack initialization error',
        expect.objectContaining({ failedPhase: undefined }),
      );
    });

    it('should return a conflict ack naming the in-flight op and never call PulumiService.initializeStack when the workspace is busy', async () => {
      const pulumi = makePulumi();
      vi.mocked(pulumi.getOperationInFlight).mockReturnValue('up');
      const { ctx, sender } = makeCtx();

      const result = await new IacController(pulumi).initializeStack(undefined, ctx);

      expect(result).toEqual({ started: false, error: expect.any(String), conflict: 'up' });
      expect(pulumi.initializeStack).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('should not send further messages once the WebContents is destroyed', async () => {
      const pulumi = makePulumi();
      vi.mocked(pulumi.initializeStack).mockImplementation(async (onPhase) => {
        onPhase?.('engine', 'start');
        onPhase?.('engine', 'end');
      });
      const { ctx, sender } = makeCtx(true);

      await new IacController(pulumi).initializeStack(undefined, ctx);
      await flushPromises();

      expect(sender.send).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // plan
  // -------------------------------------------------------------------------

  describe('plan', () => {
    it('should return { started: true, runId } immediately without waiting for the run to settle', async () => {
      // PulumiService.preview never yields/returns on its own here, so if
      // plan() awaited the whole loop synchronously this call would hang.
      const pulumi = makePulumi();
      // eslint-disable-next-line require-yield -- generator intentionally never yields/returns to prove plan() doesn't await it
      vi.mocked(pulumi.preview).mockImplementation(async function* (): AsyncGenerator<PulumiRunChunk, PulumiPreviewResult | undefined> {
        await new Promise<void>(() => { /* never resolves */ });
        return undefined;
      });
      const { audit } = makeAudit();
      const { ctx } = makeCtx();

      const result = await new IacController(pulumi, audit).plan({}, ctx);

      expect(result).toEqual({ started: true, runId: expect.any(String) });
    });

    it('should send each yielded chunk to the renderer via sender.send, in order, tagged with runId', async () => {
      const chunks: PulumiRunChunk[] = [
        { stream: 'stdout', line: 'Previewing update...' },
        { stream: 'stdout', line: '+ 1 to create' },
      ];
      async function* yieldChunks(): AsyncGenerator<PulumiRunChunk, PulumiPreviewResult | undefined> {
        for (const chunk of chunks) yield chunk;
        return undefined;
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.preview).mockImplementation(yieldChunks);
      const { audit } = makeAudit();
      const { ctx, sender } = makeCtx();

      const result = await new IacController(pulumi, audit).plan({}, ctx);
      await flushPromises();

      const chunkCalls = sender.send.mock.calls.filter(([channel]) => channel === 'iac.plan.chunk');
      // Every chunk payload is tagged with the same runId already handed back
      // in the ack, so the renderer (and a rejected concurrent call) can tell
      // which run it belongs to.
      const runIds = new Set(chunkCalls.map(([, payload]) => (payload as { runId: string }).runId));
      expect(runIds).toEqual(new Set([result.runId]));
      expect(chunkCalls.map(([, payload]) => (payload as { chunk: PulumiRunChunk }).chunk)).toEqual(chunks);
    });

    it('should forward configVersionId, an AbortSignal, and the pre-minted runId to PulumiService.preview', async () => {
      const pulumi = makePulumi();
      const { audit } = makeAudit();
      const { ctx } = makeCtx();

      const result = await new IacController(pulumi, audit).plan({ configVersionId: 'v123' }, ctx);
      await flushPromises();

      expect(pulumi.preview).toHaveBeenCalledWith('v123', expect.any(AbortSignal), result.runId, undefined);
    });

    it('should forward rolledBackFrom to PulumiService.preview when present on the payload', async () => {
      const pulumi = makePulumi();
      const { audit } = makeAudit();
      const { ctx } = makeCtx();

      const result = await new IacController(pulumi, audit).plan(
        { configVersionId: 'v123', rolledBackFrom: 'apply-run-1' },
        ctx,
      );
      await flushPromises();

      expect(pulumi.preview).toHaveBeenCalledWith('v123', expect.any(AbortSignal), result.runId, 'apply-run-1');
    });

    it('should send an end message with exitCode 0, the resolved result, and no error when the run succeeds', async () => {
      const previewResult = buildPreviewResult();
      async function* succeeds(): AsyncGenerator<PulumiRunChunk, PulumiPreviewResult> {
        yield { stream: 'stdout', line: '+ 1 to create' };
        return previewResult;
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.preview).mockImplementation(succeeds);
      const { audit } = makeAudit();
      const { ctx, sender } = makeCtx();

      const result = await new IacController(pulumi, audit).plan({}, ctx);
      await flushPromises();

      expect(sender.send).toHaveBeenCalledWith('iac.plan.end', {
        runId: result.runId,
        exitCode: 0,
        result: previewResult,
      });
      const endCall = sender.send.mock.calls.find(([channel]) => channel === 'iac.plan.end');
      expect(endCall?.[1]).not.toHaveProperty('error');
    });

    it('should send an end message with exitCode null and a stringified error when PulumiService.preview throws mid-stream', async () => {
      async function* fails(): AsyncGenerator<PulumiRunChunk> {
        yield { stream: 'stderr', line: 'error: preflight checks failed' };
        throw new Error('preview failed: engine version mismatch');
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.preview).mockImplementation(fails);
      const { audit } = makeAudit();
      const { ctx, sender } = makeCtx();

      await new IacController(pulumi, audit).plan({}, ctx);
      await flushPromises();

      const endCall = sender.send.mock.calls.find(([channel]) => channel === 'iac.plan.end');
      expect(endCall?.[1]).toMatchObject({ exitCode: null });
      expect(String(endCall?.[1]?.error)).toContain('preview failed: engine version mismatch');
    });

    it('should not send further chunks or an end message, and should finalize the generator via stream.return, once the WebContents is destroyed', async () => {
      let returnCalled = false;
      async function* twoLines(): AsyncGenerator<PulumiRunChunk, PulumiPreviewResult | undefined> {
        try {
          yield { stream: 'stdout', line: 'first' };
          yield { stream: 'stdout', line: 'second' };
          return undefined;
        } finally {
          returnCalled = true;
        }
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.preview).mockImplementation(twoLines);
      const { audit } = makeAudit();
      // Simulate WebContents already destroyed before the loop runs.
      const { ctx, sender } = makeCtx(true);

      await new IacController(pulumi, audit).plan({}, ctx);
      await flushPromises();

      expect(sender.send).not.toHaveBeenCalled();
      expect(returnCalled).toBe(true);
    });

    it('should return a conflict ack naming the in-flight op and never call PulumiService.preview or record an audit entry when the workspace is busy', async () => {
      const pulumi = makePulumi();
      vi.mocked(pulumi.getOperationInFlight).mockReturnValue('up');
      const { audit, record } = makeAudit();
      const { ctx, sender } = makeCtx();

      const result = await new IacController(pulumi, audit).plan({}, ctx);
      await flushPromises();

      expect(result).toEqual({ started: false, error: expect.any(String), conflict: 'up' });
      expect(result.runId).toBeUndefined();
      expect(pulumi.preview).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('should record an audit entry with action "plan" for an accepted submission', async () => {
      async function* succeeds(): AsyncGenerator<PulumiRunChunk> {
        yield { stream: 'stdout', line: 'Previewing update...' };
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.preview).mockImplementation(succeeds);
      const { audit, record } = makeAudit();
      const { ctx } = makeCtx();

      await new IacController(pulumi, audit).plan({ configVersionId: 'v42' }, ctx);
      await flushPromises();

      expect(record).toHaveBeenCalledTimes(1);
      const recordedEntry = record.mock.calls[0][0] as RecordAuditEntryParams;
      expect(recordedEntry).toMatchObject({ action: 'plan', versionId: 'v42' });
    });

    // -------------------------------------------------------------------------
    // TOCTOU regression test: pins the load-bearing ordering where
    // `stream.next()` — which synchronously reserves the shared workspace
    // inside PulumiService.preview, before its own first `await` — happens
    // BEFORE `await this.audit?.record(...)`. If a future edit ever moved the
    // audit-record await above the `.next()` call, two concurrent plan
    // submissions could both pass the top-of-function
    // `getOperationInFlight()` busy check before either one actually reserves
    // the workspace.
    // -------------------------------------------------------------------------

    it('should never resolve { started: true } for a second concurrent submission while a plan is already in flight, even when audit.record() is slow', async () => {
      const pulumi = makePulumi();
      let inFlight: 'preview' | 'up' | 'destroy' | 'rollback' | null = null;
      vi.mocked(pulumi.getOperationInFlight).mockImplementation(() => inFlight);
      // Mirrors PulumiService.preview's own synchronous check-and-set of
      // operationInFlight, which runs before its own first `await` (see that
      // method's TSDoc). An async generator's body runs synchronously up to
      // its first internal `await`/`yield` the instant `.next()` is called —
      // even before the returned promise is itself awaited — so setting
      // `inFlight` here reproduces the exact ordering plan() depends on.
      // eslint-disable-next-line require-yield -- generator only needs to run its synchronous prefix; it never actually settles in this test
      async function* reservesThenHangs(): AsyncGenerator<PulumiRunChunk, PulumiPreviewResult | undefined> {
        inFlight = 'preview';
        await new Promise<void>(() => { /* never resolves — only the synchronous prefix matters here */ });
      }
      vi.mocked(pulumi.preview).mockImplementation(reservesThenHangs);
      let resolveAudit: (() => void) | undefined;
      const record = vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => { resolveAudit = resolve; }),
      );
      const audit: AuditService = { record } as unknown as AuditService;
      const controller = new IacController(pulumi, audit);
      const { ctx: ctx1 } = makeCtx();
      const { ctx: ctx2 } = makeCtx();

      // First submission: synchronously reserves the workspace via
      // stream.next(), then suspends on the slow audit.record() call before
      // it ever acks.
      const firstAckPromise = controller.plan({}, ctx1);

      // Second submission arrives while the first is still awaiting its slow
      // audit.record() call. If the reservation-before-audit ordering were
      // ever broken (audit.record() awaited before stream.next() reserves),
      // `inFlight` would still be `null` here and this would wrongly resolve
      // `{ started: true }`, racing the first submission.
      const secondAck = await controller.plan({}, ctx2);

      expect(secondAck).toEqual({ started: false, error: expect.any(String), conflict: 'preview' });
      expect(secondAck.runId).toBeUndefined();
      expect(pulumi.preview).toHaveBeenCalledTimes(1);

      resolveAudit?.();
      const firstAck = await firstAckPromise;
      expect(firstAck.started).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // apply
  // -------------------------------------------------------------------------

  describe('apply', () => {
    const APPLY_PAYLOAD = { planRunId: 'plan-run-1', planHash: 'plan-hash-abc' };

    it('should reject with { started: false, error } and never call PulumiService.apply when planRunId is missing', async () => {
      const pulumi = makePulumi();
      const { audit, record } = makeAudit();
      const { ctx, sender } = makeCtx();

      const result = await new IacController(pulumi, audit).apply({ planRunId: '', planHash: 'plan-hash-abc' }, ctx);

      expect(result.started).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(pulumi.apply).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('should reject with { started: false, error } and never call PulumiService.apply when planHash is missing', async () => {
      const pulumi = makePulumi();
      const { audit, record } = makeAudit();
      const { ctx } = makeCtx();

      const result = await new IacController(pulumi, audit).apply({ planRunId: 'plan-run-1', planHash: '' }, ctx);

      expect(result.started).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(pulumi.apply).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // The controller awaits the gate's first .next() call before acking.
    // PulumiService.apply's 8-step gate (plan lookup, approval/expiry,
    // plan-hash verification, engine-version check, durable lock
    // acquisition) is entirely self-contained inside the service — this
    // controller has nothing left to re-verify, so these tests exercise the
    // awaiting-first-.next() contract itself rather than re-deriving the
    // gate's own step-by-step behavior (already covered by PulumiService's
    // own test suite).
    // -----------------------------------------------------------------------

    it('should reject with { started: false, error } (no conflict) and never touch activeApplies or record an audit entry when the gate\'s first .next() rejects with a generic error', async () => {
      // eslint-disable-next-line require-yield -- generator must throw before yielding to simulate any non-lock gate failure (e.g. StalePlanError, expired approval, tampered artifact)
      async function* rejectsBeforeYield(): AsyncGenerator<PulumiRunChunk> {
        throw new Error('plan hash mismatch: the on-disk artifact no longer matches the approved plan');
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.apply).mockImplementation(rejectsBeforeYield);
      const { audit, record } = makeAudit();
      const { ctx, sender } = makeCtx();

      const result = await new IacController(pulumi, audit).apply(APPLY_PAYLOAD, ctx);

      expect(result.started).toBe(false);
      expect(result.conflict).toBeUndefined();
      expect(String(result.error)).toContain('plan hash mismatch');
      // A rejected gate never reaches the point where activeApplies is
      // populated or the streaming loop starts — no chunk/end messages, no
      // audit entry.
      expect(sender.send).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('should reject with { started: false, error, conflict: "up" } and never touch activeApplies or record an audit entry when the gate\'s first .next() rejects with RunLockHeldError', async () => {
      const heldLock: RunLock = {
        runId: 'other-run',
        kind: 'apply',
        initiator: 'someone-else',
        acquiredAt: '2026-07-21T00:00:00.000Z',
        expiresAt: '2026-07-21T01:00:00.000Z',
      };
      // eslint-disable-next-line require-yield -- generator must throw before yielding to simulate a lost durable-lock race
      async function* rejectsWithLock(): AsyncGenerator<PulumiRunChunk> {
        throw new RunLockHeldError(heldLock);
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.apply).mockImplementation(rejectsWithLock);
      const { audit, record } = makeAudit();
      const { ctx, sender } = makeCtx();

      const result = await new IacController(pulumi, audit).apply(APPLY_PAYLOAD, ctx);

      expect(result).toEqual({ started: false, error: expect.any(String), conflict: 'up' });
      expect(sender.send).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('should reject with { started: false, error, conflict: "preview" } and never touch activeApplies or record an audit entry when the gate\'s top-of-function operationInFlight busy check rejects with PulumiOperationInFlightError', async () => {
      // PulumiService.apply's own in-process operationInFlight mutex (checked
      // before any of the 8 gate steps) is cheaper and earlier than the
      // durable RunLockHeldError race above, and must also populate
      // `conflict` — a plain busy-mutex rejection must not fall into the
      // generic branch and lose the field the renderer's busy banner
      // (iac.page.tsx) reads.
      // eslint-disable-next-line require-yield -- generator must throw before yielding to simulate the top-of-function busy check
      async function* rejectsBusy(): AsyncGenerator<PulumiRunChunk> {
        throw new PulumiOperationInFlightError('preview');
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.apply).mockImplementation(rejectsBusy);
      const { audit, record } = makeAudit();
      const { ctx, sender } = makeCtx();

      const result = await new IacController(pulumi, audit).apply(APPLY_PAYLOAD, ctx);

      expect(result).toEqual({ started: false, error: expect.any(String), conflict: 'preview' });
      expect(sender.send).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('should call PulumiService.apply with planRunId, planHash, and an AbortSignal', async () => {
      const pulumi = makePulumi();
      const { audit } = makeAudit();
      const { ctx } = makeCtx();

      await new IacController(pulumi, audit).apply(APPLY_PAYLOAD, ctx);
      await flushPromises();

      expect(pulumi.apply).toHaveBeenCalledWith('plan-run-1', 'plan-hash-abc', expect.any(AbortSignal));
    });

    it('should only ack { started: true, runId } once the gate\'s first .next() has resolved — not before', async () => {
      let gateResolved = false;
      let resolveGate: (() => void) | undefined;
      // eslint-disable-next-line require-yield -- generator intentionally never yields, to prove apply() awaits the gate's first .next() before acking
      async function* waitsOnGate(): AsyncGenerator<PulumiRunChunk, PulumiUpResult | undefined> {
        await new Promise<void>((resolve) => {
          resolveGate = resolve;
        });
        gateResolved = true;
        return buildUpResult();
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.apply).mockImplementation(waitsOnGate);
      const { audit } = makeAudit();
      const { ctx } = makeCtx();

      const applyPromise = new IacController(pulumi, audit).apply(APPLY_PAYLOAD, ctx);
      // Give the call's synchronous prefix a chance to run and reach the
      // still-pending gate.
      await Promise.resolve();
      await Promise.resolve();
      expect(gateResolved).toBe(false);

      resolveGate?.();
      const result = await applyPromise;

      expect(gateResolved).toBe(true);
      expect(result).toEqual({ started: true, runId: 'plan-run-1' });
    });

    it('should record an audit entry with action "apply" for an accepted apply submission', async () => {
      const pulumi = makePulumi();
      const { audit, record } = makeAudit();
      const { ctx } = makeCtx();

      await new IacController(pulumi, audit).apply(APPLY_PAYLOAD, ctx);
      await flushPromises();

      expect(record).toHaveBeenCalledTimes(1);
      const recordedEntry = record.mock.calls[0]?.[0] as RecordAuditEntryParams;
      expect(recordedEntry).toMatchObject({ action: 'apply' });
    });

    it('should return { started: true, runId } equal to planRunId once the gate\'s first .next() resolves, then continue streaming', async () => {
      const chunks: PulumiRunChunk[] = [{ stream: 'stdout', line: 'aws:ecs:Cluster hyveon: creating' }];
      async function* succeeds(): AsyncGenerator<PulumiRunChunk, PulumiUpResult> {
        for (const chunk of chunks) yield chunk;
        return buildUpResult();
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.apply).mockImplementation(succeeds);
      const { audit } = makeAudit();
      const { ctx, sender } = makeCtx();

      const result = await new IacController(pulumi, audit).apply(APPLY_PAYLOAD, ctx);
      await flushPromises();

      expect(result).toEqual({ started: true, runId: 'plan-run-1' });
      const chunkCalls = sender.send.mock.calls.filter(([channel]) => channel === 'iac.apply.chunk');
      expect(chunkCalls.map(([, payload]) => (payload as { chunk: PulumiRunChunk }).chunk)).toEqual(chunks);
    });

    it('should send each yielded chunk to the renderer via sender.send, in order, tagged with the plan\'s runId', async () => {
      const chunks: PulumiRunChunk[] = [
        { stream: 'stdout', line: 'aws:ecs:Cluster hyveon: creating' },
        { stream: 'stdout', line: 'Update succeeded in 4s' },
      ];
      async function* yieldChunks(): AsyncGenerator<PulumiRunChunk, PulumiUpResult | undefined> {
        for (const chunk of chunks) yield chunk;
        return undefined;
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.apply).mockImplementation(yieldChunks);
      const { audit } = makeAudit();
      const { ctx, sender } = makeCtx();

      await new IacController(pulumi, audit).apply(APPLY_PAYLOAD, ctx);
      await flushPromises();

      const chunkCalls = sender.send.mock.calls.filter(([channel]) => channel === 'iac.apply.chunk');
      const runIds = new Set(chunkCalls.map(([, payload]) => (payload as { runId: string }).runId));
      expect(runIds).toEqual(new Set(['plan-run-1']));
      expect(chunkCalls.map(([, payload]) => (payload as { chunk: PulumiRunChunk }).chunk)).toEqual(chunks);
    });

    it('should send an end message with exitCode 0, the resolved result, and no error when the run succeeds', async () => {
      const upResult = buildUpResult();
      async function* succeeds(): AsyncGenerator<PulumiRunChunk, PulumiUpResult> {
        yield { stream: 'stdout', line: 'Update succeeded in 4s' };
        return upResult;
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.apply).mockImplementation(succeeds);
      const { audit } = makeAudit();
      const { ctx, sender } = makeCtx();

      await new IacController(pulumi, audit).apply(APPLY_PAYLOAD, ctx);
      await flushPromises();

      expect(sender.send).toHaveBeenCalledWith('iac.apply.end', {
        runId: 'plan-run-1',
        exitCode: 0,
        result: upResult,
      });
      const endCall = sender.send.mock.calls.find(([channel]) => channel === 'iac.apply.end');
      expect(endCall?.[1]).not.toHaveProperty('error');
    });

    it('should send an end message with exitCode null and a stringified error when PulumiService.apply throws mid-stream (after the gate already passed)', async () => {
      async function* failsMidStream(): AsyncGenerator<PulumiRunChunk> {
        yield { stream: 'stderr', line: 'error: resource creation failed' };
        throw new Error('stack.up() failed: resource creation error');
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.apply).mockImplementation(failsMidStream);
      const { audit } = makeAudit();
      const { ctx, sender } = makeCtx();

      await new IacController(pulumi, audit).apply(APPLY_PAYLOAD, ctx);
      await flushPromises();

      const endCall = sender.send.mock.calls.find(([channel]) => channel === 'iac.apply.end');
      expect(endCall?.[1]).toMatchObject({ exitCode: null });
      expect(String(endCall?.[1]?.error)).toContain('stack.up() failed: resource creation error');
    });

    it('should not send further chunks or an end message, and should finalize the generator via stream.return, once the WebContents is destroyed', async () => {
      let returnCalled = false;
      async function* twoLines(): AsyncGenerator<PulumiRunChunk, PulumiUpResult | undefined> {
        try {
          yield { stream: 'stdout', line: 'first' };
          yield { stream: 'stdout', line: 'second' };
          return undefined;
        } finally {
          returnCalled = true;
        }
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.apply).mockImplementation(twoLines);
      const { audit } = makeAudit();
      // Simulate WebContents already destroyed before the loop runs.
      const { ctx, sender } = makeCtx(true);

      await new IacController(pulumi, audit).apply(APPLY_PAYLOAD, ctx);
      await flushPromises();

      expect(sender.send).not.toHaveBeenCalled();
      expect(returnCalled).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // mintDestroyToken
  // -------------------------------------------------------------------------

  describe('mintDestroyToken', () => {
    it('should return the token minted by PulumiService.mintDestroyConfirmationToken', () => {
      const pulumi = makePulumi();
      const controller = new IacController(pulumi);

      const result = controller.mintDestroyToken();

      expect(pulumi.mintDestroyConfirmationToken).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ token: 'token-abc' });
    });
  });

  // -------------------------------------------------------------------------
  // destroy
  // -------------------------------------------------------------------------

  describe('destroy', () => {
    /** The `iac.destroy` payload matching {@link makePulumi}'s default `mintDestroyConfirmationToken` stub. */
    const DESTROY_PAYLOAD = { confirmationToken: 'token-abc' };

    it('should reject with { started: false, error } and never call PulumiService.destroy when confirmationToken is missing', async () => {
      const pulumi = makePulumi();
      const { audit, record } = makeAudit();
      const { ctx, sender } = makeCtx();

      const result = await new IacController(pulumi, audit).destroy({ confirmationToken: '' }, ctx);

      expect(result.started).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(pulumi.destroy).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Mirrors apply()'s awaiting-first-.next() tests — PulumiService.destroy's
    // own gate (busy check, config-presence checks, single-use token
    // consumption, durable lock acquisition) is entirely self-contained.
    // -----------------------------------------------------------------------

    it('should reject with { started: false, error } (no conflict) and never touch activeDestroys or record an audit entry when the gate\'s first .next() rejects with a generic error (e.g. DestroyNotConfirmedError)', async () => {
      // eslint-disable-next-line require-yield -- generator must throw before yielding to simulate an unconfirmed/stale/consumed token
      async function* rejectsBeforeYield(): AsyncGenerator<PulumiRunChunk> {
        throw new Error('DestroyNotConfirmedError: no matching confirmation token');
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.destroy).mockImplementation(rejectsBeforeYield);
      const { audit, record } = makeAudit();
      const { ctx, sender } = makeCtx();

      const result = await new IacController(pulumi, audit).destroy(DESTROY_PAYLOAD, ctx);

      expect(result.started).toBe(false);
      expect(result.conflict).toBeUndefined();
      expect(String(result.error)).toContain('DestroyNotConfirmedError');
      expect(sender.send).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('should reject with { started: false, error, conflict: "destroy" } and never touch activeDestroys or record an audit entry when the gate\'s first .next() rejects with RunLockHeldError', async () => {
      const heldLock: RunLock = {
        runId: 'other-run',
        kind: 'destroy',
        initiator: 'someone-else',
        acquiredAt: '2026-07-21T00:00:00.000Z',
        expiresAt: '2026-07-21T01:00:00.000Z',
      };
      // eslint-disable-next-line require-yield -- generator must throw before yielding to simulate a lost durable-lock race
      async function* rejectsWithLock(): AsyncGenerator<PulumiRunChunk> {
        throw new RunLockHeldError(heldLock);
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.destroy).mockImplementation(rejectsWithLock);
      const { audit, record } = makeAudit();
      const { ctx, sender } = makeCtx();

      const result = await new IacController(pulumi, audit).destroy(DESTROY_PAYLOAD, ctx);

      expect(result).toEqual({ started: false, error: expect.any(String), conflict: 'destroy' });
      expect(sender.send).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('should reject with { started: false, error, conflict: "up" } and never touch activeDestroys or record an audit entry when the gate\'s top-of-function operationInFlight busy check rejects with PulumiOperationInFlightError', async () => {
      // Mirrors the equivalent apply() test — see that test's comment for
      // why the in-process busy mutex needs the exact same `conflict`
      // treatment as the durable RunLockHeldError race above.
      // eslint-disable-next-line require-yield -- generator must throw before yielding to simulate the top-of-function busy check
      async function* rejectsBusy(): AsyncGenerator<PulumiRunChunk> {
        throw new PulumiOperationInFlightError('up');
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.destroy).mockImplementation(rejectsBusy);
      const { audit, record } = makeAudit();
      const { ctx, sender } = makeCtx();

      const result = await new IacController(pulumi, audit).destroy(DESTROY_PAYLOAD, ctx);

      expect(result).toEqual({ started: false, error: expect.any(String), conflict: 'up' });
      expect(sender.send).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('should mint a fresh runId and call PulumiService.destroy with the confirmationToken, an AbortSignal, and that same runId', async () => {
      const pulumi = makePulumi();
      const { audit } = makeAudit();
      const { ctx } = makeCtx();

      const result = await new IacController(pulumi, audit).destroy(DESTROY_PAYLOAD, ctx);
      await flushPromises();

      expect(typeof result.runId).toBe('string');
      expect(pulumi.destroy).toHaveBeenCalledWith('token-abc', expect.any(AbortSignal), result.runId);
    });

    it('should record an audit entry with action "destroy" for an accepted destroy submission', async () => {
      const pulumi = makePulumi();
      const { audit, record } = makeAudit();
      const { ctx } = makeCtx();

      await new IacController(pulumi, audit).destroy(DESTROY_PAYLOAD, ctx);
      await flushPromises();

      expect(record).toHaveBeenCalledTimes(1);
      const recordedEntry = record.mock.calls[0]?.[0] as RecordAuditEntryParams;
      expect(recordedEntry).toMatchObject({ action: 'destroy' });
    });

    it('should return { started: true, runId } once the gate\'s first .next() resolves, then continue streaming, tagged with that runId', async () => {
      const chunks: PulumiRunChunk[] = [
        { stream: 'stdout', line: 'aws:ecs:Cluster hyveon: deleting' },
        { stream: 'stdout', line: 'Destroy succeeded in 6s' },
      ];
      async function* yieldChunks(): AsyncGenerator<PulumiRunChunk, PulumiDestroyResult | undefined> {
        for (const chunk of chunks) yield chunk;
        return undefined;
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.destroy).mockImplementation(yieldChunks);
      const { audit } = makeAudit();
      const { ctx, sender } = makeCtx();

      const result = await new IacController(pulumi, audit).destroy(DESTROY_PAYLOAD, ctx);
      await flushPromises();

      expect(result.started).toBe(true);
      const chunkCalls = sender.send.mock.calls.filter(([channel]) => channel === 'iac.destroy.chunk');
      const runIds = new Set(chunkCalls.map(([, payload]) => (payload as { runId: string }).runId));
      expect(runIds).toEqual(new Set([result.runId]));
      expect(chunkCalls.map(([, payload]) => (payload as { chunk: PulumiRunChunk }).chunk)).toEqual(chunks);
    });

    it('should send an end message with exitCode 0, the resolved result, and no error when the run succeeds', async () => {
      const destroyResult = buildDestroyResult();
      async function* succeeds(): AsyncGenerator<PulumiRunChunk, PulumiDestroyResult> {
        yield { stream: 'stdout', line: 'Destroy succeeded in 6s' };
        return destroyResult;
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.destroy).mockImplementation(succeeds);
      const { audit } = makeAudit();
      const { ctx, sender } = makeCtx();

      const result = await new IacController(pulumi, audit).destroy(DESTROY_PAYLOAD, ctx);
      await flushPromises();

      const endCall = sender.send.mock.calls.find(([channel]) => channel === 'iac.destroy.end');
      expect(endCall?.[1]).toEqual({ runId: result.runId, exitCode: 0, result: destroyResult });
      expect(endCall?.[1]).not.toHaveProperty('error');
    });

    it('should send an end message with exitCode null and a stringified error when PulumiService.destroy throws mid-stream (after the gate already passed)', async () => {
      async function* failsMidStream(): AsyncGenerator<PulumiRunChunk> {
        yield { stream: 'stderr', line: 'error: dependency violation' };
        throw new Error('stack.destroy() failed: dependency violation');
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.destroy).mockImplementation(failsMidStream);
      const { audit } = makeAudit();
      const { ctx, sender } = makeCtx();

      await new IacController(pulumi, audit).destroy(DESTROY_PAYLOAD, ctx);
      await flushPromises();

      const endCall = sender.send.mock.calls.find(([channel]) => channel === 'iac.destroy.end');
      expect(endCall?.[1]).toMatchObject({ exitCode: null });
      expect(String(endCall?.[1]?.error)).toContain('stack.destroy() failed: dependency violation');
    });

    it('should not send further chunks or an end message, and should finalize the generator via stream.return, once the WebContents is destroyed', async () => {
      let returnCalled = false;
      async function* twoLines(): AsyncGenerator<PulumiRunChunk, PulumiDestroyResult | undefined> {
        try {
          yield { stream: 'stdout', line: 'first' };
          yield { stream: 'stdout', line: 'second' };
          return undefined;
        } finally {
          returnCalled = true;
        }
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.destroy).mockImplementation(twoLines);
      const { audit } = makeAudit();
      // Simulate WebContents already destroyed before the loop runs.
      const { ctx, sender } = makeCtx(true);

      await new IacController(pulumi, audit).destroy(DESTROY_PAYLOAD, ctx);
      await flushPromises();

      expect(sender.send).not.toHaveBeenCalled();
      expect(returnCalled).toBe(true);
    });

    it('should surface a run visible via iac.runs.get by tagging every message with the same runId returned in the ack', async () => {
      // Sanity check that the pre-minted runId used for the PulumiService.destroy()
      // call and every chunk/end message are all identical — this is what
      // lets the renderer (and iac.runs.get, backed by the same runId)
      // find the run afterward.
      const chunks: PulumiRunChunk[] = [{ stream: 'stdout', line: 'aws:ecs:Cluster hyveon: deleting' }];
      async function* yieldChunks(): AsyncGenerator<PulumiRunChunk, PulumiDestroyResult | undefined> {
        for (const chunk of chunks) yield chunk;
        return undefined;
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.destroy).mockImplementation(yieldChunks);
      const { audit } = makeAudit();
      const { ctx, sender } = makeCtx();

      const result = await new IacController(pulumi, audit).destroy(DESTROY_PAYLOAD, ctx);
      await flushPromises();

      const [destroyToken, destroySignal, destroyRunId] = vi.mocked(pulumi.destroy).mock.calls[0] as [
        string,
        AbortSignal,
        string,
      ];
      const chunkRunId = (sender.send.mock.calls.find(([channel]) => channel === 'iac.destroy.chunk')?.[1] as {
        runId: string;
      }).runId;

      expect(destroyToken).toBe('token-abc');
      expect(destroyRunId).toBe(result.runId);
      expect(chunkRunId).toBe(result.runId);
      expect(destroySignal).toBeInstanceOf(AbortSignal);
    });
  });

  // -------------------------------------------------------------------------
  // output
  // -------------------------------------------------------------------------

  describe('output', () => {
    /** A minimal `StackOutputs` fixture shared across the "output" cases. */
    const OUTPUTS: StackOutputs = {
      awsRegion: 'us-east-1',
      ecsClusterName: 'hyveon-cluster',
      ecsClusterArn: 'arn:aws:ecs:us-east-1:123:cluster/hyveon-cluster',
      subnetIds: ['subnet-1'],
      securityGroupId: 'sg-1',
      fileManagerSecurityGroupId: 'sg-2',
      efsFileSystemId: 'fs-1',
      efsAccessPoints: {},
      domainName: 'example.com',
      gameNames: ['minecraft'],
      discordTableName: 'discord-table',
      auditTableName: 'audit-table',
      runsTableName: 'runs-table',
      discordBotTokenSecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:bot',
      discordPublicKeySecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:pubkey',
      fileBrowserCredentialSecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:filebrowser-credential',
      fileBrowserSchedulerRoleArn: 'arn:aws:iam::123:role/filebrowser-scheduler',
      interactionsInvokeUrl: null,
      discordInteractionsUrl: null,
      appliedGameServers: null,
    };

    it('should resolve with whatever ConfigService.getStackOutputs resolves with, when a ConfigService is wired', async () => {
      const pulumi = makePulumi();
      const { config } = makeConfig(OUTPUTS);

      const result = await new IacController(pulumi, undefined, undefined, config).output({});

      expect(result).toBe(OUTPUTS);
    });

    it('should fall back to PulumiService.getStackOutputs directly when no ConfigService is wired', async () => {
      const pulumi = makePulumi();
      vi.mocked(pulumi.getStackOutputs).mockResolvedValue(OUTPUTS);

      const result = await new IacController(pulumi).output({});

      expect(result).toBe(OUTPUTS);
      expect(pulumi.getStackOutputs).toHaveBeenCalledTimes(1);
    });

    it('should resolve null when the stack has never been deployed', async () => {
      const pulumi = makePulumi();
      const { config } = makeConfig(null);

      const result = await new IacController(pulumi, undefined, undefined, config).output({});

      expect(result).toBeNull();
    });

    it('should ignore payload.force — no cache-bypass behavior exists any more', async () => {
      const pulumi = makePulumi();
      const { config, getStackOutputs } = makeConfig(OUTPUTS);

      await new IacController(pulumi, undefined, undefined, config).output({ force: true });

      // force is accepted (kept for payload compatibility) but never
      // forwarded anywhere — ConfigService.getStackOutputs takes no
      // arguments under the Pulumi engine.
      expect(getStackOutputs).toHaveBeenCalledWith();
    });

    it('should default the payload to {} when no payload is provided at all', async () => {
      const pulumi = makePulumi();
      const { config } = makeConfig(OUTPUTS);

      const result = await new IacController(pulumi, undefined, undefined, config).output(undefined);

      expect(result).toBe(OUTPUTS);
    });
  });

  // -------------------------------------------------------------------------
  // approve
  // -------------------------------------------------------------------------

  describe('approve', () => {
    it('should write approvedBy/approvedAt to the run record, using the OS-resolved username, and return them on a successful plan run', async () => {
      const pulumi = makePulumi();
      const { runRecord, approveRun } = makeRunRecord();
      const { audit, record } = makeAudit();

      const result = await new IacController(pulumi, audit, runRecord).approve({
        planRunId: 'run-123',
      });

      // The approver identity is always resolved server-side from
      // os.userInfo() — never taken from the (now nonexistent) client
      // payload field — so approveRun must be called with the stubbed OS
      // username rather than anything the caller supplied.
      expect(approveRun).toHaveBeenCalledWith('run-123', 'test-operator');
      expect(result).toEqual({
        approved: true,
        approvedBy: 'test-operator',
        approvedAt: expect.any(String),
      });
      expect(record).toHaveBeenCalledTimes(1);
      const recordedEntry = record.mock.calls[0][0] as RecordAuditEntryParams;
      expect(recordedEntry).toMatchObject({ action: 'approve' });
    });

    it('should return { approved: false, error } and never call RunRecordService.approveRun or AuditService.record when planRunId is missing', async () => {
      const pulumi = makePulumi();
      const { runRecord, approveRun } = makeRunRecord();
      const { audit, record } = makeAudit();

      const result = await new IacController(pulumi, audit, runRecord).approve({
        planRunId: '',
      });

      expect(result.approved).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(approveRun).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('should return { approved: false, error } when the run-history table is not configured, without writing anything or recording an audit entry', async () => {
      const pulumi = makePulumi();
      const { runRecord, approveRun } = makeRunRecord();
      const { audit, record } = makeAudit();
      const error = new RunRecordTableNotConfiguredError('run-123');
      approveRun.mockRejectedValue(error);

      const result = await new IacController(pulumi, audit, runRecord).approve({
        planRunId: 'run-123',
      });

      expect(result).toEqual({ approved: false, error: error.message });
      expect(record).not.toHaveBeenCalled();
    });

    it('should return { approved: false, error } when no run record exists for planRunId, without writing anything or recording an audit entry', async () => {
      const pulumi = makePulumi();
      const { runRecord, approveRun } = makeRunRecord();
      const { audit, record } = makeAudit();
      const error = new RunRecordNotFoundError('run-123');
      approveRun.mockRejectedValue(error);

      const result = await new IacController(pulumi, audit, runRecord).approve({
        planRunId: 'run-123',
      });

      expect(result).toEqual({ approved: false, error: error.message });
      expect(record).not.toHaveBeenCalled();
    });

    it('should return { approved: false, error } when the run record is not a plan run, without writing anything or recording an audit entry', async () => {
      const pulumi = makePulumi();
      const { runRecord, approveRun } = makeRunRecord();
      const { audit, record } = makeAudit();
      const error = new RunRecordNotPlanError('run-123', 'apply');
      approveRun.mockRejectedValue(error);

      const result = await new IacController(pulumi, audit, runRecord).approve({
        planRunId: 'run-123',
      });

      expect(result).toEqual({ approved: false, error: error.message });
      expect(record).not.toHaveBeenCalled();
    });

    it('should return { approved: false, error } when the plan run did not succeed, without writing anything or recording an audit entry', async () => {
      const pulumi = makePulumi();
      const { runRecord, approveRun } = makeRunRecord();
      const { audit, record } = makeAudit();
      const error = new RunRecordNotSuccessfulError('run-123', 'failed');
      approveRun.mockRejectedValue(error);

      const result = await new IacController(pulumi, audit, runRecord).approve({
        planRunId: 'run-123',
      });

      expect(result).toEqual({ approved: false, error: error.message });
      expect(record).not.toHaveBeenCalled();
    });

    it('should return { approved: false, error } when no RunRecordService is available', async () => {
      const pulumi = makePulumi();

      const result = await new IacController(pulumi).approve({
        planRunId: 'run-123',
      });

      expect(result.approved).toBe(false);
      expect(typeof result.error).toBe('string');
    });
  });

  // -------------------------------------------------------------------------
  // resolveRollback
  // -------------------------------------------------------------------------

  describe('resolveRollback', () => {
    it('should return resolved: true with the target versionId and lastModified on success', async () => {
      const pulumi = makePulumi();

      const result = await new IacController(pulumi).resolveRollback({
        applyRunId: 'apply-run-1',
      });

      expect(pulumi.resolveRollbackTarget).toHaveBeenCalledWith('apply-run-1');
      expect(result).toEqual({
        resolved: true,
        versionId: 'config-v-prior',
        lastModified: '2026-07-20T00:00:00.000Z',
      });
    });

    it('should return { resolved: false, error } and never call PulumiService.resolveRollbackTarget when applyRunId is missing', async () => {
      const pulumi = makePulumi();

      const result = await new IacController(pulumi).resolveRollback({
        applyRunId: '',
      });

      expect(result.resolved).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(pulumi.resolveRollbackTarget).not.toHaveBeenCalled();
    });

    it('should return { resolved: false, error } with the thrown error message when resolution fails', async () => {
      const pulumi = makePulumi();
      const error = new Error('RollbackVersionMissingError: version config-v-expired no longer exists');
      vi.mocked(pulumi.resolveRollbackTarget).mockRejectedValue(error);

      const result = await new IacController(pulumi).resolveRollback({
        applyRunId: 'apply-run-1',
      });

      expect(result).toEqual({ resolved: false, error: error.message });
    });

    it('should include diff when PulumiService.computeRollbackDiff resolves one, called with the resolved target versionId', async () => {
      const pulumi = makePulumi();
      const diff: DeploymentConfigDiff = {
        changedFields: ['dnsTtl'],
        gameServers: { added: ['valheim'], removed: [], changed: [] },
      };
      vi.mocked(pulumi.computeRollbackDiff).mockResolvedValue(diff);

      const result = await new IacController(pulumi).resolveRollback({
        applyRunId: 'apply-run-1',
      });

      expect(pulumi.computeRollbackDiff).toHaveBeenCalledWith('config-v-prior');
      expect(result).toEqual({
        resolved: true,
        versionId: 'config-v-prior',
        lastModified: '2026-07-20T00:00:00.000Z',
        diff,
      });
    });

    it('should omit diff (never fail the whole resolution) when computeRollbackDiff resolves undefined', async () => {
      const pulumi = makePulumi();
      vi.mocked(pulumi.computeRollbackDiff).mockResolvedValue(undefined);

      const result = await new IacController(pulumi).resolveRollback({
        applyRunId: 'apply-run-1',
      });

      expect(result).toEqual({
        resolved: true,
        versionId: 'config-v-prior',
        lastModified: '2026-07-20T00:00:00.000Z',
      });
      expect(result.diff).toBeUndefined();
    });

    it('should still resolve: true with the target identified when computeRollbackDiff unexpectedly rejects', async () => {
      const pulumi = makePulumi();
      vi.mocked(pulumi.computeRollbackDiff).mockRejectedValue(new Error('unexpected diff failure'));

      const result = await new IacController(pulumi).resolveRollback({
        applyRunId: 'apply-run-1',
      });

      expect(result).toEqual({
        resolved: true,
        versionId: 'config-v-prior',
        lastModified: '2026-07-20T00:00:00.000Z',
      });
    });
  });

  // -------------------------------------------------------------------------
  // confirmRollback — a structurally distinct streaming shape
  // -------------------------------------------------------------------------

  describe('confirmRollback', () => {
    it('should return { confirmed: false, error } and never call PulumiService.confirmRollback when applyRunId is missing', async () => {
      const pulumi = makePulumi();
      const { ctx } = makeCtx();

      const result = await new IacController(pulumi).confirmRollback({ applyRunId: '' }, ctx);

      expect(result.confirmed).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(pulumi.confirmRollback).not.toHaveBeenCalled();
    });

    it('should drive the generator to completion, forwarding every intermediate chunk on iac.rollback.confirm.chunk tagged with applyRunId', async () => {
      const chunks: PulumiRunChunk[] = [
        { stream: 'stdout', line: 'Previewing update (rollback)...' },
        { stream: 'stdout', line: '+ 1 to create' },
      ];
      async function* yieldsThenSettles(): AsyncGenerator<PulumiRunChunk, PulumiPreviewResult> {
        for (const chunk of chunks) yield chunk;
        return buildPreviewResult({ runId: 'rollback-plan-run-1' });
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.confirmRollback).mockImplementation(yieldsThenSettles);
      vi.mocked(pulumi.readRunRecord).mockReturnValue(buildRunRecord());
      const { ctx, sender } = makeCtx();

      const result = await new IacController(pulumi).confirmRollback({ applyRunId: 'apply-run-1' }, ctx);

      expect(result).toEqual({ confirmed: true, versionId: 'config-v-new-head' });
      const chunkCalls = sender.send.mock.calls.filter(([channel]) => channel === 'iac.rollback.confirm.chunk');
      expect(chunkCalls).toEqual([
        ['iac.rollback.confirm.chunk', { applyRunId: 'apply-run-1', chunk: chunks[0] }],
        ['iac.rollback.confirm.chunk', { applyRunId: 'apply-run-1', chunk: chunks[1] }],
      ]);
    });

    it('should call PulumiService.readRunRecord with the settled result\'s runId to recover the restored version id', async () => {
      // eslint-disable-next-line require-yield -- generator settles immediately with no intermediate chunks
      async function* settles(): AsyncGenerator<PulumiRunChunk, PulumiPreviewResult> {
        return buildPreviewResult({ runId: 'rollback-plan-run-42' });
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.confirmRollback).mockImplementation(settles);
      vi.mocked(pulumi.readRunRecord).mockReturnValue(
        buildRunRecord({ runId: 'rollback-plan-run-42', configVersionId: 'config-v-recovered' }),
      );
      const { ctx } = makeCtx();

      const result = await new IacController(pulumi).confirmRollback({ applyRunId: 'apply-run-1' }, ctx);

      expect(pulumi.readRunRecord).toHaveBeenCalledWith('rollback-plan-run-42');
      expect(result).toEqual({ confirmed: true, versionId: 'config-v-recovered' });
    });

    it('should only resolve the ack once the whole restore+plan generator has settled — not before', async () => {
      let settled = false;
      let resolveGenerator: (() => void) | undefined;
      async function* waitsThenSettles(): AsyncGenerator<PulumiRunChunk, PulumiPreviewResult> {
        yield { stream: 'stdout', line: 'restoring historic configuration...' };
        await new Promise<void>((resolve) => {
          resolveGenerator = resolve;
        });
        settled = true;
        return buildPreviewResult();
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.confirmRollback).mockImplementation(waitsThenSettles);
      vi.mocked(pulumi.readRunRecord).mockReturnValue(buildRunRecord());
      const { ctx } = makeCtx();

      const ackPromise = new IacController(pulumi).confirmRollback({ applyRunId: 'apply-run-1' }, ctx);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);

      resolveGenerator?.();
      const result = await ackPromise;

      expect(settled).toBe(true);
      expect(result.confirmed).toBe(true);
    });

    it('should record an audit entry with action "rollback" and the new head versionId on success', async () => {
      // eslint-disable-next-line require-yield -- generator settles immediately with no intermediate chunks
      async function* settles(): AsyncGenerator<PulumiRunChunk, PulumiPreviewResult> {
        return buildPreviewResult();
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.confirmRollback).mockImplementation(settles);
      vi.mocked(pulumi.readRunRecord).mockReturnValue(buildRunRecord());
      const { audit, record } = makeAudit();
      const { ctx } = makeCtx();

      await new IacController(pulumi, audit).confirmRollback({ applyRunId: 'apply-run-1' }, ctx);

      expect(record).toHaveBeenCalledTimes(1);
      const recordedEntry = record.mock.calls[0]?.[0] as RecordAuditEntryParams;
      expect(recordedEntry).toMatchObject({ action: 'rollback', versionId: 'config-v-new-head' });
    });

    it('should return { confirmed: false, error } with the thrown error message and write nothing when the restore-then-plan unit fails', async () => {
      const pulumi = makePulumi();
      const error = new Error('PulumiRollbackPlanFailedError: restore succeeded but the follow-up plan failed');
      vi.mocked(pulumi.confirmRollback).mockImplementation(() => {
        throw error;
      });
      const { audit, record } = makeAudit();
      const { ctx } = makeCtx();

      const result = await new IacController(pulumi, audit).confirmRollback({ applyRunId: 'apply-run-1' }, ctx);

      expect(result).toEqual({ confirmed: false, error: error.message });
      expect(record).not.toHaveBeenCalled();
    });

    it('should return a well-formed { confirmed: false, error } ack — not a crash — when the generator settles with an undefined result (aborted mid-run)', async () => {
      // Only reachable if `signal` aborted mid-run before the generator
      // returned a real PulumiPreviewResult — defensive branch, not the
      // normal "aborted via thrown error" path.
      // eslint-disable-next-line require-yield -- generator settles immediately with no intermediate chunks
      async function* settlesWithUndefined(): AsyncGenerator<PulumiRunChunk, PulumiPreviewResult | undefined> {
        return undefined;
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.confirmRollback).mockImplementation(settlesWithUndefined);
      const { audit, record } = makeAudit();
      const { ctx } = makeCtx();

      const result = await new IacController(pulumi, audit).confirmRollback({ applyRunId: 'apply-run-1' }, ctx);

      expect(result.confirmed).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(pulumi.readRunRecord).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('should return { confirmed: false, error } — not a "confirmed: true" ack with no versionId — when readRunRecord finds no record for the settled runId', async () => {
      // eslint-disable-next-line require-yield -- generator settles immediately with no intermediate chunks
      async function* settles(): AsyncGenerator<PulumiRunChunk, PulumiPreviewResult> {
        return buildPreviewResult({ runId: 'rollback-plan-run-1' });
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.confirmRollback).mockImplementation(settles);
      vi.mocked(pulumi.readRunRecord).mockReturnValue(null);
      const { audit, record } = makeAudit();
      const { ctx } = makeCtx();

      const result = await new IacController(pulumi, audit).confirmRollback({ applyRunId: 'apply-run-1' }, ctx);

      expect(result.confirmed).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(record).not.toHaveBeenCalled();
    });

    it('should return { confirmed: false, error } — the defensive branch — when the recovered record has no configVersionId', async () => {
      // eslint-disable-next-line require-yield -- generator settles immediately with no intermediate chunks
      async function* settles(): AsyncGenerator<PulumiRunChunk, PulumiPreviewResult> {
        return buildPreviewResult({ runId: 'rollback-plan-run-1' });
      }
      const pulumi = makePulumi();
      vi.mocked(pulumi.confirmRollback).mockImplementation(settles);
      vi.mocked(pulumi.readRunRecord).mockReturnValue(buildRunRecord({ configVersionId: undefined }));
      const { audit, record } = makeAudit();
      const { ctx } = makeCtx();

      const result = await new IacController(pulumi, audit).confirmRollback({ applyRunId: 'apply-run-1' }, ctx);

      expect(result.confirmed).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(record).not.toHaveBeenCalled();
    });

    it('should not record an audit entry when confirmation fails', async () => {
      const pulumi = makePulumi();
      const error = new Error('RollbackVersionMissingError: version config-v-expired no longer exists');
      vi.mocked(pulumi.confirmRollback).mockImplementation(() => {
        throw error;
      });
      const { audit, record } = makeAudit();
      const { ctx } = makeCtx();

      await new IacController(pulumi, audit).confirmRollback({ applyRunId: 'apply-run-1' }, ctx);

      expect(record).not.toHaveBeenCalled();
    });

    it('should return { confirmed: false, versionId, error } — surfacing the version that WAS restored — when the restore-then-plan unit fails with PulumiRollbackPlanFailedError', async () => {
      // The restore write succeeded (the config version named by
      // restoredVersionId is now the new head) even though the follow-up
      // plan inside PulumiService.confirmRollback failed. That fact must be
      // readable programmatically, not just out of err.message's prose, so a
      // caller can act on it (e.g. offer "plan against the restored version"
      // as a next step).
      const pulumi = makePulumi();
      const error = new PulumiRollbackPlanFailedError(
        'apply-run-1',
        'config-v-restored-but-orphaned',
        new Error('pulumi preview failed: engine version mismatch'),
      );
      vi.mocked(pulumi.confirmRollback).mockImplementation(() => {
        throw error;
      });
      const { audit, record } = makeAudit();
      const { ctx } = makeCtx();

      const result = await new IacController(pulumi, audit).confirmRollback({ applyRunId: 'apply-run-1' }, ctx);

      expect(result).toEqual({
        confirmed: false,
        versionId: 'config-v-restored-but-orphaned',
        error: error.message,
      });
      expect(record).not.toHaveBeenCalled();
    });
  });

  describe('clearStaleLock', () => {
    /** The `iac.lock.clear` payload matching {@link makePulumi}'s default `mintLockClearConfirmationToken` stub. */
    const LOCK_CLEAR_PAYLOAD = { confirmationToken: 'lock-clear-token-abc' };

    it('should return { cleared: true } and delegate to PulumiService.clearStaleLock(token) when PulumiService.clearStaleLock resolves', async () => {
      const pulumi = makePulumi();

      const result = await new IacController(pulumi).clearStaleLock(LOCK_CLEAR_PAYLOAD);

      expect(result).toEqual({ cleared: true });
      expect(pulumi.clearStaleLock).toHaveBeenCalledTimes(1);
      expect(pulumi.clearStaleLock).toHaveBeenCalledWith('lock-clear-token-abc');
    });

    it('should return { cleared: false, error } and never call PulumiService.clearStaleLock when confirmationToken is missing', async () => {
      const pulumi = makePulumi();

      const result = await new IacController(pulumi).clearStaleLock({ confirmationToken: '' });

      expect(result.cleared).toBe(false);
      expect(result.error).toMatch(/non-empty confirmationToken/i);
      expect(pulumi.clearStaleLock).not.toHaveBeenCalled();
    });

    it('should return { cleared: false, error } naming the in-flight operation when PulumiService.clearStaleLock rejects with PulumiOperationInFlightError', async () => {
      const pulumi = makePulumi();
      vi.mocked(pulumi.clearStaleLock).mockRejectedValue(new PulumiOperationInFlightError('up'));

      const result = await new IacController(pulumi).clearStaleLock(LOCK_CLEAR_PAYLOAD);

      expect(result.cleared).toBe(false);
      expect(result.error).toMatch(/up.*already running/i);
    });

    it('should return { cleared: false, error } when PulumiService.clearStaleLock rejects with any other error, without throwing', async () => {
      const pulumi = makePulumi();
      vi.mocked(pulumi.clearStaleLock).mockRejectedValue(new Error('pulumi stack.cancel() failed while clearing the stale backend lock: boom'));

      const result = await new IacController(pulumi).clearStaleLock(LOCK_CLEAR_PAYLOAD);

      expect(result).toEqual({
        cleared: false,
        error: 'pulumi stack.cancel() failed while clearing the stale backend lock: boom',
      });
    });
  });

  // -------------------------------------------------------------------------
  // mintLockClearToken
  // -------------------------------------------------------------------------

  describe('mintLockClearToken', () => {
    it('should return the token minted by PulumiService.mintLockClearConfirmationToken', () => {
      const pulumi = makePulumi();
      const controller = new IacController(pulumi);

      const result = controller.mintLockClearToken();

      expect(pulumi.mintLockClearConfirmationToken).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ token: 'lock-clear-token-abc' });
    });
  });
});
