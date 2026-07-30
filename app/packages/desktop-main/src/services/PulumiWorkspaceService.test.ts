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

const { createOrSelectStackMock, mkdirSyncMock } = vi.hoisted(() => ({
  createOrSelectStackMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
}));

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: { createOrSelectStack: createOrSelectStackMock },
}));

vi.mock('node:fs', () => ({ mkdirSync: mkdirSyncMock }));

import type { PulumiFn, Stack } from '@pulumi/pulumi/automation/index.js';
import {
  PulumiWorkspaceService,
  PulumiBackendNotBootstrappedError,
  PulumiPassphraseUnavailableError,
  PULUMI_STACK_NAME,
  PULUMI_PROJECT_NAME,
} from './PulumiWorkspaceService.js';
import type { PulumiEngineService } from './PulumiEngineService.js';
import { SafeStorageService } from './SafeStorageService.js';
import { ElectronStoreService } from './ElectronStoreService.js';

/** Minimal `PulumiCommand`-shaped object the mocked SDK is given. */
const FAKE_COMMAND = { command: '/fake/userData/pulumi/versions/3.255.0/bin/pulumi', version: null };

/** Fake `Stack` the mocked `createOrSelectStack` resolves with. */
const FAKE_STACK = { name: PULUMI_STACK_NAME } as unknown as Stack;

/** No-op inline program — never actually invoked, since the SDK call is mocked. */
const FAKE_PROGRAM: PulumiFn = async () => ({});

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
 */
function makeService(opts?: {
  engine?: PulumiEngineService;
  safeStorage?: SafeStorageService;
  store?: ElectronStoreService;
  userDataPath?: string | null;
}) {
  const safeStorage = opts?.safeStorage ?? makeAvailableSafeStorage();
  const store = opts?.store ?? new ElectronStoreService(safeStorage);
  const engine = opts?.engine ?? stubEngine();
  const service = new TestablePulumiWorkspaceService(engine, safeStorage, store);
  vi.spyOn(service, 'resolveUserDataPath').mockReturnValue(opts?.userDataPath ?? '/fake/userData');
  return { service, engine, safeStorage, store };
}

const WORKSPACE_ROOT = '/fake/userData/pulumi-workspace';
const PULUMI_HOME_DIR = join(WORKSPACE_ROOT, 'home');
const WORK_DIR = join(WORKSPACE_ROOT, 'workspace', PULUMI_STACK_NAME);

beforeEach(() => {
  createOrSelectStackMock.mockReset();
  mkdirSyncMock.mockReset();
  createOrSelectStackMock.mockResolvedValue(FAKE_STACK);
});

describe('PulumiWorkspaceService.getOrCreateStack — workDir/pulumiHome stability', () => {
  it('should use a stable pulumiHome/workDir under userData, not a tmpdir', async () => {
    const { service } = makeService();

    await service.getOrCreateStack({ program: FAKE_PROGRAM, stateBucket: 'my-bucket', backendReady: true });

    expect(createOrSelectStackMock).toHaveBeenCalledOnce();
    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { pulumiHome: string; workDir: string }];
    expect(opts.pulumiHome).toBe(PULUMI_HOME_DIR);
    expect(opts.workDir).toBe(WORK_DIR);
    expect(opts.pulumiHome).not.toContain('tmp');
    expect(opts.workDir).not.toContain('tmp');
  });

  it('should reuse the exact same pulumiHome/workDir across repeated operations, not grow', async () => {
    const { service } = makeService();

    await service.getOrCreateStack({ program: FAKE_PROGRAM, stateBucket: 'my-bucket', backendReady: true });
    await service.getOrCreateStack({ program: FAKE_PROGRAM, stateBucket: 'my-bucket', backendReady: true });
    await service.getOrCreateStack({ program: FAKE_PROGRAM, stateBucket: 'my-bucket', backendReady: true });

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

    await service.getOrCreateStack({ program: FAKE_PROGRAM, stateBucket: 'my-bucket', backendReady: true });

    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { pulumiHome: string }];
    expect(opts.pulumiHome).not.toBe('/fake/userData/pulumi');
    expect(opts.pulumiHome.startsWith('/fake/userData/pulumi/versions')).toBe(false);
  });

  it('should create pulumiHome/workDir via mkdirSync with recursive: true', async () => {
    const { service } = makeService();

    await service.getOrCreateStack({ program: FAKE_PROGRAM, stateBucket: 'my-bucket', backendReady: true });

    expect(mkdirSyncMock).toHaveBeenCalledWith(PULUMI_HOME_DIR, { recursive: true });
    expect(mkdirSyncMock).toHaveBeenCalledWith(WORK_DIR, { recursive: true });
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — bare stack name', () => {
  it('should pass the bare stack name and project name, never an organization/-qualified name', async () => {
    const { service } = makeService();

    await service.getOrCreateStack({ program: FAKE_PROGRAM, stateBucket: 'my-bucket', backendReady: true });

    const [args] = createOrSelectStackMock.mock.calls[0] as [{ stackName: string; projectName: string }];
    expect(args.stackName).toBe(PULUMI_STACK_NAME);
    expect(args.projectName).toBe(PULUMI_PROJECT_NAME);
    expect(args.stackName).not.toContain('/');
    expect(args.stackName).not.toContain('organization');
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — PULUMI_BACKEND_URL', () => {
  it('should build the backend URL as s3://<stateBucket>', async () => {
    const { service } = makeService();

    await service.getOrCreateStack({ program: FAKE_PROGRAM, stateBucket: 'hyveon-state-abc123', backendReady: true });

    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { envVars: Record<string, string> }];
    expect(opts.envVars['PULUMI_BACKEND_URL']).toBe('s3://hyveon-state-abc123');
  });

  it('should use the passphrase secrets provider', async () => {
    const { service } = makeService();

    await service.getOrCreateStack({ program: FAKE_PROGRAM, stateBucket: 'my-bucket', backendReady: true });

    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { secretsProvider: string }];
    expect(opts.secretsProvider).toBe('passphrase');
  });

  it('should source pulumiCommand from PulumiEngineService.resolve(), never PATH', async () => {
    const { service, engine } = makeService();

    await service.getOrCreateStack({ program: FAKE_PROGRAM, stateBucket: 'my-bucket', backendReady: true });

    expect(engine.resolve).toHaveBeenCalledOnce();
    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { pulumiCommand: unknown }];
    expect(opts.pulumiCommand).toBe(FAKE_COMMAND);
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — backend-not-bootstrapped', () => {
  it('should throw PulumiBackendNotBootstrappedError without touching Pulumi when backendReady is false', async () => {
    const { service, engine } = makeService();

    await expect(
      service.getOrCreateStack({ program: FAKE_PROGRAM, stateBucket: 'my-bucket', backendReady: false }),
    ).rejects.toThrow(PulumiBackendNotBootstrappedError);

    expect(createOrSelectStackMock).not.toHaveBeenCalled();
    expect(engine.resolve).not.toHaveBeenCalled();
  });

  it('should name the bucket in the error', async () => {
    const { service } = makeService();

    await expect(
      service.getOrCreateStack({ program: FAKE_PROGRAM, stateBucket: 'my-missing-bucket', backendReady: false }),
    ).rejects.toThrow(/my-missing-bucket/);
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — passphrase generated once and reused', () => {
  it('should generate and store a passphrase on first use, then reuse the identical value on later calls', async () => {
    const { service, store } = makeService();

    await service.getOrCreateStack({ program: FAKE_PROGRAM, stateBucket: 'my-bucket', backendReady: true });
    const [, firstOpts] = createOrSelectStackMock.mock.calls[0] as [unknown, { envVars: Record<string, string> }];
    const firstPassphrase = firstOpts.envVars['PULUMI_CONFIG_PASSPHRASE'];
    expect(firstPassphrase).toBeTruthy();
    expect(store.get('pulumi')?.passphrase).toBeDefined();
    // Confirms the store holds the *encrypted* form, not the plaintext used in envVars.
    expect(store.get('pulumi')?.passphrase).toBe(`enc-${firstPassphrase}`);

    await service.getOrCreateStack({ program: FAKE_PROGRAM, stateBucket: 'my-bucket', backendReady: true });
    const [, secondOpts] = createOrSelectStackMock.mock.calls[1] as [unknown, { envVars: Record<string, string> }];
    const secondPassphrase = secondOpts.envVars['PULUMI_CONFIG_PASSPHRASE'];

    expect(secondPassphrase).toBe(firstPassphrase);
  });

  it('should generate a passphrase with at least 256 bits of entropy (32+ raw bytes)', async () => {
    const { service } = makeService();

    await service.getOrCreateStack({ program: FAKE_PROGRAM, stateBucket: 'my-bucket', backendReady: true });

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

    await expect(
      service.getOrCreateStack({ program: FAKE_PROGRAM, stateBucket: 'my-bucket', backendReady: true }),
    ).rejects.toThrow(PulumiPassphraseUnavailableError);

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

    await expect(
      service.getOrCreateStack({ program: FAKE_PROGRAM, stateBucket: 'my-bucket', backendReady: true }),
    ).rejects.toThrow(PulumiPassphraseUnavailableError);

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

    await expect(
      service.getOrCreateStack({ program: FAKE_PROGRAM, stateBucket: 'my-bucket', backendReady: true }),
    ).rejects.toThrow(PulumiPassphraseUnavailableError);

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

    await expect(
      service.getOrCreateStack({ program: FAKE_PROGRAM, stateBucket: 'my-bucket', backendReady: true }),
    ).rejects.toThrow(PulumiPassphraseUnavailableError);

    // The write path was never even attempted.
    expect(setSpy).not.toHaveBeenCalled();
    expect(store.get('pulumi')?.passphrase).toBe(originalCiphertext);
  });
});

describe('PulumiWorkspaceService.getOrCreateStack — credentialEnvVars extension point (Task 4.5)', () => {
  it('should merge credentialEnvVars into the engine environment', async () => {
    const { service } = makeService();

    await service.getOrCreateStack({
      program: FAKE_PROGRAM,
      stateBucket: 'my-bucket',
      backendReady: true,
      credentialEnvVars: { AWS_PROFILE: 'personal' },
    });

    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { envVars: Record<string, string> }];
    expect(opts.envVars['AWS_PROFILE']).toBe('personal');
  });

  it('should never let credentialEnvVars override the backend URL or passphrase this seam owns', async () => {
    const { service } = makeService();

    await service.getOrCreateStack({
      program: FAKE_PROGRAM,
      stateBucket: 'my-bucket',
      backendReady: true,
      credentialEnvVars: {
        PULUMI_BACKEND_URL: 'file:///attacker-controlled',
        PULUMI_CONFIG_PASSPHRASE: 'attacker-supplied',
      },
    });

    const [, opts] = createOrSelectStackMock.mock.calls[0] as [unknown, { envVars: Record<string, string> }];
    expect(opts.envVars['PULUMI_BACKEND_URL']).toBe('s3://my-bucket');
    expect(opts.envVars['PULUMI_CONFIG_PASSPHRASE']).not.toBe('attacker-supplied');
  });
});
