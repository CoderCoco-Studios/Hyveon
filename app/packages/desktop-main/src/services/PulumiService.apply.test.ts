/**
 * Unit tests for `PulumiService.apply` (task 7.2 of `migrate-iac-to-pulumi`)
 * — the self-contained 8-step plan-hash gate (tasks 7.5/7.7) plus the
 * plan-constrained `stack.up()` call, replacing `TerraformController.apply`
 * + `TerraformService.apply`'s split gate/spawn. Mirrors
 * `TerraformService.apply.test.ts`'s coverage breadth (spawning, streaming,
 * run persistence, abort/force-close handling, concurrency guard) plus this
 * dispatch's own additions: the gate's 8 ordered steps, partial-apply
 * detection, backend-lock recovery (reclaim-and-retry vs unrecognized), the
 * leaked-promise `recoverResult`, and cache invalidation on success.
 *
 * `node:fs` is fully mocked (mirrors `PulumiService.preview.test.ts` and
 * `TerraformService.apply.test.ts`) so no test touches the real filesystem.
 * `node:os`'s `userInfo`/`hostname` are mocked to fixed values so both
 * `PulumiService.resolveInitiator()` and `PulumiLockRecovery.classifyStackLockConflict`'s
 * default identity are deterministic and mutually consistent — `tmpdir` is
 * delegated to the real implementation via `importOriginal` since it's
 * unrelated to identity and several fallback paths call it.
 * `PulumiWorkspaceService.getOrCreateStack` is stubbed to return a fake
 * `Stack` whose `up`/`cancel`/`outputs`/`info` methods each test controls
 * directly.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModuleRef } from '@nestjs/core';
import type { EngineEvent, Stack, UpdateSummary, UpOptions, UpResult } from '@pulumi/pulumi/automation/index.js';
import type { RemoteFileStore, RunLock, RunRecord } from '@hyveon/shared';
import { RunLockHeldError } from '@hyveon/shared';

const { mkdirSyncMock, existsSyncMock, writeFileSyncMock, readFileSyncMock, loggerMock } = vi.hoisted(() => ({
  mkdirSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('node:fs', () => ({
  mkdirSync: mkdirSyncMock,
  existsSync: existsSyncMock,
  writeFileSync: writeFileSyncMock,
  readFileSync: readFileSyncMock,
}));

// `userInfo`/`hostname` are fixed so `PulumiService.resolveInitiator()`
// (`os.userInfo().username`) and `PulumiLockRecovery.classifyStackLockConflict`'s
// default identity (`{ userInfo().username, hostname() }`, since `apply()`
// never overrides it) always agree — required for the lock-recovery tests'
// fabricated conflict messages to match. `tmpdir` is delegated to the real
// implementation since `getRunsDir()`'s fallback path calls it.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, userInfo: () => ({ username: TEST_USERNAME }), hostname: () => TEST_HOSTNAME };
});

vi.mock('../logger.js', () => ({ logger: loggerMock }));

import {
  PulumiService,
  PulumiUpError,
  PulumiPartialApplyError,
  PulumiPlanRunNotFoundError,
  PulumiPlanRunWrongKindError,
  PulumiPlanNotApprovedError,
  PulumiApprovalExpiredError,
  PulumiPlanHashMismatchError,
  PulumiPlanArtifactStaleError,
  PulumiEngineVersionMismatchError,
  StalePlanError,
  PulumiRunPersistError,
  RUN_RECORD_PERSISTER,
  RUN_LOCK_SERVICE,
  CONFIG_CACHE_INVALIDATOR,
  type RunRecordPersister,
  type RunLockService,
  type ConfigCacheInvalidator,
} from './PulumiService.js';
import { PulumiUnrecognizedLockError } from './PulumiLockRecovery.js';
import { REMOTE_FILE_STORE } from '../modules/cloud-provider.tokens.js';
import type { PulumiWorkspaceService } from './PulumiWorkspaceService.js';
import type { PulumiEngineService } from './PulumiEngineService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { SafeStorageService } from './SafeStorageService.js';

/** Fixed OS identity — see the `node:os` mock above for why this must be a fixed, known value. */
const TEST_USERNAME = 'test-initiator';
const TEST_HOSTNAME = 'test-host';

/** The plan run this file's tests apply against. */
const PLAN_RUN_ID = 'plan-run-1';
/** The configuration-object version the plan ran against — must match the plan record's `tfvarsVersionId` for the gate's config-drift check to pass. */
const CONFIG_VERSION_ID = 'cfg-v1';
/** Raw bytes `readFileSyncMock` returns for the plan artifact by default — hashed together with `CONFIG_VERSION_ID` below to build a real, independently-verifiable `planHash`. */
const ARTIFACT_BYTES = Buffer.from(JSON.stringify({ manifest: { version: 'v3.255.0' } }));
/** The real SHA-256 digest `computePlanHash(artifactPath, CONFIG_VERSION_ID)` produces for `ARTIFACT_BYTES` — matches `PulumiService.preview.test.ts`'s identical algorithm. */
const PLAN_HASH = createHash('sha256')
  .update(Buffer.concat([ARTIFACT_BYTES, Buffer.from(CONFIG_VERSION_ID, 'utf8')]))
  .digest('hex');
/** The engine version stamped on the plan record — un-prefixed, matching `PulumiEngineService.getResolvedVersion()`'s own shape. */
const ENGINE_VERSION = '3.255.0';

/** `bootstrap`/`aws`/`pulumi` fields `apply()` reads off the store before ever calling Pulumi. */
const FULLY_CONFIGURED = { stateBucket: 'my-state-bucket', passphrase: 'enc-secret', awsRegion: 'us-east-1', configurationBucket: 'hyveon-config' };

/** Builds a real `ElectronStoreService` (in-memory Map outside Electron) with the given fields pre-seeded — mirrors `PulumiService.preview.test.ts`'s identical helper. */
function makeStore(
  opts: { stateBucket?: string; passphrase?: string; awsRegion?: string; configurationBucket?: string } = {},
): ElectronStoreService {
  const store = new ElectronStoreService(new SafeStorageService());
  if (opts.stateBucket !== undefined || opts.configurationBucket !== undefined) {
    store.set('bootstrap', {
      stateBucket: opts.stateBucket ?? '',
      lockTable: '',
      configurationBucket: opts.configurationBucket ?? '',
    });
  }
  if (opts.passphrase !== undefined) {
    store.set('pulumi', { passphrase: opts.passphrase });
  }
  if (opts.awsRegion !== undefined) {
    store.set('aws', { region: opts.awsRegion });
  }
  return store;
}

/** A fully-configured store (state bucket, passphrase, AWS region, configuration bucket). */
function makeFullyConfiguredStore(): ElectronStoreService {
  return makeStore(FULLY_CONFIGURED);
}

/** Minimal deployment-config JSON `apply()` fetches and parses — content doesn't matter since `createInfraProgram`'s closure is never invoked by these tests. */
const CONFIG_JSON = JSON.stringify({ hostedZoneName: 'example.com', gameServers: {} });

/** `RemoteFileStore` stub whose `get`/`listVersions` resolve fixture configuration content by default (head version `CONFIG_VERSION_ID`, matching the plan record). */
function makeRemoteFileStore(
  overrides: Partial<RemoteFileStore> = {},
): RemoteFileStore & { get: ReturnType<typeof vi.fn>; listVersions: ReturnType<typeof vi.fn> } {
  const store: Partial<RemoteFileStore> = {
    get: vi.fn().mockResolvedValue({ body: new TextEncoder().encode(CONFIG_JSON), etag: 'etag-1' }),
    put: vi.fn(),
    listVersions: vi.fn().mockResolvedValue([{ versionId: CONFIG_VERSION_ID, lastModified: new Date('2026-01-01') }]),
    getVersion: vi.fn(),
  };
  return Object.assign(store, overrides) as RemoteFileStore & {
    get: ReturnType<typeof vi.fn>;
    listVersions: ReturnType<typeof vi.fn>;
  };
}

/** An approved, unexpired `plan` run record whose hash/config-version/engine-version all line up with this file's fixtures, unless overridden. */
function makeApprovedPlanRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = new Date();
  return {
    sk: `${now.toISOString()}#${PLAN_RUN_ID}`,
    runId: PLAN_RUN_ID,
    kind: 'plan',
    status: 'success',
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    exitCode: 0,
    tfvarsVersionId: CONFIG_VERSION_ID,
    planHash: PLAN_HASH,
    approvedBy: 'alice',
    approvedAt: now.toISOString(),
    engineVersion: ENGINE_VERSION,
    ...overrides,
  };
}

/** `RunRecordPersister` stub — `getByRunId` resolves `record` by default, `persist` is a directly-inspectable mock. */
function makeRunRecordPersister(
  record: RunRecord | undefined = makeApprovedPlanRecord(),
): RunRecordPersister & { persist: ReturnType<typeof vi.fn>; getByRunId: ReturnType<typeof vi.fn> } {
  return {
    getByRunId: vi.fn().mockResolvedValue(record),
    persist: vi.fn().mockResolvedValue(undefined),
  };
}

/** `RunLockService` stub — `createRun` resolves a fresh `RunLock` by default. */
function makeRunLockService(): RunLockService & { createRun: ReturnType<typeof vi.fn> } {
  const lock: RunLock = {
    runId: PLAN_RUN_ID,
    kind: 'apply',
    initiator: TEST_USERNAME,
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  return { createRun: vi.fn().mockResolvedValue(lock) };
}

/** `ConfigCacheInvalidator` stub. */
function makeConfigCacheInvalidator(): ConfigCacheInvalidator & { invalidateCache: ReturnType<typeof vi.fn> } {
  return { invalidateCache: vi.fn(() => {}) };
}

/** Stub `PulumiEngineService` — `resolve()` resolves a no-op command, `getResolvedVersion()` returns `version` (defaulting to the matching `ENGINE_VERSION`). */
function makeEngine(
  version: string | null = ENGINE_VERSION,
): PulumiEngineService & { resolve: ReturnType<typeof vi.fn>; getResolvedVersion: ReturnType<typeof vi.fn> } {
  return {
    resolve: vi.fn().mockResolvedValue({}),
    getResolvedVersion: vi.fn().mockReturnValue(version),
  } as unknown as PulumiEngineService & { resolve: ReturnType<typeof vi.fn>; getResolvedVersion: ReturnType<typeof vi.fn> };
}

/**
 * Stub `ModuleRef` routing `.get(token, { strict: false })` to the four
 * lazily-resolved dependencies `apply()` uses — mirrors
 * `PulumiService.preview.test.ts`'s identical pattern, extended with the two
 * new tokens (`RUN_LOCK_SERVICE`, `CONFIG_CACHE_INVALIDATOR`) task 7.2 adds.
 */
function makeModuleRef(deps: {
  runRecordPersister: RunRecordPersister;
  remoteFileStore: RemoteFileStore;
  runLockService: RunLockService;
  configCacheInvalidator: ConfigCacheInvalidator;
}): ModuleRef {
  const get = vi.fn((token: unknown) => {
    if (token === RUN_RECORD_PERSISTER) return deps.runRecordPersister;
    if (token === REMOTE_FILE_STORE) return deps.remoteFileStore;
    if (token === RUN_LOCK_SERVICE) return deps.runLockService;
    if (token === CONFIG_CACHE_INVALIDATOR) return deps.configCacheInvalidator;
    throw new Error(`ModuleRef.get() called with an unexpected token: ${String(token)}`);
  });
  return { get } as unknown as ModuleRef;
}

/** Shape `apply()`'s `stack.up` mock is driven with. */
type FakeStackUp = (opts: UpOptions) => Promise<UpResult>;

/** A well-formed `UpdateSummary` for `stack.info()`'s default resolution. */
function makeUpdateSummary(overrides: Partial<UpdateSummary> = {}): UpdateSummary {
  return {
    kind: 'update',
    startTime: new Date(),
    endTime: new Date(),
    message: '',
    environment: {},
    config: {},
    result: 'succeeded',
    version: 1,
    ...overrides,
  };
}

/** Builds a `PulumiWorkspaceService` stub whose `getOrCreateStack` resolves to a stack stub wrapping the given `up` implementation plus `cancel`/`outputs`/`info`. */
function makeWorkspace(
  upImpl: FakeStackUp,
  extra: { cancel?: ReturnType<typeof vi.fn>; outputs?: ReturnType<typeof vi.fn>; info?: ReturnType<typeof vi.fn> } = {},
): PulumiWorkspaceService & { getOrCreateStack: ReturnType<typeof vi.fn> } {
  const upMock = vi.fn().mockImplementation(upImpl);
  const cancelMock = extra.cancel ?? vi.fn().mockResolvedValue(undefined);
  const outputsMock = extra.outputs ?? vi.fn().mockResolvedValue({});
  const infoMock = extra.info ?? vi.fn().mockResolvedValue(makeUpdateSummary());
  const getOrCreateStack = vi
    .fn()
    .mockResolvedValue({ up: upMock, cancel: cancelMock, outputs: outputsMock, info: infoMock } as Partial<Stack> as Stack);
  return { getOrCreateStack } as unknown as PulumiWorkspaceService & { getOrCreateStack: ReturnType<typeof vi.fn> };
}

/** A `stack.up` implementation that streams one stdout line, reports a summary, and resolves cleanly with no partial-apply steps. */
function makeHappyPathUp(changeSummary: Record<string, number> = { create: 2, same: 1 }): FakeStackUp {
  return async (opts) => {
    opts.onOutput?.('Updating...\n');
    const event: EngineEvent = {
      sequence: 1,
      timestamp: Math.floor(Date.now() / 1000),
      summaryEvent: { maybeCorrupt: false, durationSeconds: 1, resourceChanges: changeSummary, policyPacks: {} },
    };
    opts.onEvent?.(event);
    return { stdout: 'Updating...\n', stderr: '', outputs: {}, summary: makeUpdateSummary({ resourceChanges: changeSummary }) };
  };
}

/** A resOutputsEvent for one mutating resource step, as `apply()`'s partial-apply detection listens for. */
function resOutputsEvent(op: 'create' | 'update' | 'delete' | 'same', urn = 'urn:pulumi:production::hyveon::aws:s3/bucket:Bucket::example'): EngineEvent {
  return {
    sequence: 1,
    timestamp: Math.floor(Date.now() / 1000),
    resOutputsEvent: { metadata: { op, urn, type: 'aws:s3/bucket:Bucket', provider: 'urn:pulumi:production::hyveon::pulumi:providers:aws::default' } },
  };
}

/** Constructs `PulumiService` with every dependency stubbed. */
function makeService(opts: {
  workspace: PulumiWorkspaceService;
  store?: ElectronStoreService;
  runRecordPersister?: ReturnType<typeof makeRunRecordPersister>;
  remoteFileStore?: ReturnType<typeof makeRemoteFileStore>;
  runLockService?: ReturnType<typeof makeRunLockService>;
  configCacheInvalidator?: ReturnType<typeof makeConfigCacheInvalidator>;
  engine?: ReturnType<typeof makeEngine>;
}): PulumiService {
  const runRecordPersister = opts.runRecordPersister ?? makeRunRecordPersister();
  const remoteFileStore = opts.remoteFileStore ?? makeRemoteFileStore();
  const runLockService = opts.runLockService ?? makeRunLockService();
  const configCacheInvalidator = opts.configCacheInvalidator ?? makeConfigCacheInvalidator();
  const engine = opts.engine ?? makeEngine();
  return new PulumiService(
    opts.workspace,
    opts.store ?? makeFullyConfiguredStore(),
    makeModuleRef({ runRecordPersister, remoteFileStore, runLockService, configCacheInvalidator }),
    engine,
  );
}

/** Drains an `apply()` async generator to completion, collecting every yielded chunk plus the final return value. */
async function collectApplyChunks(gen: ReturnType<PulumiService['apply']>) {
  const chunks: { stream: 'stdout' | 'stderr'; line: string }[] = [];
  let next = await gen.next();
  while (!next.done) {
    chunks.push(next.value);
    next = await gen.next();
  }
  return { chunks, result: next.value };
}

beforeEach(() => {
  mkdirSyncMock.mockReset();
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(true);
  writeFileSyncMock.mockReset();
  readFileSyncMock.mockReset();
  readFileSyncMock.mockReturnValue(ARTIFACT_BYTES);
  loggerMock.warn.mockReset();
  vi.restoreAllMocks();
});

describe('PulumiService.apply gate', () => {
  it('should reject with PulumiPlanRunNotFoundError when no plan record exists for planRunId', async () => {
    const workspace = makeWorkspace(makeHappyPathUp());
    const runRecordPersister = makeRunRecordPersister();
    runRecordPersister.getByRunId.mockResolvedValue(undefined);
    const service = makeService({ workspace, runRecordPersister });

    await expect(collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH))).rejects.toBeInstanceOf(PulumiPlanRunNotFoundError);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should reject with PulumiPlanRunWrongKindError when the record is not a plan run', async () => {
    const workspace = makeWorkspace(makeHappyPathUp());
    const runRecordPersister = makeRunRecordPersister(makeApprovedPlanRecord({ kind: 'apply' }));
    const service = makeService({ workspace, runRecordPersister });

    await expect(collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH))).rejects.toBeInstanceOf(PulumiPlanRunWrongKindError);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should reject with PulumiPlanNotApprovedError when approvedBy/approvedAt are unset', async () => {
    const workspace = makeWorkspace(makeHappyPathUp());
    const runRecordPersister = makeRunRecordPersister(makeApprovedPlanRecord({ approvedBy: undefined, approvedAt: undefined }));
    const service = makeService({ workspace, runRecordPersister });

    await expect(collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH))).rejects.toBeInstanceOf(PulumiPlanNotApprovedError);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should reject with PulumiApprovalExpiredError when the approval is older than the 15-minute window', async () => {
    const workspace = makeWorkspace(makeHappyPathUp());
    const staleApprovedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const runRecordPersister = makeRunRecordPersister(makeApprovedPlanRecord({ approvedAt: staleApprovedAt }));
    const service = makeService({ workspace, runRecordPersister });

    await expect(collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH))).rejects.toBeInstanceOf(PulumiApprovalExpiredError);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should reject with PulumiPlanHashMismatchError when the supplied planHash does not match the record', async () => {
    const workspace = makeWorkspace(makeHappyPathUp());
    const service = makeService({ workspace });

    await expect(collectApplyChunks(service.apply(PLAN_RUN_ID, 'forged-hash'))).rejects.toBeInstanceOf(PulumiPlanHashMismatchError);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should reject with StalePlanError when the configuration object has moved since the plan ran', async () => {
    const workspace = makeWorkspace(makeHappyPathUp());
    const remoteFileStore = makeRemoteFileStore({
      listVersions: vi.fn().mockResolvedValue([{ versionId: 'cfg-v2', lastModified: new Date() }]),
    });
    const service = makeService({ workspace, remoteFileStore });

    await expect(collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH))).rejects.toBeInstanceOf(StalePlanError);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should reject with PulumiPlanArtifactStaleError when the on-disk artifact re-hashes differently despite the config version being unchanged', async () => {
    const workspace = makeWorkspace(makeHappyPathUp());
    // Config version unchanged (still CONFIG_VERSION_ID) but the artifact
    // bytes on disk differ from what was hashed at plan time.
    readFileSyncMock.mockReturnValue(Buffer.from('tampered bytes'));
    const service = makeService({ workspace });

    await expect(collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH))).rejects.toBeInstanceOf(PulumiPlanArtifactStaleError);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should reject with PulumiPlanArtifactStaleError (wrapping the cause) when the plan artifact cannot be read', async () => {
    const workspace = makeWorkspace(makeHappyPathUp());
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const service = makeService({ workspace });

    await expect(collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH))).rejects.toBeInstanceOf(PulumiPlanArtifactStaleError);
  });

  it('should reject with PulumiEngineVersionMismatchError when the plan was produced by a different engine version', async () => {
    const workspace = makeWorkspace(makeHappyPathUp());
    const engine = makeEngine('3.256.0');
    const service = makeService({ workspace, engine });

    await expect(collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH))).rejects.toBeInstanceOf(PulumiEngineVersionMismatchError);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should acquire the durable apply lock as the LAST gate step, after every read-only check has passed', async () => {
    const workspace = makeWorkspace(makeHappyPathUp());
    const remoteFileStore = makeRemoteFileStore();
    const engine = makeEngine();
    const runLockService = makeRunLockService();
    const service = makeService({ workspace, remoteFileStore, engine, runLockService });

    await collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH));

    expect(runLockService.createRun).toHaveBeenCalledWith('apply', TEST_USERNAME, PLAN_RUN_ID);
    const createRunOrder = runLockService.createRun.mock.invocationCallOrder[0]!;
    expect(remoteFileStore.listVersions.mock.invocationCallOrder[0]!).toBeLessThan(createRunOrder);
    expect(engine.resolve.mock.invocationCallOrder[0]!).toBeLessThan(createRunOrder);
    // getOrCreateStack (the first thing that could touch the actual engine
    // invocation) only happens AFTER the lock is acquired.
    expect(workspace.getOrCreateStack.mock.invocationCallOrder[0]!).toBeGreaterThan(createRunOrder);
  });

  it('should propagate RunLockHeldError unwrapped, and never call getOrCreateStack, when the atomic lock acquisition loses the race', async () => {
    const workspace = makeWorkspace(makeHappyPathUp());
    const runLockService = makeRunLockService();
    const heldLock: RunLock = {
      runId: 'other-run',
      kind: 'apply',
      initiator: 'someone-else',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    runLockService.createRun.mockRejectedValue(new RunLockHeldError(heldLock));
    const runRecordPersister = makeRunRecordPersister();
    const service = makeService({ workspace, runLockService, runRecordPersister });

    await expect(collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH))).rejects.toBeInstanceOf(RunLockHeldError);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
    // No run was ever reserved, so no run record is written for the rejected attempt.
    expect(runRecordPersister.persist).not.toHaveBeenCalled();
  });
});

describe('PulumiService.apply spawning', () => {
  it('should construct the stack via getOrCreateStack without passing credentialEnvVars, then call stack.up with the plan artifact path', async () => {
    const workspace = makeWorkspace(makeHappyPathUp());
    const service = makeService({ workspace });

    await collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH));

    expect(workspace.getOrCreateStack).toHaveBeenCalledTimes(1);
    const input = workspace.getOrCreateStack.mock.calls[0]![0] as Record<string, unknown>;
    expect(input['credentialEnvVars']).toBeUndefined();
    expect(input).toMatchObject({ stateBucket: 'my-state-bucket', stateBucketRegion: 'us-east-1', backendReady: true });

    const stack = await workspace.getOrCreateStack.mock.results[0]!.value;
    expect(stack.up).toHaveBeenCalledWith(
      expect.objectContaining({ plan: expect.stringContaining(`${PLAN_RUN_ID}.plan.json`) }),
    );
  });

  it('should throw synchronously when apply() is called while another operation is already in flight', async () => {
    const workspace = makeWorkspace(
      () =>
        new Promise<UpResult>(() => {
          // Never resolves — keeps the first call "in flight" for this test.
        }),
    );
    const service = makeService({ workspace });

    const first = service.apply(PLAN_RUN_ID, PLAN_HASH);
    void first.next();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const second = service.apply(PLAN_RUN_ID, PLAN_HASH);
    await expect(second.next()).rejects.toThrow(/already.*running/i);
  });
});

describe('PulumiService.apply streaming and structured changeSummary', () => {
  it('should yield stdout chunks and return the changeSummary captured from onEvent', async () => {
    const workspace = makeWorkspace(makeHappyPathUp({ create: 3, same: 5 }));
    const service = makeService({ workspace });

    const { chunks, result } = await collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH));

    expect(chunks).toEqual([{ stream: 'stdout', line: 'Updating...' }]);
    expect(result).toEqual({ runId: PLAN_RUN_ID, changeSummary: { create: 3, same: 5 } });
  });
});

describe('PulumiService.apply partial-apply detection', () => {
  it('should throw PulumiUpError (not PulumiPartialApplyError) when stack.up() fails before any mutating resource step completes', async () => {
    const workspace = makeWorkspace(async (opts) => {
      opts.onEvent?.(resOutputsEvent('same'));
      throw new Error('update failed before touching anything');
    });
    const service = makeService({ workspace });

    await expect(collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH))).rejects.toBeInstanceOf(PulumiUpError);
  });

  it('should throw PulumiPartialApplyError carrying the completed steps when stack.up() fails after at least one mutating resource step', async () => {
    const workspace = makeWorkspace(async (opts) => {
      opts.onEvent?.(resOutputsEvent('create', 'urn:pulumi:production::hyveon::aws:s3/bucket:Bucket::a'));
      opts.onEvent?.(resOutputsEvent('same', 'urn:pulumi:production::hyveon::aws:s3/bucket:Bucket::b'));
      throw new Error('update diverged partway through');
    });
    const service = makeService({ workspace });

    let caught: unknown;
    try {
      await collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PulumiPartialApplyError);
    expect((caught as PulumiPartialApplyError).completedSteps).toEqual([
      { urn: 'urn:pulumi:production::hyveon::aws:s3/bucket:Bucket::a', type: 'aws:s3/bucket:Bucket', op: 'create' },
    ]);
  });

  it('should persist a run.json record with partialApply: true for a partial failure', async () => {
    const workspace = makeWorkspace(async (opts) => {
      opts.onEvent?.(resOutputsEvent('create'));
      throw new Error('update diverged partway through');
    });
    const service = makeService({ workspace });

    await expect(collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH))).rejects.toBeInstanceOf(PulumiPartialApplyError);

    const call = writeFileSyncMock.mock.calls.find((c) => String(c[0]).endsWith('run.json'));
    expect(call).toBeDefined();
    const record = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(record).toMatchObject({ runId: PLAN_RUN_ID, kind: 'apply', exitCode: 1, partialApply: true });
  });

  it('should persist a run.json record with no partialApply field at all for a clean failure', async () => {
    const workspace = makeWorkspace(async () => {
      throw new Error('clean failure, nothing touched');
    });
    const service = makeService({ workspace });

    await expect(collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH))).rejects.toBeInstanceOf(PulumiUpError);

    const call = writeFileSyncMock.mock.calls.find((c) => String(c[0]).endsWith('run.json'));
    const record = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(record).toMatchObject({ exitCode: 1 });
    expect('partialApply' in record).toBe(false);
  });

  it('should persist a run.json record with no partialApply field for a successful apply', async () => {
    const workspace = makeWorkspace(makeHappyPathUp());
    const service = makeService({ workspace });

    await collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH));

    const call = writeFileSyncMock.mock.calls.find((c) => String(c[0]).endsWith('run.json'));
    const record = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(record).toMatchObject({ exitCode: 0 });
    expect('partialApply' in record).toBe(false);
  });
});

describe('PulumiService.apply run persistence', () => {
  it('should persist a run.json with kind "apply", the plan record\'s tfvarsVersionId/planHash/engineVersion carried through', async () => {
    const workspace = makeWorkspace(makeHappyPathUp({ create: 1 }));
    const service = makeService({ workspace });

    await collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH));

    const call = writeFileSyncMock.mock.calls.find((c) => String(c[0]).endsWith('run.json'));
    expect(call).toBeDefined();
    const record = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(record).toMatchObject({
      runId: PLAN_RUN_ID,
      kind: 'apply',
      exitCode: 0,
      tfvarsVersionId: CONFIG_VERSION_ID,
      planHash: PLAN_HASH,
      engineVersion: ENGINE_VERSION,
      changeSummary: { create: 1 },
    });
  });

  it('should persist the run to RunRecordService via RunRecordPersister with a matching log path', async () => {
    const workspace = makeWorkspace(makeHappyPathUp());
    const runRecordPersister = makeRunRecordPersister();
    const service = makeService({ workspace, runRecordPersister });

    await collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH));

    expect(runRecordPersister.persist).toHaveBeenCalledWith(
      expect.objectContaining({ runId: PLAN_RUN_ID, kind: 'apply', exitCode: 0 }),
      expect.stringContaining('pulumi.log'),
    );
  });

  it('should wrap a local run.json write failure in PulumiRunPersistError without discarding the real outcome', async () => {
    const workspace = makeWorkspace(makeHappyPathUp());
    const service = makeService({ workspace });
    writeFileSyncMock.mockImplementation((path: string) => {
      if (String(path).endsWith('run.json')) throw new Error('disk full');
    });

    await expect(collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH))).rejects.toBeInstanceOf(PulumiRunPersistError);
  });
});

describe('PulumiService.apply cache invalidation', () => {
  it('should invalidate the stack-outputs cache on a successful apply', async () => {
    const workspace = makeWorkspace(makeHappyPathUp());
    const configCacheInvalidator = makeConfigCacheInvalidator();
    const service = makeService({ workspace, configCacheInvalidator });

    await collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH));

    expect(configCacheInvalidator.invalidateCache).toHaveBeenCalledTimes(1);
  });

  it('should NOT invalidate the stack-outputs cache when the apply fails', async () => {
    const workspace = makeWorkspace(async () => {
      throw new Error('boom');
    });
    const configCacheInvalidator = makeConfigCacheInvalidator();
    const service = makeService({ workspace, configCacheInvalidator });

    await expect(collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH))).rejects.toThrow();

    expect(configCacheInvalidator.invalidateCache).not.toHaveBeenCalled();
  });

  it('should not let a failure to resolve CONFIG_CACHE_INVALIDATOR mask an otherwise-successful apply', async () => {
    const workspace = makeWorkspace(makeHappyPathUp());
    const runRecordPersister = makeRunRecordPersister();
    const remoteFileStore = makeRemoteFileStore();
    const runLockService = makeRunLockService();
    const engine = makeEngine();
    const moduleRef = {
      get: vi.fn((token: unknown) => {
        if (token === RUN_RECORD_PERSISTER) return runRecordPersister;
        if (token === REMOTE_FILE_STORE) return remoteFileStore;
        if (token === RUN_LOCK_SERVICE) return runLockService;
        if (token === CONFIG_CACHE_INVALIDATOR) throw new Error('not registered');
        throw new Error(`unexpected token ${String(token)}`);
      }),
    } as unknown as ModuleRef;
    const service = new PulumiService(workspace, makeFullyConfiguredStore(), moduleRef, engine);

    const { result } = await collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH));

    expect(result).toEqual({ runId: PLAN_RUN_ID, changeSummary: { create: 2, same: 1 } });
  });
});

describe('PulumiService.apply lock-recovery', () => {
  /** Builds the DIY-backend lock-conflict message text, in the shape `pkg/backend/diy/lock.go` produces. */
  function diyLockMessage(entries: { pid: number; username: string; hostname: string; lockedAt: string }[]): string {
    const header = `the stack is currently locked by ${entries.length} lock(s). Either wait for the other process(es) to end or delete the lock file with \`pulumi cancel\`.`;
    const lines = entries.map(
      (e, i) => `\n  s3://my-bucket/.pulumi/locks/production/lock-${i}.json: created by ${e.username}@${e.hostname} (pid ${e.pid}) at ${e.lockedAt}`,
    );
    return header + lines.join('');
  }

  it('should clear a provably-own-orphan lock via stack.cancel() and retry stack.up() once, succeeding on the retry', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    const store = makeFullyConfiguredStore();
    // Seed a fresh ownership record for a prior (crashed) attempt against this stack.
    store.recordPulumiLockAttempt('production');
    const lockedAt = new Date().toISOString();
    const conflictMessage = diyLockMessage([{ pid: 4242, username: TEST_USERNAME, hostname: TEST_HOSTNAME, lockedAt }]);

    let upCallCount = 0;
    const cancelMock = vi.fn().mockResolvedValue(undefined);
    const workspace = makeWorkspace(
      async () => {
        upCallCount += 1;
        if (upCallCount === 1) {
          throw new Error(conflictMessage);
        }
        return { stdout: '', stderr: '', outputs: {}, summary: makeUpdateSummary({ resourceChanges: { create: 1 } }) };
      },
      { cancel: cancelMock },
    );
    const service = makeService({ workspace, store });

    const { result } = await collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH));

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(upCallCount).toBe(2);
    expect(result).toEqual({ runId: PLAN_RUN_ID, changeSummary: {} });
  });

  it('should reject with PulumiUnrecognizedLockError, and never call stack.cancel(), when the lock cannot be proven this installation\'s own orphan', async () => {
    // A live process (mockPidAlive) and/or an identity mismatch both fail
    // the "provable own orphan" test — mismatched identity is used here.
    const lockedAt = new Date().toISOString();
    const conflictMessage = diyLockMessage([{ pid: 4242, username: 'someone-else', hostname: 'someone-elses-machine', lockedAt }]);

    const cancelMock = vi.fn().mockResolvedValue(undefined);
    const workspace = makeWorkspace(
      async () => {
        throw new Error(conflictMessage);
      },
      { cancel: cancelMock },
    );
    const service = makeService({ workspace });

    let caught: unknown;
    try {
      await collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PulumiUnrecognizedLockError);
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('should persist a failed (not partial) run record for an unrecognized-lock rejection', async () => {
    const lockedAt = new Date().toISOString();
    const conflictMessage = diyLockMessage([{ pid: 4242, username: 'someone-else', hostname: 'someone-elses-machine', lockedAt }]);
    const workspace = makeWorkspace(async () => {
      throw new Error(conflictMessage);
    });
    const service = makeService({ workspace });

    await expect(collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH))).rejects.toBeInstanceOf(PulumiUnrecognizedLockError);

    const call = writeFileSyncMock.mock.calls.find((c) => String(c[0]).endsWith('run.json'));
    const record = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(record).toMatchObject({ exitCode: 1 });
    expect('partialApply' in record).toBe(false);
  });
});

describe('PulumiService.apply leaked-promise recovery', () => {
  it('should recover a leaked-promise rejection as a success, using the changeSummary already captured via onEvent', async () => {
    const outputsMock = vi.fn().mockResolvedValue({ someOutput: { value: 'x', secret: false } });
    const infoMock = vi.fn().mockResolvedValue(makeUpdateSummary({ result: 'succeeded' }));
    const workspace = makeWorkspace(
      async (opts) => {
        opts.onOutput?.('Updating...\n');
        opts.onEvent?.({
          sequence: 1,
          timestamp: Math.floor(Date.now() / 1000),
          summaryEvent: { maybeCorrupt: false, durationSeconds: 1, resourceChanges: { create: 1 }, policyPacks: {} },
        });
        throw new Error('The Pulumi runtime detected that 1 promises were still active when the process exited');
      },
      { outputs: outputsMock, info: infoMock },
    );
    const service = makeService({ workspace });

    const { result } = await collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH));

    expect(result).toEqual({ runId: PLAN_RUN_ID, changeSummary: { create: 1 } });
    expect(outputsMock).toHaveBeenCalled();
    expect(infoMock).toHaveBeenCalled();
  });

  it('should still recover as a success (trusting the proven-sufficient leak-check) when stack.info() reports a non-"succeeded" result', async () => {
    const infoMock = vi.fn().mockResolvedValue(makeUpdateSummary({ result: 'failed' }));
    const workspace = makeWorkspace(
      async () => {
        throw new Error('The Pulumi runtime detected that 2 promises were still active when the process exited');
      },
      { info: infoMock },
    );
    const service = makeService({ workspace });

    const { result } = await collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH));

    expect(result).toEqual({ runId: PLAN_RUN_ID, changeSummary: {} });
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('does not report "succeeded"'), expect.anything());
  });
});

describe('PulumiService.apply failure handling', () => {
  it('should throw PulumiUpError (wrapping the cause) when stack.up() itself rejects with a non-lock, non-leak failure', async () => {
    const cause = new Error('up command failed');
    const workspace = makeWorkspace(async () => {
      throw cause;
    });
    const service = makeService({ workspace });

    await expect(collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH))).rejects.toBeInstanceOf(PulumiUpError);
  });

  it('should persist a failed run record with exitCode 1 when stack.up() rejects', async () => {
    const workspace = makeWorkspace(async () => {
      throw new Error('up command failed');
    });
    const runRecordPersister = makeRunRecordPersister();
    const service = makeService({ workspace, runRecordPersister });

    await expect(collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH))).rejects.toThrow();

    expect(runRecordPersister.persist).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 1 }), expect.any(String));
  });
});

describe('PulumiService.apply abort handling', () => {
  it('should end the generator cleanly (resolving undefined) without touching Pulumi when the signal is already aborted', async () => {
    const workspace = makeWorkspace(makeHappyPathUp());
    const service = makeService({ workspace });
    const controller = new AbortController();
    controller.abort();

    const { chunks, result } = await collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH, controller.signal));

    expect(chunks).toEqual([]);
    expect(result).toBeUndefined();
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should register the internal abort listener with { once: true } so a reused signal never accumulates more than one live listener', async () => {
    const workspace = makeWorkspace(makeHappyPathUp());
    const service = makeService({ workspace });
    const controller = new AbortController();
    const addEventListenerSpy = vi.spyOn(controller.signal, 'addEventListener');

    await collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH, controller.signal));

    expect(addEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
  });

  it('should end the generator cleanly and clear the lock-ownership record when the signal aborts mid-flight', async () => {
    let rejectUp!: (err: unknown) => void;
    const upMock = vi.fn().mockImplementation(
      (opts: UpOptions) =>
        new Promise<UpResult>((_resolve, reject) => {
          opts.onOutput?.('Updating...\n');
          rejectUp = reject;
        }),
    );
    const getOrCreateStack = vi
      .fn()
      .mockResolvedValue({ up: upMock, cancel: vi.fn(), outputs: vi.fn(), info: vi.fn() } as Partial<Stack> as Stack);
    const workspace = { getOrCreateStack } as unknown as PulumiWorkspaceService;
    const runRecordPersister = makeRunRecordPersister();
    const service = makeService({ workspace, runRecordPersister });
    const controller = new AbortController();

    const gen = service.apply(PLAN_RUN_ID, PLAN_HASH, controller.signal);
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(upMock).toHaveBeenCalled();

    controller.abort();
    rejectUp(new Error('killed by SIGINT'));

    const next = await gen.next();
    expect(next.done).toBe(true);
    expect(next.value).toBeUndefined();

    expect(runRecordPersister.persist).toHaveBeenCalledWith(expect.objectContaining({ exitCode: null }), expect.any(String));
  });

  it('should abort the in-flight stack.up() call and await its settlement before releasing the concurrency guard when the generator is force-closed', async () => {
    let capturedSignal: AbortSignal | undefined;
    let rejectUp!: (err: unknown) => void;
    const upMock = vi.fn().mockImplementation((opts: UpOptions) => {
      capturedSignal = opts.signal;
      opts.onOutput?.('Updating...\n');
      return new Promise<UpResult>((_resolve, reject) => {
        rejectUp = reject;
      });
    });
    const getOrCreateStack = vi
      .fn()
      .mockResolvedValue({ up: upMock, cancel: vi.fn(), outputs: vi.fn(), info: vi.fn() } as Partial<Stack> as Stack);
    const workspace = { getOrCreateStack } as unknown as PulumiWorkspaceService;
    const service = makeService({ workspace });

    const gen = service.apply(PLAN_RUN_ID, PLAN_HASH);
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ stream: 'stdout', line: 'Updating...' });
    expect(capturedSignal?.aborted).toBe(false);

    let returnSettled = false;
    const returnPromise = gen.return(undefined).then((result) => {
      returnSettled = true;
      return result;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(capturedSignal?.aborted).toBe(true);
    expect(returnSettled).toBe(false);

    rejectUp(new Error('killed by SIGINT'));
    const result = await returnPromise;

    expect(returnSettled).toBe(true);
    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();

    let secondRejection: unknown;
    service
      .apply(PLAN_RUN_ID, PLAN_HASH)
      .next()
      .catch((err: unknown) => {
        secondRejection = err;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondRejection).toBeUndefined();
  });
});

describe('PulumiService.apply concurrency guard', () => {
  it('should allow a new apply() call once the previous one has completed', async () => {
    const workspace = makeWorkspace(makeHappyPathUp());
    const service = makeService({ workspace });

    await collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH));
    await expect(collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH))).resolves.toBeDefined();
  });

  it('should allow a new apply() call once the previous one has failed', async () => {
    let shouldFail = true;
    const workspace = makeWorkspace(async () => {
      if (shouldFail) throw new Error('boom');
      return { stdout: '', stderr: '', outputs: {}, summary: makeUpdateSummary() };
    });
    const service = makeService({ workspace });

    await expect(collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH))).rejects.toBeInstanceOf(PulumiUpError);
    shouldFail = false;
    await expect(collectApplyChunks(service.apply(PLAN_RUN_ID, PLAN_HASH))).resolves.toBeDefined();
  });
});
