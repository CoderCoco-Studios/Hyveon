/**
 * Unit tests for `PulumiWorkspaceService` — the Automation API
 * workspace/backend/passphrase seam (Tasks 4.3/4.4).
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
 * `PulumiEngineService` (whose own resolution is Task 4.1/4.2's concern,
 * already covered by its own test file) and the Pulumi SDK itself are
 * module-mocked.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

const { createOrSelectStackMock, mkdirSyncMock, loggerMock } = vi.hoisted(() => ({
  createOrSelectStackMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: { createOrSelectStack: createOrSelectStackMock },
}));

vi.mock('node:fs', () => ({ mkdirSync: mkdirSyncMock }));

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

/** Fake `Stack` the mocked `createOrSelectStack` resolves with. */
const FAKE_STACK = { name: PULUMI_STACK_NAME } as unknown as Stack;

/** No-op inline program — never actually invoked, since the SDK call is mocked. */
const FAKE_PROGRAM: PulumiFn = async () => ({});

/**
 * Builds a valid `PulumiWorkspaceInput` for a genuinely new stack against a
 * bootstrapped backend, with all fields overridable. Centralizing the
 * defaults here (rather than repeating them per test) is what keeps the
 * addition of `stateBucketRegion`/`stackExists` a one-line change per test
 * instead of touching every call site.
 */
function baseInput(overrides?: Partial<PulumiWorkspaceInput>): PulumiWorkspaceInput {
  return {
    program: FAKE_PROGRAM,
    stateBucket: 'my-bucket',
    stateBucketRegion: 'us-west-2',
    backendReady: true,
    stackExists: false,
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
  return { resolve: vi.fn().mockResolvedValue(FAKE_COMMAND) } as unknown as PulumiEngineService;
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

beforeEach(() => {
  createOrSelectStackMock.mockReset();
  mkdirSyncMock.mockReset();
  loggerMock.debug.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();
  createOrSelectStackMock.mockResolvedValue(FAKE_STACK);
});

describe('PulumiWorkspaceService.getOrCreateStack — workDir/pulumiHome stability', () => {
  it('should use a stable pulumiHome/workDir under userData, not a tmpdir', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput());

    expect(createOrSelectStackMock).toHaveBeenCalledOnce();
    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { pulumiHome: string; workDir: string }];
    expect(opts.pulumiHome).toBe(PULUMI_HOME_DIR);
    expect(opts.workDir).toBe(WORK_DIR);
    expect(opts.pulumiHome).not.toContain('tmp');
    expect(opts.workDir).not.toContain('tmp');
  });

  it('should reuse the exact same pulumiHome/workDir across repeated operations, not grow', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput());
    await service.getOrCreateStack(baseInput({ stackExists: true }));
    await service.getOrCreateStack(baseInput({ stackExists: true }));

    expect(createOrSelectStackMock).toHaveBeenCalledTimes(3);
    const paths = createOrSelectStackMock.mock.calls.map(
      (call) => call[1] as { pulumiHome: string; workDir: string },
    );
    // Every call sees the identical pair of paths — no per-operation directory.
    expect(new Set(paths.map((p) => p.pulumiHome)).size).toBe(1);
    expect(new Set(paths.map((p) => p.workDir)).size).toBe(1);
  });

  it('should keep pulumiHome distinct from the engine install cache root', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput());

    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { pulumiHome: string }];
    expect(opts.pulumiHome).not.toBe('/fake/userData/pulumi');
    expect(opts.pulumiHome.startsWith('/fake/userData/pulumi/versions')).toBe(false);
  });

  it('should create pulumiHome/workDir via mkdirSync with recursive: true', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput());

    expect(mkdirSyncMock).toHaveBeenCalledWith(PULUMI_HOME_DIR, { recursive: true });
    expect(mkdirSyncMock).toHaveBeenCalledWith(WORK_DIR, { recursive: true });
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — bare stack name', () => {
  it('should pass the bare stack name and project name, never an organization/-qualified name', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput());

    const [args] = createOrSelectStackMock.mock.calls[0] as [{ stackName: string; projectName: string }];
    expect(args.stackName).toBe(PULUMI_STACK_NAME);
    expect(args.projectName).toBe(PULUMI_PROJECT_NAME);
    expect(args.stackName).not.toContain('/');
    expect(args.stackName).not.toContain('organization');
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — PULUMI_BACKEND_URL and region', () => {
  it('should build the backend URL as s3://<stateBucket>?region=<region>', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput({ stateBucket: 'hyveon-state-abc123', stateBucketRegion: 'eu-west-1' }));

    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { envVars: Record<string, string> }];
    expect(opts.envVars['PULUMI_BACKEND_URL']).toBe('s3://hyveon-state-abc123?region=eu-west-1');
  });

  it('should also set AWS_REGION from stateBucketRegion', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput({ stateBucketRegion: 'ap-southeast-2' }));

    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { envVars: Record<string, string> }];
    expect(opts.envVars['AWS_REGION']).toBe('ap-southeast-2');
  });

  it('should URL-encode the region on the backend URL', async () => {
    const { service } = makeService();

    // Not a real region, but proves special characters don't corrupt the URL.
    await service.getOrCreateStack(baseInput({ stateBucketRegion: 'us east 1' }));

    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { envVars: Record<string, string> }];
    expect(opts.envVars['PULUMI_BACKEND_URL']).toBe('s3://my-bucket?region=us%20east%201');
  });

  it('should use the passphrase secrets provider', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput());

    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { secretsProvider: string }];
    expect(opts.secretsProvider).toBe('passphrase');
  });

  it('should source pulumiCommand from PulumiEngineService.resolve(), never PATH', async () => {
    const { service, engine } = makeService();

    await service.getOrCreateStack(baseInput());

    expect(engine.resolve).toHaveBeenCalledOnce();
    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { pulumiCommand: unknown }];
    expect(opts.pulumiCommand).toBe(FAKE_COMMAND);
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — backend-not-bootstrapped', () => {
  it('should throw PulumiBackendNotBootstrappedError without touching Pulumi when backendReady is false', async () => {
    const { service, engine } = makeService();

    await expect(service.getOrCreateStack(baseInput({ backendReady: false }))).rejects.toThrow(
      PulumiBackendNotBootstrappedError,
    );

    expect(createOrSelectStackMock).not.toHaveBeenCalled();
    expect(engine.resolve).not.toHaveBeenCalled();
  });

  it('should name the bucket in the error', async () => {
    const { service } = makeService();

    await expect(
      service.getOrCreateStack(baseInput({ stateBucket: 'my-missing-bucket', backendReady: false })),
    ).rejects.toThrow(/my-missing-bucket/);
  });

  it('should re-classify a missing-bucket-shaped SDK failure into PulumiBackendNotBootstrappedError as a backstop', async () => {
    const { service } = makeService();
    createOrSelectStackMock.mockRejectedValueOnce(
      new Error('unable to get metadata: NoSuchBucket: The specified bucket does not exist'),
    );

    await expect(service.getOrCreateStack(baseInput({ backendReady: true }))).rejects.toThrow(
      PulumiBackendNotBootstrappedError,
    );
  });

  it('should propagate an SDK failure unchanged when it does not look like a missing bucket', async () => {
    const { service } = makeService();
    createOrSelectStackMock.mockRejectedValueOnce(new Error('some unrelated CLI failure'));

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

    await service.getOrCreateStack(baseInput({ stackExists: false }));
    const [, firstOpts] = createOrSelectStackMock.mock.calls[0] as [unknown, { envVars: Record<string, string> }];
    const firstPassphrase = firstOpts.envVars['PULUMI_CONFIG_PASSPHRASE'];
    expect(firstPassphrase).toBeTruthy();
    expect(store.get('pulumi')?.passphrase).toBeDefined();
    // Confirms the store holds the *encrypted* form, not the plaintext used in envVars.
    expect(store.get('pulumi')?.passphrase).toBe(`enc-${firstPassphrase}`);

    // The stack now genuinely exists — a realistic caller would pass
    // stackExists: true from here on.
    await service.getOrCreateStack(baseInput({ stackExists: true }));
    const [, secondOpts] = createOrSelectStackMock.mock.calls[1] as [unknown, { envVars: Record<string, string> }];
    const secondPassphrase = secondOpts.envVars['PULUMI_CONFIG_PASSPHRASE'];

    expect(secondPassphrase).toBe(firstPassphrase);
  });

  it('should generate a passphrase with at least 256 bits of entropy (32+ raw bytes)', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput());

    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { envVars: Record<string, string> }];
    const passphrase = opts.envVars['PULUMI_CONFIG_PASSPHRASE'];
    // base64 of N bytes decodes back to N bytes.
    expect(Buffer.from(passphrase, 'base64').length).toBeGreaterThanOrEqual(32);
  });

  it('should throw PulumiPassphraseUnavailableError and write nothing when the keychain is unavailable for a brand-new stack', async () => {
    const safeStorage = new SafeStorageService();
    vi.spyOn(safeStorage, 'isAvailable').mockReturnValue(false);
    const store = new ElectronStoreService(safeStorage);
    const { service } = makeService({ safeStorage, store });

    await expect(service.getOrCreateStack(baseInput({ stackExists: false }))).rejects.toThrow(
      PulumiPassphraseUnavailableError,
    );

    expect(createOrSelectStackMock).not.toHaveBeenCalled();
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

  it('should throw PulumiPassphraseUnavailableError and never call createOrSelectStack when the keychain is currently unavailable', async () => {
    const safeStorage = makeAvailableSafeStorage(); // available while seeding
    const store = seedExistingPassphrase(safeStorage);
    const storedBefore = store.get('pulumi')?.passphrase;

    // Keychain goes unavailable for the actual operation.
    vi.spyOn(safeStorage, 'isAvailable').mockReturnValue(false);
    const { service } = makeService({ safeStorage, store });

    await expect(service.getOrCreateStack(baseInput({ stackExists: true }))).rejects.toThrow(
      PulumiPassphraseUnavailableError,
    );

    expect(createOrSelectStackMock).not.toHaveBeenCalled();
    // Never silently regenerated — the original ciphertext is untouched.
    expect(store.get('pulumi')?.passphrase).toBe(storedBefore);
  });

  it('should throw PulumiPassphraseUnavailableError and never call createOrSelectStack when the stored ciphertext cannot be decrypted', async () => {
    const safeStorage = makeAvailableSafeStorage();
    const store = seedExistingPassphrase(safeStorage);
    const storedBefore = store.get('pulumi')?.passphrase;

    // Corrupted/foreign ciphertext: safeStorage is available, but decrypting
    // this particular blob fails (e.g. encrypted on a different machine).
    vi.spyOn(safeStorage, 'decrypt').mockImplementation(() => {
      throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
    });
    const { service } = makeService({ safeStorage, store });

    await expect(service.getOrCreateStack(baseInput({ stackExists: true }))).rejects.toThrow(
      PulumiPassphraseUnavailableError,
    );

    expect(createOrSelectStackMock).not.toHaveBeenCalled();
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

    await expect(service.getOrCreateStack(baseInput({ stackExists: true }))).rejects.toThrow(
      PulumiPassphraseUnavailableError,
    );

    // The write path was never even attempted.
    expect(setSpy).not.toHaveBeenCalled();
    expect(store.get('pulumi')?.passphrase).toBe(originalCiphertext);
  });

  it('should throw PulumiPassphraseUnavailableError and never write when stackExists is true but no local passphrase was ever stored (reinstall / wiped userData / second machine)', async () => {
    // No seeding at all — nothing has ever been stored locally, but the
    // caller reports the stack already exists remotely (e.g. this is a
    // reinstall, or a second machine pointed at the same state bucket).
    const safeStorage = makeAvailableSafeStorage();
    const store = new ElectronStoreService(safeStorage);
    const setSpy = vi.spyOn(store, 'setPulumiPassphrase');
    const { service } = makeService({ safeStorage, store });

    await expect(service.getOrCreateStack(baseInput({ stackExists: true }))).rejects.toThrow(
      PulumiPassphraseUnavailableError,
    );

    expect(createOrSelectStackMock).not.toHaveBeenCalled();
    // Critically: no passphrase was silently generated and persisted for a
    // stack that already has real, different encrypted state remotely.
    expect(setSpy).not.toHaveBeenCalled();
    expect(store.get('pulumi')?.passphrase).toBeUndefined();
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — credentialEnvVars override extension point (Task 4.5)', () => {
  it('should merge credentialEnvVars into the engine environment', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput({ credentialEnvVars: { AWS_PROFILE: 'personal' } }));

    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { envVars: Record<string, string> }];
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

    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { envVars: Record<string, string> }];
    expect(opts.envVars['PULUMI_BACKEND_URL']).toBe('s3://my-bucket?region=us-west-2');
    expect(opts.envVars['PULUMI_CONFIG_PASSPHRASE']).not.toBe('attacker-supplied');
    expect(opts.envVars['AWS_REGION']).toBe('us-west-2');
  });

  it('should support clearing an inherited variable via an explicit empty string', async () => {
    const { service } = makeService();

    await service.getOrCreateStack(baseInput({ credentialEnvVars: { AWS_PROFILE: '' } }));

    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { envVars: Record<string, string> }];
    expect(opts.envVars['AWS_PROFILE']).toBe('');
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — wired to the real credential resolver (Task 4.5)', () => {
  it('should pass a named-profile selection all the way through into the final envVars, including the exclusivity clear', async () => {
    const safeStorage = makeAvailableSafeStorage();
    const store = new ElectronStoreService(safeStorage);
    store.set('aws', { region: 'us-west-2', profile: 'personal' });
    const { service } = makeService({ safeStorage, store });

    // This is the literal "wire the resolver's output into credentialEnvVars"
    // Task 4.5 asks for — resolveCredentialEnvVars is the real function a
    // future caller (Phase 7) will use, not a hand-built test fixture.
    await service.getOrCreateStack(baseInput({ credentialEnvVars: resolveCredentialEnvVars(store) }));

    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { envVars: Record<string, string> }];
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

    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { envVars: Record<string, string> }];
    expect(opts.envVars['AWS_ACCESS_KEY_ID']).toBe('AKID123');
    expect(opts.envVars['AWS_SECRET_ACCESS_KEY']).toBe('SECRET456');
    expect(opts.envVars['AWS_PROFILE']).toBe('');
    expect(opts.envVars['AWS_DEFAULT_PROFILE']).toBe('');
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — credential resolution is unconditional, not opt-in (fix round 1)', () => {
  /**
   * Regression tests for the gap the fix-round review found: prior to this
   * round, `resolveCredentialEnvVars` had no production call site at all —
   * every test (and every real future caller) had to remember to call it
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

    // No credentialEnvVars anywhere in this input — the literal shape of a
    // caller (e.g. a future Phase 7 PulumiService) that never learned about
    // the extension point at all.
    await service.getOrCreateStack(baseInput());

    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { envVars: Record<string, string> }];
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

    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { envVars: Record<string, string> }];
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
    expect(createOrSelectStackMock).not.toHaveBeenCalled();
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

describe('PulumiWorkspaceService.getOrCreateStack — onPhase forwarding (Task 4.6)', () => {
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
