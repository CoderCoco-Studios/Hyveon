/**
 * Unit tests for `PulumiWorkspaceService` — the Automation API
 * workspace/backend/passphrase seam. `getOrCreateStack` derives the secrets
 * passphrase from the AWS account ID `resolveAwsAccountId` resolves (via a
 * real `STSClient` instance, intercepted file-wide by `stsMock` — see
 * `DEFAULT_TEST_ACCOUNT_ID`) and `deriveStackPassphrase`, sets it directly on
 * `LocalWorkspaceOptions.envVars` before ever constructing the workspace, and
 * calls `Stack.createOrSelect` — no more stored-passphrase branching and no
 * more `workspace.listStacks()` backend probe.
 *
 * `ElectronStoreService`/`SafeStorageService` are used as *real* instances
 * (non-Electron Map-fallback path), not stubs, for tests exercising
 * credential resolution and the `pulumi.stackInitialized` bookkeeping flag.
 * `SafeStorageService.encrypt`/`decrypt` are spied with a reversible
 * `enc-<plaintext>` transform (mirroring `ElectronStoreService.test.ts`'s
 * round-trip helper) rather than left un-stubbed, because the real
 * implementation would otherwise require the native `electron` module once
 * `isAvailable()` is mocked `true`. Only `PulumiEngineService` (whose own
 * resolution is already covered by its own test file) and the Pulumi SDK
 * itself are module-mocked.
 *
 * ## Mocking `LocalWorkspace.create` / `Stack.createOrSelect`
 *
 * `getOrCreateStack` builds the workspace itself via the lower-level
 * `LocalWorkspace.create(opts)`, then calls `Stack.createOrSelect` with that
 * same instance — rather than the single convenience
 * `LocalWorkspace.createOrSelectStack(args, opts)` call. `createMock`
 * (mocking `LocalWorkspace.create`) resolves with a fake, mutable `ws`
 * object carrying its own `envVars` (a shallow copy of `opts.envVars`,
 * mirroring the real SDK's constructor), so `createOrSelectWs()` below can
 * read the exact `PULUMI_CONFIG_PASSPHRASE` value the production code built
 * `opts.envVars` with.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';

const { createMock, createOrSelectMock, mkdirSyncMock, existsSyncMock, loggerMock, spawnMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  createOrSelectMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  spawnMock: vi.fn(),
}));

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: { create: createMock },
  Stack: { createOrSelect: createOrSelectMock },
}));

vi.mock('node:fs', () => ({ mkdirSync: mkdirSyncMock, existsSync: existsSyncMock }));

// Mocked file-wide for the legacy-passphrase-migration describe block below —
// `migrateLegacyPassphrase` spawns the resolved `pulumi` binary directly
// (see that method's own doc comment for why: no public Automation API
// covers `stack change-secrets-provider`). Tests build a minimal fake
// `ChildProcess`-shaped `EventEmitter` with `stdin`/`stderr` streams via
// {@link fakeChildProcess} rather than letting a real process spawn.
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

// Mocked file-wide — this hoisted `vi.mock` replaces the module for every
// test in this file, not only the "credentials are not logged" describe
// block below. It exists so that block can inspect every call this service
// makes to the shared logger, mirroring `PulumiEngineService.test.ts`'s
// `loggerMock` pattern; tests elsewhere in this file are unaffected since
// they never assert against `loggerMock`.
vi.mock('../logger.js', () => ({ logger: loggerMock }));

import type { PulumiFn, Stack } from '@pulumi/pulumi/automation/index.js';
import {
  PulumiWorkspaceService,
  PulumiBackendNotBootstrappedError,
  PULUMI_STACK_NAME,
  PULUMI_PROJECT_NAME,
  deriveStackPassphrase,
  resolveAwsAccountId,
  type PulumiWorkspaceInput,
} from './PulumiWorkspaceService.js';
import type { PulumiEngineService } from './PulumiEngineService.js';
import { SafeStorageService } from './SafeStorageService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { resolveCredentialEnvVars, PulumiCredentialsNotConfiguredError } from './PulumiCredentialResolver.js';
import { mockClient } from 'aws-sdk-client-mock';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

/**
 * Typed stand-in for the AWS STS SDK client, shared across the
 * `resolveAwsAccountId` tests below — see `IamCheckService.test.ts` for the
 * same convention.
 */
const stsMock = mockClient(STSClient);

/** Minimal `PulumiCommand`-shaped object the mocked SDK is given. */
const FAKE_COMMAND = { command: '/fake/userData/pulumi/versions/3.255.0/bin/pulumi', version: null };

/**
 * The AWS account ID `stsMock` returns by default for every test in this
 * file — `getOrCreateStack` now calls `resolveAwsAccountId` unconditionally
 * (via a real `STSClient` instance, intercepted file-wide by `stsMock`), so
 * every test needs a `GetCallerIdentity` response even when it isn't
 * exercising `resolveAwsAccountId`/`deriveStackPassphrase` directly.
 */
const DEFAULT_TEST_ACCOUNT_ID = '111122223333';

/** Fake `Stack` the mocked `Stack.createOrSelect` resolves with. */
const FAKE_STACK = { name: PULUMI_STACK_NAME } as Partial<Stack> as Stack;

/** No-op inline program — never actually invoked, since the SDK call is mocked. */
const FAKE_PROGRAM: PulumiFn = async () => ({});

/** Shape of the fake workspace object `createMock` resolves with — see this file's own doc comment. */
interface FakeWorkspace {
  envVars: Record<string, string>;
  pulumiHome?: string;
  workDir?: string;
  secretsProvider?: string;
  pulumiCommand?: unknown;
  program?: PulumiFn;
  projectSettings?: { name: string; runtime: string; main: string };
}

/**
 * Builds a valid `PulumiWorkspaceInput` for a genuinely new stack against a
 * bootstrapped backend, with all fields overridable.
 */
function baseInput(overrides?: Partial<PulumiWorkspaceInput>): PulumiWorkspaceInput {
  return {
    program: FAKE_PROGRAM,
    stateBucket: 'my-bucket',
    stateBucketRegion: 'us-west-2',
    backendReady: true,
    ...overrides,
  };
}

/**
 * Test-only subclass that re-exposes `PulumiWorkspaceService`'s protected
 * `resolveUserDataPath` seam as public, mirroring
 * `PulumiEngineService.test.ts`'s `TestablePulumiEngineService`.
 */
class TestablePulumiWorkspaceService extends PulumiWorkspaceService {
  public override resolveUserDataPath(): string | null {
    return super.resolveUserDataPath();
  }
}

/** Builds a `PulumiEngineService` stub whose `resolve()` resolves with `FAKE_COMMAND`. */
function stubEngine(): PulumiEngineService {
  const engine: Partial<PulumiEngineService> = { resolve: vi.fn().mockResolvedValue(FAKE_COMMAND) };
  return engine as PulumiEngineService;
}

/**
 * Builds a `SafeStorageService` that behaves as if the OS keychain is
 * available, with a reversible (not identity) `encrypt`/`decrypt` transform
 * so a test can tell "the real generated value" apart from "the stored
 * ciphertext" while still round-tripping correctly, without touching the
 * real native `electron` module.
 */
function makeAvailableSafeStorage(): SafeStorageService {
  const safeStorage = new SafeStorageService();
  vi.spyOn(safeStorage, 'isAvailable').mockReturnValue(true);
  vi.spyOn(safeStorage, 'encrypt').mockImplementation((plaintext: string) => `enc-${plaintext}`);
  vi.spyOn(safeStorage, 'decrypt').mockImplementation((ciphertext: string) =>
    ciphertext.startsWith('enc-') ? ciphertext.slice(4) : ciphertext,
  );
  return safeStorage;
}

/**
 * Builds a service with real `SafeStorageService`/`ElectronStoreService`
 * collaborators (non-Electron Map-fallback path — see file doc comment),
 * an "available" keychain by default, and a fixed, fake `userData` path so
 * cache paths are deterministic.
 *
 * When `opts.store` is not supplied, the fresh store is pre-seeded with a
 * named-profile AWS selection (`DEFAULT_TEST_AWS_PROFILE`) so that
 * `getOrCreateStack`'s unconditional internal credential resolution (fix
 * round 1 — see `PulumiWorkspaceInput.credentialEnvVars`'s doc comment)
 * succeeds by default for every test in this file that isn't specifically
 * about credential resolution. Tests that need to control the credential
 * source directly build and pass their own `store`.
 */
function makeService(opts?: {
  engine?: PulumiEngineService;
  safeStorage?: SafeStorageService;
  store?: ElectronStoreService;
  userDataPath?: string | null;
}) {
  const safeStorage = opts?.safeStorage ?? makeAvailableSafeStorage();
  const store = opts?.store ?? makeStoreWithDefaultCredentials(safeStorage);
  const engine = opts?.engine ?? stubEngine();
  const service = new TestablePulumiWorkspaceService(engine, store);
  vi.spyOn(service, 'resolveUserDataPath').mockReturnValue(opts?.userDataPath ?? '/fake/userData');
  return { service, engine, safeStorage, store };
}

/**
 * Name of the named-profile AWS selection {@link makeStoreWithDefaultCredentials}
 * seeds — deliberately not a `creds.aws.<profile>` pasted entry, so it
 * resolves as the plain `'profile'` credential-source kind.
 */
const DEFAULT_TEST_AWS_PROFILE = 'default-test-profile';

/**
 * Builds a fresh `ElectronStoreService` with a named-profile AWS credential
 * source already selected, so `getOrCreateStack`'s unconditional credential
 * resolution (see {@link makeService}'s doc comment) succeeds by default.
 */
function makeStoreWithDefaultCredentials(safeStorage: SafeStorageService): ElectronStoreService {
  const store = new ElectronStoreService(safeStorage);
  store.set('aws', { region: 'us-west-2', profile: DEFAULT_TEST_AWS_PROFILE });
  return store;
}

const WORKSPACE_ROOT = '/fake/userData/pulumi-workspace';
const PULUMI_HOME_DIR = join(WORKSPACE_ROOT, 'home');
const WORK_DIR = join(WORKSPACE_ROOT, 'workspace', PULUMI_STACK_NAME);

/**
 * Extracts the `opts` object `LocalWorkspace.create` was called with for the
 * `callIndex`-th `getOrCreateStack` call (0-based) — the pre-passphrase
 * envVars/pulumiHome/workDir/secretsProvider/program/projectSettings this
 * service builds BEFORE it knows whether a passphrase needs generating.
 */
function createOpts(callIndex = 0) {
  return createMock.mock.calls[callIndex]![0] as {
    pulumiHome: string;
    workDir: string;
    secretsProvider: string;
    pulumiCommand: unknown;
    envVars: Record<string, string>;
    program: PulumiFn;
    projectSettings?: { name: string; runtime: string; main: string };
  };
}

/**
 * Extracts the fake `ws` object `Stack.createOrSelect` was called with for
 * the `callIndex`-th `getOrCreateStack` call (0-based) — carries the same
 * `envVars` (including the derived `PULUMI_CONFIG_PASSPHRASE`) that
 * `LocalWorkspace.create` was called with, since the passphrase is now set
 * directly on `opts.envVars` before workspace construction.
 */
function createOrSelectWs(callIndex = 0): FakeWorkspace {
  return createOrSelectMock.mock.calls[callIndex]![1] as FakeWorkspace;
}

/**
 * Minimal `ChildProcess`-shaped fake for `migrateLegacyPassphrase`'s
 * `spawn()` seam: a plain `EventEmitter` (for `'error'`/`'close'`) with a
 * `stdin` writable that records what was written to it (the new passphrase,
 * per the Step 3.0 spike's finding that it's supplied via stdin, not an env
 * var) and a `stderr` readable `EventEmitter` `runChangeSecretsProviderCli`
 * accumulates for its failure message.
 *
 * Queues one `spawnMock` return value that resolves/rejects on the next
 * microtask (`queueMicrotask`) so a test can simply `await` the
 * `getOrCreateStack` call that triggers it, rather than manually
 * interleaving the fake process's events with the production `await` chain.
 */
function queueSpawnResult(result: { code: number | null } | { error: Error }): {
  stdinWrites: string[];
} {
  const stdinWrites: string[] = [];
  const stderr = new EventEmitter();
  // A real Writable (or the production `child.stdin`) is an EventEmitter —
  // `runChangeSecretsProviderCli`'s EPIPE-safety listener calls `.on('error', ...)`
  // on it, so the fake must be one too, not just an object with `write`/`end`.
  // Typed as this minimal interface (not `Partial<Writable>`) because
  // `Writable`'s full `addListener` overload set is what an `Object.assign`
  // onto a real `EventEmitter` can't structurally satisfy — production code
  // only ever calls `write`/`end`/`on('error', ...)` on `child.stdin`.
  type FakeStdin = Pick<Writable, 'write' | 'end'> & EventEmitter;
  const stdin: FakeStdin = Object.assign(new EventEmitter(), {
    write: vi.fn((chunk: string) => {
      stdinWrites.push(chunk);
      return true;
    }),
    end: vi.fn(),
  }) as FakeStdin;
  const emitter = Object.assign(new EventEmitter(), { stdin, stderr }) as EventEmitter & {
    stdin: FakeStdin;
    stderr: EventEmitter;
  };
  spawnMock.mockImplementationOnce(() => {
    queueMicrotask(() => {
      if ('error' in result) {
        emitter.emit('error', result.error);
      } else {
        emitter.emit('close', result.code);
      }
    });
    return emitter;
  });
  return { stdinWrites };
}

beforeEach(() => {
  createMock.mockReset();
  createOrSelectMock.mockReset();
  mkdirSyncMock.mockReset();
  existsSyncMock.mockReset();
  loggerMock.debug.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();
  spawnMock.mockReset();
  stsMock.reset();
  // Default: every test's implicit `resolveAwsAccountId` call (via the real
  // `STSClient` `getOrCreateStack` constructs) resolves to a fixed account
  // ID — tests that care about the derived passphrase's exact value or a
  // different account override this explicitly.
  stsMock.on(GetCallerIdentityCommand).resolves({ Account: DEFAULT_TEST_ACCOUNT_ID });

  // Default: no `Pulumi.{yaml,yml,json}` exists yet in `workDir` (a brand-new
  // workspace directory) — every test that cares about an EXISTING project
  // settings file overrides this explicitly.
  existsSyncMock.mockReturnValue(false);

  // `LocalWorkspace.create` resolves with a fake, mutable workspace whose
  // `envVars` starts as a shallow copy of what was passed in (mirroring the
  // real SDK's constructor — see this file's own doc comment). No more
  // `listStacks()` — the derive-then-`createOrSelect` model never probes the
  // real backend to disambiguate a passphrase.
  createMock.mockImplementation(async (opts: { envVars?: Record<string, string> }) => {
    const ws: FakeWorkspace = {
      ...opts,
      envVars: { ...opts.envVars },
    };
    return ws;
  });
  createOrSelectMock.mockResolvedValue(FAKE_STACK);
});

describe('PulumiWorkspaceService.getOrCreateStack — workDir/pulumiHome stability', () => {
  it('should use a stable pulumiHome/workDir under userData, not a tmpdir', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput());

    expect(createMock).toHaveBeenCalledOnce();
    const opts = createOpts();
    expect(opts.pulumiHome).toBe(PULUMI_HOME_DIR);
    expect(opts.workDir).toBe(WORK_DIR);
    expect(opts.pulumiHome).not.toContain('tmp');
    expect(opts.workDir).not.toContain('tmp');
  });

  it('should reuse the exact same pulumiHome/workDir across repeated operations, not grow', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput());
    await service.getOrCreateStack(baseInput());
    await service.getOrCreateStack(baseInput());

    expect(createMock).toHaveBeenCalledTimes(3);
    const paths = createMock.mock.calls.map((call) => call[0] as { pulumiHome: string; workDir: string });
    // Every call sees the identical pair of paths — no per-operation directory.
    expect(new Set(paths.map((p) => p.pulumiHome)).size).toBe(1);
    expect(new Set(paths.map((p) => p.workDir)).size).toBe(1);
  });

  it('should keep pulumiHome distinct from the engine install cache root', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput());

    const opts = createOpts();
    expect(opts.pulumiHome).not.toBe('/fake/userData/pulumi');
    expect(opts.pulumiHome.startsWith('/fake/userData/pulumi/versions')).toBe(false);
  });

  it('should create pulumiHome/workDir via mkdirSync with recursive: true', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput());

    expect(mkdirSyncMock).toHaveBeenCalledWith(PULUMI_HOME_DIR, { recursive: true });
    expect(mkdirSyncMock).toHaveBeenCalledWith(WORK_DIR, { recursive: true });
  });

  it('should not grow the number of distinct workspace directories across many repeated operations', async () => {
    const { service } = makeService();
    // Large enough that "one leaked directory per call" would be obvious
    // against a stable count, but small enough to stay fast — simulates many
    // previews/applies against the same stack over the app's lifetime.
    const CALL_COUNT = 30;

    for (let i = 0; i < CALL_COUNT; i++) {
      await service.getOrCreateStack(baseInput());
    }

    expect(createMock).toHaveBeenCalledTimes(CALL_COUNT);

    // mkdirSync is called twice per operation (pulumiHome + workDir) and is
    // idempotent under `recursive: true` — being called CALL_COUNT * 2 times
    // total is fine and expected. What must NOT happen is CALL_COUNT * 2
    // *distinct* paths (one leaked pair of directories per call): assert on
    // the SET of unique paths passed to mkdirSync, not just the call count.
    expect(mkdirSyncMock.mock.calls.length).toBe(CALL_COUNT * 2);
    const mkdirPaths = new Set(mkdirSyncMock.mock.calls.map((call) => call[0]));
    expect(mkdirPaths).toEqual(new Set([PULUMI_HOME_DIR, WORK_DIR]));

    // Same guarantee restated at the `LocalWorkspace.create` call boundary,
    // mirroring the 3-call path-identity test above but at a scale that
    // makes a per-operation leak impossible to miss.
    const paths = createMock.mock.calls.map((call) => call[0] as { pulumiHome: string; workDir: string });
    expect(new Set(paths.map((p) => p.pulumiHome)).size).toBe(1);
    expect(new Set(paths.map((p) => p.workDir)).size).toBe(1);
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — bare stack name', () => {
  it('should pass the bare stack name to Stack.createOrSelect, never an organization/-qualified name', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput());

    const [stackName] = createOrSelectMock.mock.calls[0] as [string, unknown];
    expect(stackName).toBe(PULUMI_STACK_NAME);
    expect(stackName).not.toContain('/');
    expect(stackName).not.toContain('organization');
  });

  it('should default the project to the bare PULUMI_PROJECT_NAME when no Pulumi.yaml exists yet', async () => {
    const { service } = makeService();
    existsSyncMock.mockReturnValue(false);

    await service.getOrCreateStack(baseInput());

    const opts = createOpts();
    expect(opts.projectSettings?.name).toBe(PULUMI_PROJECT_NAME);
  });

  it('should leave an existing Pulumi.yaml alone rather than overwriting its project settings', async () => {
    const { service } = makeService();
    existsSyncMock.mockReturnValue(true);

    await service.getOrCreateStack(baseInput());

    const opts = createOpts();
    expect(opts.projectSettings).toBeUndefined();
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — PULUMI_BACKEND_URL and region', () => {
  it('should build the backend URL as s3://<stateBucket>?region=<region>', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput({ stateBucket: 'hyveon-state-abc123', stateBucketRegion: 'eu-west-1' }));

    const opts = createOpts();
    expect(opts.envVars['PULUMI_BACKEND_URL']).toBe('s3://hyveon-state-abc123?region=eu-west-1');
  });

  it('should also set AWS_REGION from stateBucketRegion', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput({ stateBucketRegion: 'ap-southeast-2' }));

    const opts = createOpts();
    expect(opts.envVars['AWS_REGION']).toBe('ap-southeast-2');
  });

  it('should URL-encode the region on the backend URL', async () => {
    const { service } = makeService();

    // Not a real region, but proves special characters don't corrupt the URL.
    await service.getOrCreateStack(baseInput({ stateBucketRegion: 'us east 1' }));

    const opts = createOpts();
    expect(opts.envVars['PULUMI_BACKEND_URL']).toBe('s3://my-bucket?region=us%20east%201');
  });

  it('should use the passphrase secrets provider', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput());

    const opts = createOpts();
    expect(opts.secretsProvider).toBe('passphrase');
  });

  it('should source pulumiCommand from PulumiEngineService.resolve(), never PATH', async () => {
    const { service, engine } = makeService();

    await service.getOrCreateStack(baseInput());

    expect(engine.resolve).toHaveBeenCalledOnce();
    const opts = createOpts();
    expect(opts.pulumiCommand).toBe(FAKE_COMMAND);
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — backend-not-bootstrapped', () => {
  it('should throw PulumiBackendNotBootstrappedError without touching Pulumi when backendReady is false', async () => {
    const { service, engine } = makeService();

    await expect(service.getOrCreateStack(baseInput({ backendReady: false }))).rejects.toThrow(
      PulumiBackendNotBootstrappedError,
    );

    expect(createMock).not.toHaveBeenCalled();
    expect(createOrSelectMock).not.toHaveBeenCalled();
    expect(engine.resolve).not.toHaveBeenCalled();
  });

  it('should name the bucket in the error', async () => {
    const { service } = makeService();

    await expect(
      service.getOrCreateStack(baseInput({ stateBucket: 'my-missing-bucket', backendReady: false })),
    ).rejects.toThrow(/my-missing-bucket/);
  });

  it('should re-classify a missing-bucket-shaped failure from LocalWorkspace.create into PulumiBackendNotBootstrappedError as a backstop', async () => {
    const { service } = makeService();
    createMock.mockRejectedValueOnce(new Error('unable to get metadata: NoSuchBucket: The specified bucket does not exist'));

    await expect(service.getOrCreateStack(baseInput({ backendReady: true }))).rejects.toThrow(
      PulumiBackendNotBootstrappedError,
    );
  });

  it('should re-classify a missing-bucket-shaped failure from Stack.createOrSelect into PulumiBackendNotBootstrappedError as a backstop', async () => {
    const { service } = makeService();
    createOrSelectMock.mockRejectedValueOnce(
      new Error('unable to get metadata: NoSuchBucket: The specified bucket does not exist'),
    );

    await expect(service.getOrCreateStack(baseInput({ backendReady: true }))).rejects.toThrow(
      PulumiBackendNotBootstrappedError,
    );
  });

  it('should propagate an SDK failure unchanged when it does not look like a missing bucket', async () => {
    const { service } = makeService();
    createOrSelectMock.mockRejectedValueOnce(new Error('some unrelated CLI failure'));

    let caught: unknown;
    try {
      await service.getOrCreateStack(baseInput({ backendReady: true }));
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeInstanceOf(PulumiBackendNotBootstrappedError);
    expect((caught as Error).message).toContain('some unrelated CLI failure');
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — derived passphrase (portability fix)', () => {
  it('should derive and use a passphrase on first-ever stack creation, with no listStacks probe', async () => {
    const { service } = makeService();
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: DEFAULT_TEST_ACCOUNT_ID });

    await service.getOrCreateStack(baseInput());

    const ws = createOrSelectWs();
    expect(ws.envVars['PULUMI_CONFIG_PASSPHRASE']).toBe(deriveStackPassphrase(DEFAULT_TEST_ACCOUNT_ID, PULUMI_STACK_NAME));
    // No more real-backend probe to disambiguate a passphrase — nothing in
    // the fake workspace exposes `listStacks` any more (see this file's own
    // doc comment on `FakeWorkspace`).
    expect('listStacks' in createOrSelectWs()).toBe(false);
  });

  it('should select an already-existing stack on the SAME machine, deriving the identical passphrase as the prior call', async () => {
    const { service } = makeService();
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: DEFAULT_TEST_ACCOUNT_ID });

    await service.getOrCreateStack(baseInput());
    const firstPassphrase = createOrSelectWs(0).envVars['PULUMI_CONFIG_PASSPHRASE'];

    await service.getOrCreateStack(baseInput());
    const secondPassphrase = createOrSelectWs(1).envVars['PULUMI_CONFIG_PASSPHRASE'];

    expect(secondPassphrase).toBe(firstPassphrase);
  });

  it('should select an already-existing stack from a SECOND machine with no local passphrase record, deriving the identical passphrase without error', async () => {
    // "First machine": a store that has already interacted with this stack.
    const firstMachineSafeStorage = makeAvailableSafeStorage();
    const firstMachineStore = new ElectronStoreService(firstMachineSafeStorage);
    firstMachineStore.set('aws', { region: 'us-west-2', profile: 'personal' });
    const { service: firstMachineService } = makeService({
      safeStorage: firstMachineSafeStorage,
      store: firstMachineStore,
    });
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: DEFAULT_TEST_ACCOUNT_ID });
    await firstMachineService.getOrCreateStack(baseInput());
    const firstMachinePassphrase = createOrSelectWs(0).envVars['PULUMI_CONFIG_PASSPHRASE'];

    // "Second machine": a completely fresh store with no `pulumi` key at all
    // — exactly like a reinstall, a wiped userData, or a second machine
    // pointed at the same state bucket. Before the passphrase-derivation
    // change, this scenario threw a typed "no local passphrase record"
    // error — this is the literal regression test for the bug that change
    // fixed.
    const secondMachineSafeStorage = makeAvailableSafeStorage();
    const secondMachineStore = new ElectronStoreService(secondMachineSafeStorage);
    secondMachineStore.set('aws', { region: 'us-west-2', profile: 'personal' });
    const { service: secondMachineService } = makeService({
      safeStorage: secondMachineSafeStorage,
      store: secondMachineStore,
    });
    // Same AWS account authenticates from the second machine — the whole
    // point of deriving from the account ID rather than storing locally.
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: DEFAULT_TEST_ACCOUNT_ID });

    await secondMachineService.getOrCreateStack(baseInput());

    expect(createOrSelectMock).toHaveBeenCalledTimes(2);
    const secondMachinePassphrase = createOrSelectWs(1).envVars['PULUMI_CONFIG_PASSPHRASE'];
    expect(secondMachinePassphrase).toBe(firstMachinePassphrase);
    expect(secondMachinePassphrase).toBe(deriveStackPassphrase(DEFAULT_TEST_ACCOUNT_ID, PULUMI_STACK_NAME));
  });

  it('should normalize and rethrow a plain Error when sts:GetCallerIdentity fails, and log it via logger.warn', async () => {
    const { service } = makeService();
    stsMock.on(GetCallerIdentityCommand).rejects(new Error('expired credentials'));

    const caught = await service.getOrCreateStack(baseInput()).catch((err: unknown) => err);

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('expired credentials');
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('sts:GetCallerIdentity failed'),
      expect.objectContaining({ error: 'expired credentials' }),
    );
    // The STS failure must never be misclassified as a missing-bucket /
    // not-bootstrapped error — that reclassification only applies to
    // `LocalWorkspace.create`/`Stack.createOrSelect` failures.
    expect(caught).not.toBeInstanceOf(PulumiBackendNotBootstrappedError);
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — pulumi.stackInitialized bookkeeping', () => {
  it('should set pulumi.stackInitialized after successfully creating/selecting a stack', async () => {
    const { service, store } = makeService();

    await service.getOrCreateStack(baseInput());

    expect(store.get('pulumi')?.stackInitialized).toBe(true);
  });

  it('should not set pulumi.stackInitialized when createOrSelect fails', async () => {
    const { service, store } = makeService();
    createOrSelectMock.mockRejectedValueOnce(new Error('some unrelated CLI failure'));

    await expect(service.getOrCreateStack(baseInput())).rejects.toThrow('some unrelated CLI failure');

    expect(store.get('pulumi')?.stackInitialized).toBeUndefined();
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — credentialEnvVars override extension point', () => {
  it('should merge credentialEnvVars into the engine environment', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput({ credentialEnvVars: { AWS_PROFILE: 'personal' } }));

    const opts = createOpts();
    expect(opts.envVars['AWS_PROFILE']).toBe('personal');
  });

  it('should never let credentialEnvVars override the backend URL, region, or passphrase this seam owns', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(
      baseInput({
        credentialEnvVars: {
          PULUMI_BACKEND_URL: 'file:///attacker-controlled',
          PULUMI_CONFIG_PASSPHRASE: 'attacker-supplied',
          AWS_REGION: 'attacker-region',
        },
      }),
    );

    const opts = createOpts();
    expect(opts.envVars['PULUMI_BACKEND_URL']).toBe('s3://my-bucket?region=us-west-2');
    expect(opts.envVars['AWS_REGION']).toBe('us-west-2');
    const finalEnvVars = createOrSelectWs().envVars;
    expect(finalEnvVars['PULUMI_CONFIG_PASSPHRASE']).not.toBe('attacker-supplied');
  });

  it('should support clearing an inherited variable via an explicit empty string', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput({ credentialEnvVars: { AWS_PROFILE: '' } }));

    const opts = createOpts();
    expect(opts.envVars['AWS_PROFILE']).toBe('');
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — wired to the real credential resolver', () => {
  it('should pass a named-profile selection all the way through into the final envVars, including the exclusivity clear', async () => {
    const safeStorage = makeAvailableSafeStorage();
    const store = new ElectronStoreService(safeStorage);
    store.set('aws', { region: 'us-west-2', profile: 'personal' });
    const { service } = makeService({ safeStorage, store });

    // Wires the resolver's output into credentialEnvVars — resolveCredentialEnvVars
    // is the real function a caller uses, not a hand-built test fixture.
    await service.getOrCreateStack(baseInput({ credentialEnvVars: resolveCredentialEnvVars(store) }));

    const opts = createOpts();
    expect(opts.envVars['AWS_PROFILE']).toBe('personal');
    expect(opts.envVars['AWS_ACCESS_KEY_ID']).toBe('');
    expect(opts.envVars['AWS_SECRET_ACCESS_KEY']).toBe('');
    expect(opts.envVars['AWS_SESSION_TOKEN']).toBe('');
  });

  it('should pass a pasted-keys selection all the way through into the final envVars, including the exclusivity clear', async () => {
    const safeStorage = makeAvailableSafeStorage();
    const store = new ElectronStoreService(safeStorage);
    store.set('aws', { region: 'us-west-2', profile: 'hyveon-pasted' });
    store.setPastedCredentials('hyveon-pasted', { accessKeyId: 'AKID123', secretAccessKey: 'SECRET456' });
    const { service } = makeService({ safeStorage, store });

    await service.getOrCreateStack(baseInput({ credentialEnvVars: resolveCredentialEnvVars(store) }));

    const opts = createOpts();
    expect(opts.envVars['AWS_ACCESS_KEY_ID']).toBe('AKID123');
    expect(opts.envVars['AWS_SECRET_ACCESS_KEY']).toBe('SECRET456');
    expect(opts.envVars['AWS_PROFILE']).toBe('');
    expect(opts.envVars['AWS_DEFAULT_PROFILE']).toBe('');
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — credential resolution is unconditional, not opt-in', () => {
  /**
   * Regression tests for `resolveCredentialEnvVars` having no production call
   * site: every test (and every real future caller) had to remember to call it
   * and pass the result through `input.credentialEnvVars`, so a caller that
   * simply forgot would silently get a stack with no credential vars and no
   * clears, exactly the "engine falls back to its own default chain" outcome
   * spec.md:100 forbids. These tests never pass `credentialEnvVars` at
   * all — proving `getOrCreateStack` resolves it itself from the store.
   */
  it('should resolve credentials from the store itself when credentialEnvVars is omitted entirely', async () => {
    const safeStorage = makeAvailableSafeStorage();
    const store = new ElectronStoreService(safeStorage);
    store.set('aws', { region: 'us-west-2', profile: 'personal' });
    const { service } = makeService({ safeStorage, store });

    // No credentialEnvVars anywhere in this input — the shape of a caller
    // that never learned about the extension point at all.
    await service.getOrCreateStack(baseInput());

    const opts = createOpts();
    expect(opts.envVars['AWS_PROFILE']).toBe('personal');
    expect(opts.envVars['AWS_ACCESS_KEY_ID']).toBe('');
    expect(opts.envVars['AWS_SECRET_ACCESS_KEY']).toBe('');
    expect(opts.envVars['AWS_SESSION_TOKEN']).toBe('');
  });

  it('should resolve pasted keys from the store itself when credentialEnvVars is omitted entirely', async () => {
    const safeStorage = makeAvailableSafeStorage();
    const store = new ElectronStoreService(safeStorage);
    store.set('aws', { region: 'us-west-2', profile: 'hyveon-pasted' });
    store.setPastedCredentials('hyveon-pasted', { accessKeyId: 'AKID123', secretAccessKey: 'SECRET456' });
    const { service } = makeService({ safeStorage, store });

    await service.getOrCreateStack(baseInput());

    const opts = createOpts();
    expect(opts.envVars['AWS_ACCESS_KEY_ID']).toBe('AKID123');
    expect(opts.envVars['AWS_SECRET_ACCESS_KEY']).toBe('SECRET456');
    expect(opts.envVars['AWS_PROFILE']).toBe('');
    expect(opts.envVars['AWS_DEFAULT_PROFILE']).toBe('');
    expect(opts.envVars['AWS_SESSION_TOKEN']).toBe('');
  });

  it('should throw PulumiCredentialsNotConfiguredError rather than silently running with no credential vars when nothing is selected and none are supplied', async () => {
    const safeStorage = makeAvailableSafeStorage();
    const store = new ElectronStoreService(safeStorage); // no aws.profile at all
    const { service } = makeService({ safeStorage, store });

    await expect(service.getOrCreateStack(baseInput())).rejects.toThrow(PulumiCredentialsNotConfiguredError);

    // Refused before ever reaching the SDK — never falls through to the
    // engine's own default AWS credential chain.
    expect(createMock).not.toHaveBeenCalled();
    expect(createOrSelectMock).not.toHaveBeenCalled();
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — credentials are not logged (spec-critical)', () => {
  it('should never pass the resolved pasted-key values to any logger call', async () => {
    const safeStorage = makeAvailableSafeStorage();
    const store = new ElectronStoreService(safeStorage);
    store.set('aws', { region: 'us-west-2', profile: 'hyveon-pasted' });
    store.setPastedCredentials('hyveon-pasted', {
      accessKeyId: 'AKID-SHOULD-NEVER-BE-LOGGED',
      secretAccessKey: 'SECRET-SHOULD-NEVER-BE-LOGGED',
    });
    const { service } = makeService({ safeStorage, store });
    const credentialEnvVars = resolveCredentialEnvVars(store);

    await service.getOrCreateStack(baseInput({ credentialEnvVars }));

    // This service does call logger.debug (for pulumiHome/workDir) — the
    // assertion that matters is that *none* of those calls, across every
    // logger method, ever carry the actual secret values anywhere in their
    // arguments, not that logging never happens at all.
    const allLoggerCalls = [
      ...loggerMock.debug.mock.calls,
      ...loggerMock.info.mock.calls,
      ...loggerMock.warn.mock.calls,
      ...loggerMock.error.mock.calls,
    ];
    expect(allLoggerCalls.length).toBeGreaterThan(0); // sanity: this path does log something
    const serialized = JSON.stringify(allLoggerCalls);
    expect(serialized).not.toContain('AKID-SHOULD-NEVER-BE-LOGGED');
    expect(serialized).not.toContain('SECRET-SHOULD-NEVER-BE-LOGGED');
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — elapsed-time logging', () => {
  it('should log elapsedMs around engine resolution, LocalWorkspace creation, and stack creation/selection', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput());

    expect(loggerMock.debug).toHaveBeenCalledWith(
      'PulumiWorkspaceService: engine resolved',
      expect.objectContaining({ elapsedMs: expect.any(Number) }),
    );
    expect(loggerMock.debug).toHaveBeenCalledWith(
      'PulumiWorkspaceService: LocalWorkspace created',
      expect.objectContaining({ elapsedMs: expect.any(Number) }),
    );
    expect(loggerMock.debug).toHaveBeenCalledWith(
      'PulumiWorkspaceService: stack created/selected',
      expect.objectContaining({ elapsedMs: expect.any(Number) }),
    );
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — onPhase forwarding', () => {
  it('should forward input.onPhase to PulumiEngineService.resolve unchanged', async () => {
    const { service, engine } = makeService();
    const onPhase = vi.fn();

    await service.getOrCreateStack(baseInput({ onPhase }));

    expect(engine.resolve).toHaveBeenCalledWith(onPhase);
  });

  it('should not require onPhase — omitting it must not throw or change behaviour', async () => {
    const { service, engine } = makeService();

    await service.getOrCreateStack(baseInput());

    expect(engine.resolve).toHaveBeenCalledWith(undefined);
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — legacy passphrase migration', () => {
  /** The legacy plaintext passphrase seeded into the store for these tests. */
  const LEGACY_PASSPHRASE = 'legacy-random-value';

  it('should re-encrypt via the CLI and remove the legacy store entry when a legacy passphrase is present', async () => {
    const { service, store } = makeService();
    store.setPulumiPassphrase(LEGACY_PASSPHRASE);
    const spawned = queueSpawnResult({ code: 0 });

    await service.getOrCreateStack(baseInput());

    expect(spawnMock).toHaveBeenCalledOnce();
    const [command, args, opts] = spawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(command).toBe(FAKE_COMMAND.command);
    expect(args).toEqual(['stack', 'change-secrets-provider', 'passphrase', '--stack', PULUMI_STACK_NAME, '--non-interactive']);
    // Old passphrase decrypts the current provider via the env var...
    expect(opts.env['PULUMI_CONFIG_PASSPHRASE']).toBe(LEGACY_PASSPHRASE);
    // ...new passphrase is supplied over stdin (the Step 3.0 spike finding),
    // as a single line, no confirmation.
    expect(spawned.stdinWrites).toEqual([`${deriveStackPassphrase(DEFAULT_TEST_ACCOUNT_ID, PULUMI_STACK_NAME)}\n`]);

    expect(store.get('pulumi')?.passphrase).toBeUndefined();
    // The real operation still proceeds with the NEW derived passphrase.
    const ws = createOrSelectWs();
    expect(ws.envVars['PULUMI_CONFIG_PASSPHRASE']).toBe(deriveStackPassphrase(DEFAULT_TEST_ACCOUNT_ID, PULUMI_STACK_NAME));
    expect(createOrSelectMock).toHaveBeenCalledOnce();
  });

  it('should log stack name only, never either passphrase value, on successful migration', async () => {
    const { service, store } = makeService();
    store.setPulumiPassphrase(LEGACY_PASSPHRASE);
    queueSpawnResult({ code: 0 });

    await service.getOrCreateStack(baseInput());

    expect(loggerMock.debug).toHaveBeenCalledWith(
      'PulumiWorkspaceService: migrated legacy passphrase to derived value',
      { stackName: PULUMI_STACK_NAME },
    );
    const allLoggerCalls = [
      ...loggerMock.debug.mock.calls,
      ...loggerMock.info.mock.calls,
      ...loggerMock.warn.mock.calls,
      ...loggerMock.error.mock.calls,
    ];
    const serialized = JSON.stringify(allLoggerCalls);
    expect(serialized).not.toContain(LEGACY_PASSPHRASE);
    expect(serialized).not.toContain(deriveStackPassphrase(DEFAULT_TEST_ACCOUNT_ID, PULUMI_STACK_NAME));
  });

  it('should leave the legacy passphrase in the store when re-encryption fails, so the next call retries with the same value', async () => {
    const { service, store } = makeService();
    store.setPulumiPassphrase(LEGACY_PASSPHRASE);
    queueSpawnResult({ code: 1 });

    await expect(service.getOrCreateStack(baseInput())).rejects.toThrow(
      /Failed to migrate the legacy Pulumi secrets passphrase/,
    );
    expect(store.get('pulumi')?.passphrase).toBeDefined();
    expect(store.getPulumiPassphrase()).toBe(LEGACY_PASSPHRASE);
    expect(createOrSelectMock).not.toHaveBeenCalled();

    // Retry: the CLI succeeds this time.
    queueSpawnResult({ code: 0 });
    await service.getOrCreateStack(baseInput());

    expect(store.get('pulumi')?.passphrase).toBeUndefined();
    expect(createOrSelectMock).toHaveBeenCalledOnce();
  });

  it('should not attempt migration at all when no legacy passphrase is stored', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput());

    expect(spawnMock).not.toHaveBeenCalled();
    expect(createOrSelectMock).toHaveBeenCalledOnce();
  });

  it('should fail with a clear keychain-unavailable error before attempting migration, when a legacy passphrase is stored but the keychain is unavailable', async () => {
    const safeStorage = makeAvailableSafeStorage();
    const store = makeStoreWithDefaultCredentials(safeStorage);
    store.setPulumiPassphrase(LEGACY_PASSPHRASE);
    // Keychain becomes unavailable AFTER the legacy value was written —
    // mirrors a keychain that's locked/unavailable at read time, per
    // `SafeStorageService.decrypt`'s own remarks on write/read-time
    // availability mismatches.
    vi.spyOn(safeStorage, 'isAvailable').mockReturnValue(false);
    const { service } = makeService({ safeStorage, store });

    await expect(service.getOrCreateStack(baseInput())).rejects.toThrow(/OS keychain is currently unavailable/);

    expect(spawnMock).not.toHaveBeenCalled();
    expect(createOrSelectMock).not.toHaveBeenCalled();
    // Legacy entry must be left untouched — same retry-safety contract as
    // any other migration failure.
    expect(store.get('pulumi')?.passphrase).toBeDefined();
    expect(loggerMock.error).toHaveBeenCalledWith(
      'PulumiWorkspaceService: cannot migrate the legacy Pulumi passphrase because the OS keychain is unavailable',
      { stackName: PULUMI_STACK_NAME },
    );
  });
});

describe('deriveStackPassphrase', () => {
  it('should return the exact pinned digest for a fixed accountId/stackName pair, regression-pinning the derivation salt', () => {
    // Computed once via a scratch Node script using the real
    // PULUMI_PASSPHRASE_DERIVATION_SALT constant and HMAC-SHA256
    // implementation, then hard-coded here as the expected RESULT — not
    // recomputed at test time — so this test fails if the salt or the
    // accountId/stackName concatenation order ever changes silently.
    const result = deriveStackPassphrase('123456789012', 'production');

    expect(result).toBe('d5a065d09f8c3ffc70f947e5670b107eff693bbc80058818cbe7938ceb86e3e0');
  });

  it('should produce a different passphrase for a different accountId, same stackName', () => {
    const first = deriveStackPassphrase('123456789012', 'production');
    const second = deriveStackPassphrase('999999999999', 'production');

    expect(first).not.toBe(second);
  });

  it('should produce a different passphrase for a different stackName, same accountId', () => {
    const first = deriveStackPassphrase('123456789012', 'production');
    const second = deriveStackPassphrase('123456789012', 'staging');

    expect(first).not.toBe(second);
  });

  it('should always return a 64-character lowercase hex string', () => {
    const result = deriveStackPassphrase('123456789012', 'production');

    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('resolveAwsAccountId', () => {
  /**
   * Builds a genuine `STSClient` instance for `stsClientFactory` tests to
   * return — construction performs no network I/O, so this is safe to call
   * directly in a test. The module-level `stsMock` (`aws-sdk-client-mock`)
   * intercepts `send()` on every `STSClient` instance, including this one,
   * so each test controls the `GetCallerIdentity` response via
   * `stsMock.on(GetCallerIdentityCommand)` rather than spying on the
   * instance directly — the same convention as `IamCheckService.test.ts`,
   * and one that avoids `vi.spyOn`'s overload-inference problems against
   * `STSClient.send`'s heavily overloaded signature.
   */
  function stubStsClient(): STSClient {
    return new STSClient({ region: 'us-west-2', credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' } });
  }

  it('should return the Account field from a successful GetCallerIdentity call', async () => {
    const safeStorage = makeAvailableSafeStorage();
    const store = new ElectronStoreService(safeStorage);
    store.set('aws', { region: 'us-west-2', profile: 'personal' });
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
    const stsClientFactory = vi.fn().mockReturnValue(stubStsClient());

    const result = await resolveAwsAccountId(store, 'us-west-2', stsClientFactory);

    expect(result).toBe('123456789012');
  });

  it('should pass the resolved credentials (pasted keys) to the STS client factory', async () => {
    const safeStorage = makeAvailableSafeStorage();
    const store = new ElectronStoreService(safeStorage);
    store.set('aws', { region: 'us-west-2', profile: 'hyveon-pasted' });
    store.setPastedCredentials('hyveon-pasted', { accessKeyId: 'AKID123', secretAccessKey: 'SECRET456' });
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
    const stsClientFactory = vi.fn().mockReturnValue(stubStsClient());

    await resolveAwsAccountId(store, 'us-west-2', stsClientFactory);

    expect(stsClientFactory).toHaveBeenCalledWith({
      region: 'us-west-2',
      credentials: { accessKeyId: 'AKID123', secretAccessKey: 'SECRET456' },
    });
  });

  it('should pass fromIni-shaped credentials to the STS client factory for a profile source', async () => {
    const safeStorage = makeAvailableSafeStorage();
    const store = new ElectronStoreService(safeStorage);
    store.set('aws', { region: 'us-west-2', profile: 'personal' });
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
    const stsClientFactory = vi.fn().mockReturnValue(stubStsClient());

    await resolveAwsAccountId(store, 'us-west-2', stsClientFactory);

    const call = stsClientFactory.mock.calls[0]![0] as { region: string; credentials: unknown };
    expect(call.region).toBe('us-west-2');
    // `resolveAwsClientCredentials`'s doc comment describes the 'profile'
    // case as `fromIni({ profile })`'s return value — a function — so this
    // asserts that shape rather than the provider function's internals.
    expect(typeof call.credentials).toBe('function');
  });

  it('should throw when GetCallerIdentity resolves with no Account field', async () => {
    const safeStorage = makeAvailableSafeStorage();
    const store = new ElectronStoreService(safeStorage);
    store.set('aws', { region: 'us-west-2', profile: 'personal' });
    stsMock.on(GetCallerIdentityCommand).resolves({});
    const stsClientFactory = vi.fn().mockReturnValue(stubStsClient());

    await expect(resolveAwsAccountId(store, 'us-west-2', stsClientFactory)).rejects.toThrow(
      'sts:GetCallerIdentity did not return an AWS account ID.',
    );
  });

  it('should propagate a raw STS client error unchanged', async () => {
    const safeStorage = makeAvailableSafeStorage();
    const store = new ElectronStoreService(safeStorage);
    store.set('aws', { region: 'us-west-2', profile: 'personal' });
    stsMock.on(GetCallerIdentityCommand).rejects(new Error('some unrelated STS failure'));
    const stsClientFactory = vi.fn().mockReturnValue(stubStsClient());

    await expect(resolveAwsAccountId(store, 'us-west-2', stsClientFactory)).rejects.toThrow(
      'some unrelated STS failure',
    );
  });
});
