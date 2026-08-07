/**
 * Unit tests for `PulumiWorkspaceService` — the Automation API
 * workspace/backend/passphrase seam. `getOrCreateStack` builds the real
 * `LocalWorkspace` itself and, only when no LOCAL passphrase record exists,
 * asks that workspace's own `listStacks()` whether the stack already exists
 * in the REAL backend before ever generating a fresh passphrase.
 *
 * `ElectronStoreService`/`SafeStorageService` are used as *real* instances
 * (non-Electron Map-fallback path), not stubs — the spec-critical passphrase
 * scenarios depend on the actual interaction between this service and those
 * two collaborators (in particular, `SafeStorageService.decrypt()`'s silent
 * "return the raw ciphertext unchanged when the keychain is currently
 * unavailable" behaviour — see `PulumiWorkspaceService.resolvePassphrase`'s
 * doc comment). `SafeStorageService.encrypt`/`decrypt` are spied with a
 * reversible `enc-<plaintext>` transform (mirroring
 * `ElectronStoreService.test.ts`'s round-trip helper) rather than left
 * un-stubbed, because the real implementation would otherwise require the
 * native `electron` module once `isAvailable()` is mocked `true`. Only
 * `PulumiEngineService` (whose own resolution is already covered by its own
 * test file) and the Pulumi SDK itself are module-mocked.
 *
 * ## Mocking `LocalWorkspace.create` / `Stack.createOrSelect`
 *
 * `getOrCreateStack` builds the workspace itself via the lower-level
 * `LocalWorkspace.create(opts)`, then (only when no local passphrase is
 * stored) calls `ws.listStacks()` on it, then calls `Stack.createOrSelect`
 * with that same instance — rather than the single convenience
 * `LocalWorkspace.createOrSelectStack(args, opts)` call. `createMock`
 * (mocking `LocalWorkspace.create`) resolves with a fake, mutable `ws`
 * object carrying its own `envVars` (a shallow copy of `opts.envVars`,
 * mirroring the real SDK's constructor) and a `listStacks` mock — so the
 * production code's `ws.envVars['PULUMI_CONFIG_PASSPHRASE'] = passphrase`
 * mutation is observable via the SAME object `createOrSelectMock` is later
 * called with.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

const { createMock, createOrSelectMock, mkdirSyncMock, existsSyncMock, loggerMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  createOrSelectMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: { create: createMock },
  Stack: { createOrSelect: createOrSelectMock },
}));

vi.mock('node:fs', () => ({ mkdirSync: mkdirSyncMock, existsSync: existsSyncMock }));

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
  PulumiPassphraseUnavailableError,
  PULUMI_STACK_NAME,
  PULUMI_PROJECT_NAME,
  type PulumiWorkspaceInput,
} from './PulumiWorkspaceService.js';
import type { PulumiEngineService } from './PulumiEngineService.js';
import { SafeStorageService } from './SafeStorageService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { resolveCredentialEnvVars, PulumiCredentialsNotConfiguredError } from './PulumiCredentialResolver.js';

/** Minimal `PulumiCommand`-shaped object the mocked SDK is given. */
const FAKE_COMMAND = { command: '/fake/userData/pulumi/versions/3.255.0/bin/pulumi', version: null };

/** Fake `Stack` the mocked `Stack.createOrSelect` resolves with. */
const FAKE_STACK = { name: PULUMI_STACK_NAME } as Partial<Stack> as Stack;

/** No-op inline program — never actually invoked, since the SDK call is mocked. */
const FAKE_PROGRAM: PulumiFn = async () => ({});

/** Shape of the fake workspace object `createMock` resolves with — see this file's own doc comment. */
interface FakeWorkspace {
  envVars: Record<string, string>;
  listStacks: ReturnType<typeof vi.fn>;
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
  const service = new TestablePulumiWorkspaceService(engine, safeStorage, store);
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
 * the `callIndex`-th `getOrCreateStack` call (0-based) — carries the FINAL
 * envVars, including `PULUMI_CONFIG_PASSPHRASE`, since this service mutates
 * `ws.envVars` in place after the stored or new passphrase resolves.
 */
function createOrSelectWs(callIndex = 0): FakeWorkspace {
  return createOrSelectMock.mock.calls[callIndex]![1] as FakeWorkspace;
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

  // Default: no `Pulumi.{yaml,yml,json}` exists yet in `workDir` (a brand-new
  // workspace directory) — every test that cares about an EXISTING project
  // settings file overrides this explicitly.
  existsSyncMock.mockReturnValue(false);

  // `LocalWorkspace.create` resolves with a fake, mutable workspace whose
  // `envVars` starts as a shallow copy of what was passed in (mirroring the
  // real SDK's constructor — see this file's own doc comment) and whose
  // `listStacks()` defaults to "nothing exists yet" (the overwhelmingly
  // common case in these tests: a genuinely new stack, or a stack this same
  // install already created and therefore never even calls `listStacks` at
  // all — see the "no local passphrase" describe block below for why).
  createMock.mockImplementation(async (opts: { envVars?: Record<string, string> }) => {
    const ws: FakeWorkspace = {
      ...opts,
      envVars: { ...opts.envVars },
      listStacks: vi.fn().mockResolvedValue([]),
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
    const { service, store } = makeService();
    // Fast path (stored passphrase) so `Stack.createOrSelect` is reached without a `listStacks` probe.
    store.setPulumiPassphrase('already-stored');
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

describe('PulumiWorkspaceService.getOrCreateStack — passphrase generated once and reused', () => {
  it('should generate and store a passphrase on first use, then reuse the identical value on later calls', async () => {
    const { service, store } = makeService();

    await service.getOrCreateStack(baseInput());
    const firstPassphrase = createOrSelectWs(0).envVars['PULUMI_CONFIG_PASSPHRASE'];
    expect(firstPassphrase).toBeTruthy();
    expect(store.get('pulumi')?.passphrase).toBeDefined();
    // Confirms the store holds the *encrypted* form, not the plaintext used in envVars.
    expect(store.get('pulumi')?.passphrase).toBe(`enc-${firstPassphrase}`);

    // The stack now genuinely exists (a real passphrase is now stored) — this
    // second call must take the fast, already-stored-passphrase path.
    await service.getOrCreateStack(baseInput());
    const secondPassphrase = createOrSelectWs(1).envVars['PULUMI_CONFIG_PASSPHRASE'];

    expect(secondPassphrase).toBe(firstPassphrase);
  });

  it('should generate a passphrase with at least 256 bits of entropy (32+ raw bytes)', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput());

    const passphrase = createOrSelectWs().envVars['PULUMI_CONFIG_PASSPHRASE'];
    // base64 of N bytes decodes back to N bytes.
    expect(Buffer.from(passphrase, 'base64').length).toBeGreaterThanOrEqual(32);
  });

  it('should throw PulumiPassphraseUnavailableError and write nothing when the keychain is unavailable for a brand-new stack', async () => {
    const safeStorage = new SafeStorageService();
    vi.spyOn(safeStorage, 'isAvailable').mockReturnValue(false);
    const store = new ElectronStoreService(safeStorage);
    const { service } = makeService({ safeStorage, store });

    await expect(service.getOrCreateStack(baseInput())).rejects.toThrow(PulumiPassphraseUnavailableError);

    expect(createOrSelectMock).not.toHaveBeenCalled();
    expect(store.get('pulumi')?.passphrase).toBeUndefined();
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — missing passphrase for an existing stack fails loudly (spec-critical)', () => {
  /**
   * Simulates "a stack already exists" by pre-populating the store with a
   * passphrase entry via a real `setPulumiPassphrase` call — exercising the
   * exact accessor pair `PulumiWorkspaceService` itself uses, rather than
   * poking the schema directly.
   */
  function seedExistingPassphrase(safeStorage: SafeStorageService): ElectronStoreService {
    const store = new ElectronStoreService(safeStorage);
    store.setPulumiPassphrase('original-passphrase-that-encrypted-real-state');
    return store;
  }

  it('should throw PulumiPassphraseUnavailableError and never call Stack.createOrSelect when the keychain is currently unavailable', async () => {
    const safeStorage = makeAvailableSafeStorage(); // available while seeding
    const store = seedExistingPassphrase(safeStorage);
    const storedBefore = store.get('pulumi')?.passphrase;

    // Keychain goes unavailable for the actual operation.
    vi.spyOn(safeStorage, 'isAvailable').mockReturnValue(false);
    const { service } = makeService({ safeStorage, store });

    await expect(service.getOrCreateStack(baseInput())).rejects.toThrow(PulumiPassphraseUnavailableError);

    expect(createOrSelectMock).not.toHaveBeenCalled();
    // Never silently regenerated — the original ciphertext is untouched.
    expect(store.get('pulumi')?.passphrase).toBe(storedBefore);
  });

  it('should throw PulumiPassphraseUnavailableError and never call Stack.createOrSelect when the stored ciphertext cannot be decrypted', async () => {
    const safeStorage = makeAvailableSafeStorage();
    const store = seedExistingPassphrase(safeStorage);
    const storedBefore = store.get('pulumi')?.passphrase;

    // Corrupted/foreign ciphertext: safeStorage is available, but decrypting
    // this particular blob fails (e.g. encrypted on a different machine).
    vi.spyOn(safeStorage, 'decrypt').mockImplementation(() => {
      throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
    });
    const { service } = makeService({ safeStorage, store });

    await expect(service.getOrCreateStack(baseInput())).rejects.toThrow(PulumiPassphraseUnavailableError);

    expect(createOrSelectMock).not.toHaveBeenCalled();
    expect(store.get('pulumi')?.passphrase).toBe(storedBefore);
  });

  it('should never silently generate a replacement passphrase that could not decrypt the existing stack', async () => {
    const safeStorage = makeAvailableSafeStorage();
    const store = seedExistingPassphrase(safeStorage);
    const originalCiphertext = store.get('pulumi')?.passphrase;

    vi.spyOn(safeStorage, 'decrypt').mockImplementation(() => {
      throw new Error('decrypt failed');
    });
    const setSpy = vi.spyOn(store, 'setPulumiPassphrase');
    const { service } = makeService({ safeStorage, store });

    await expect(service.getOrCreateStack(baseInput())).rejects.toThrow(PulumiPassphraseUnavailableError);

    // The write path was never even attempted.
    expect(setSpy).not.toHaveBeenCalled();
    expect(store.get('pulumi')?.passphrase).toBe(originalCiphertext);
  });

  describe('Finding 1 (final review): reinstall / wiped userData / second machine against an existing remote stack', () => {
    it('should throw PulumiPassphraseUnavailableError with reason existing-stack-no-local-record when listStacks reports the stack already exists remotely and no local passphrase was ever stored', async () => {
      // No seeding at all — nothing has ever been stored locally, exactly
      // like a reinstall or a second machine pointed at the same state
      // bucket. Before Finding 1's fix, this scenario was indistinguishable
      // from a genuinely brand-new stack and silently generated a fresh,
      // WRONG passphrase (permanently wedging the install). The fix: query
      // the REAL backend via `listStacks()` before ever deciding.
      const safeStorage = makeAvailableSafeStorage();
      const store = new ElectronStoreService(safeStorage);
      store.set('aws', { region: 'us-west-2', profile: 'personal' });
      const setSpy = vi.spyOn(store, 'setPulumiPassphrase');
      const { service } = makeService({ safeStorage, store });
      // Simulate the remote backend genuinely already having this stack —
      // `listStacks()` (queried against the real `s3://` backend in
      // production) returns a summary for PULUMI_STACK_NAME.
      createMock.mockImplementationOnce(async (opts: { envVars?: Record<string, string> }) => ({
        ...opts,
        envVars: { ...opts.envVars },
        listStacks: vi.fn().mockResolvedValue([{ name: PULUMI_STACK_NAME, current: true }]),
      }));

      let caught: unknown;
      try {
        await service.getOrCreateStack(baseInput());
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PulumiPassphraseUnavailableError);
      expect((caught as PulumiPassphraseUnavailableError).reason).toBe('existing-stack-no-local-record');
      expect(createOrSelectMock).not.toHaveBeenCalled();
      // Critically: no passphrase was silently generated and persisted for a
      // stack that already has real, different encrypted state remotely.
      expect(setSpy).not.toHaveBeenCalled();
      expect(store.get('pulumi')?.passphrase).toBeUndefined();
    });

    it('should call listStacks on the SAME workspace it later hands to Stack.createOrSelect, not a second instance', async () => {
      const safeStorage = makeAvailableSafeStorage();
      const store = new ElectronStoreService(safeStorage);
      store.set('aws', { region: 'us-west-2', profile: 'personal' });
      const { service } = makeService({ safeStorage, store });

      await service.getOrCreateStack(baseInput());

      expect(createMock).toHaveBeenCalledOnce();
      const ws = createOrSelectWs();
      expect(ws.listStacks).toHaveBeenCalledOnce();
    });

    it('should generate and persist a new passphrase when listStacks confirms the stack does not exist remotely (genuinely new stack, unaffected by the fix)', async () => {
      const safeStorage = makeAvailableSafeStorage();
      const store = new ElectronStoreService(safeStorage);
      store.set('aws', { region: 'us-west-2', profile: 'personal' });
      const { service } = makeService({ safeStorage, store });
      // Default createMock impl already resolves listStacks() to `[]` — the
      // genuinely-new-stack case this fix must not regress.

      await service.getOrCreateStack(baseInput());

      const ws = createOrSelectWs();
      expect(ws.listStacks).toHaveBeenCalledOnce();
      expect(ws.envVars['PULUMI_CONFIG_PASSPHRASE']).toBeTruthy();
      expect(store.get('pulumi')?.passphrase).toBeDefined();
    });

    it('should never call listStacks at all when a passphrase is already stored locally (common-case path is unaffected)', async () => {
      const safeStorage = makeAvailableSafeStorage();
      const store = new ElectronStoreService(safeStorage);
      store.set('aws', { region: 'us-west-2', profile: 'personal' });
      store.setPulumiPassphrase('already-stored-passphrase');
      const { service } = makeService({ safeStorage, store });

      await service.getOrCreateStack(baseInput());

      const ws = createOrSelectWs();
      expect(ws.listStacks).not.toHaveBeenCalled();
    });
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

  it('should log elapsedMs around the listStacks probe on the no-local-passphrase path', async () => {
    const safeStorage = makeAvailableSafeStorage();
    const store = new ElectronStoreService(safeStorage);
    store.set('aws', { region: 'us-west-2', profile: 'personal' });
    const { service } = makeService({ safeStorage, store });

    await service.getOrCreateStack(baseInput());

    expect(loggerMock.debug).toHaveBeenCalledWith(
      'PulumiWorkspaceService: listStacks resolved',
      expect.objectContaining({ elapsedMs: expect.any(Number), stackCount: 0 }),
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
