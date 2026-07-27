/**
 * Unit tests for ElectronStoreService.
 *
 * `electron-store` is mocked at the module level so no real disk I/O or
 * Electron native modules are ever touched.  Protected methods
 * (`readIsElectron`, `createStore`) are stubbed via `vi.spyOn` on the
 * prototype before each Electron-path construction so the constructor takes
 * the right branch.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Store from 'electron-store';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('electron-store', () => {
  const MockStore = vi.fn().mockImplementation(() => ({
    get: vi.fn(),
    set: vi.fn(),
  }));
  return { default: MockStore };
});

import { ElectronStoreService, type AppStoreSchema } from './ElectronStoreService.js';
import { SafeStorageService } from './SafeStorageService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a `SafeStorageService` whose `encrypt` / `decrypt` methods are
 * identity functions by default (outside-Electron degraded path).
 */
function makeSafeStorage(): SafeStorageService {
  return new SafeStorageService();
}

/**
 * Builds a minimal mock `Store<AppStoreSchema>` compatible with what
 * `ElectronStoreService` calls on it.
 */
function makeMockStore(): Store<AppStoreSchema> {
  return {
    get: vi.fn(),
    set: vi.fn(),
  } as unknown as Store<AppStoreSchema>;
}

// ---------------------------------------------------------------------------
// Non-Electron path (Map fallback)
// ---------------------------------------------------------------------------

describe('ElectronStoreService — non-Electron path (Map fallback)', () => {
  let service: ElectronStoreService;
  let safeStorage: SafeStorageService;

  beforeEach(() => {
    safeStorage = makeSafeStorage();
    // process.versions['electron'] is not set in Vitest/Node, so the Map
    // fallback is used automatically — no spy needed.
    service = new ElectronStoreService(safeStorage);
    vi.clearAllMocks();
  });

  it('should use Map fallback when not running in Electron', () => {
    expect(service.isElectron()).toBe(false);
    expect(service.get('wizardCompleted')).toBeUndefined();
  });

  it('should store and retrieve a value in Map fallback', () => {
    service.set('wizardCompleted', true);

    expect(service.get('wizardCompleted')).toBe(true);
  });

  it('should store and retrieve a nested object in Map fallback', () => {
    const awsValue: AppStoreSchema['aws'] = { region: 'us-east-1', profile: 'default' };
    service.set('aws', awsValue);

    expect(service.get('aws')).toEqual(awsValue);
  });
});

// ---------------------------------------------------------------------------
// Electron path (mocked Store)
// ---------------------------------------------------------------------------

describe('ElectronStoreService — Electron path (mocked Store)', () => {
  let service: ElectronStoreService;
  let safeStorage: SafeStorageService;
  let mockStore: Store<AppStoreSchema>;

  beforeEach(() => {
    safeStorage = makeSafeStorage();
    mockStore = makeMockStore();

    // Stub prototype BEFORE construction so the constructor takes the Electron branch.
    vi.spyOn(
      ElectronStoreService.prototype as unknown as { readIsElectron(): boolean },
      'readIsElectron',
    ).mockReturnValue(true);
    vi.spyOn(
      ElectronStoreService.prototype as unknown as { createStore(): Store<AppStoreSchema> },
      'createStore',
    ).mockReturnValue(mockStore);

    service = new ElectronStoreService(safeStorage);
    vi.clearAllMocks();
  });

  it('should call store.get when running in Electron', () => {
    (mockStore.get as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const result = service.get('wizardCompleted');

    expect(mockStore.get).toHaveBeenCalledWith('wizardCompleted');
    expect(result).toBe(true);
  });

  it('should call store.set when running in Electron', () => {
    service.set('wizardCompleted', true);

    expect(mockStore.set).toHaveBeenCalledWith('wizardCompleted', true);
  });
});

// ---------------------------------------------------------------------------
// Secret field — setSecretAccessKeyId / getSecretAccessKeyId
// ---------------------------------------------------------------------------

describe('ElectronStoreService — setSecretAccessKeyId / getSecretAccessKeyId', () => {
  let service: ElectronStoreService;
  let safeStorage: SafeStorageService;

  beforeEach(() => {
    safeStorage = makeSafeStorage();
    service = new ElectronStoreService(safeStorage);
    vi.clearAllMocks();
  });

  it('should encrypt accessKeyId before storing', () => {
    vi.spyOn(safeStorage, 'encrypt').mockReturnValue('enc-key-id');

    service.setSecretAccessKeyId('AKID123');

    expect(safeStorage.encrypt).toHaveBeenCalledWith('AKID123');
    const stored = service.get('aws');
    expect(stored?.accessKeyId).toBe('enc-key-id');
  });

  it('should decrypt accessKeyId when reading', () => {
    service.set('aws', { region: 'us-east-1', profile: 'default', accessKeyId: 'enc-key-id' });
    vi.spyOn(safeStorage, 'decrypt').mockReturnValue('AKID123');

    const result = service.getSecretAccessKeyId();

    expect(safeStorage.decrypt).toHaveBeenCalledWith('enc-key-id');
    expect(result).toBe('AKID123');
  });

  it('should return undefined for accessKeyId when not stored', () => {
    expect(service.getSecretAccessKeyId()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Secret field — setSecretAccessKey / getSecretAccessKey
// ---------------------------------------------------------------------------

describe('ElectronStoreService — setSecretAccessKey / getSecretAccessKey', () => {
  let service: ElectronStoreService;
  let safeStorage: SafeStorageService;

  beforeEach(() => {
    safeStorage = makeSafeStorage();
    service = new ElectronStoreService(safeStorage);
    vi.clearAllMocks();
  });

  it('should encrypt secretAccessKey before storing', () => {
    vi.spyOn(safeStorage, 'encrypt').mockReturnValue('enc-secret-key');

    service.setSecretAccessKey('MY_SECRET');

    expect(safeStorage.encrypt).toHaveBeenCalledWith('MY_SECRET');
    const stored = service.get('aws');
    expect(stored?.secretAccessKey).toBe('enc-secret-key');
  });

  it('should decrypt secretAccessKey when reading', () => {
    service.set('aws', { region: 'us-east-1', profile: 'default', secretAccessKey: 'enc-secret-key' });
    vi.spyOn(safeStorage, 'decrypt').mockReturnValue('MY_SECRET');

    const result = service.getSecretAccessKey();

    expect(safeStorage.decrypt).toHaveBeenCalledWith('enc-secret-key');
    expect(result).toBe('MY_SECRET');
  });

  it('should return undefined for secretAccessKey when not stored', () => {
    expect(service.getSecretAccessKey()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe('ElectronStoreService — round-trip', () => {
  let service: ElectronStoreService;
  let safeStorage: SafeStorageService;

  beforeEach(() => {
    safeStorage = makeSafeStorage();
    service = new ElectronStoreService(safeStorage);
    vi.clearAllMocks();
  });

  it('should encrypt and decrypt accessKeyId in a round-trip', () => {
    vi.spyOn(safeStorage, 'encrypt').mockImplementation((plaintext: string) => `enc-${plaintext}`);
    vi.spyOn(safeStorage, 'decrypt').mockImplementation((ciphertext: string) =>
      ciphertext.startsWith('enc-') ? ciphertext.slice(4) : ciphertext,
    );

    service.setSecretAccessKeyId('AKID123');
    const result = service.getSecretAccessKeyId();

    expect(result).toBe('AKID123');
  });
});

// ---------------------------------------------------------------------------
// activeCloud — relaunch semantics
// ---------------------------------------------------------------------------

/**
 * Stateful stand-in for the mocked `electron-store` `Store`, backed by a
 * plain object so `get`/`set` actually persist across calls — needed to
 * prove a value survives being read by a *second* `ElectronStoreService`
 * instance pointed at the same underlying store, simulating an app relaunch
 * (a fresh service instance is constructed on every app boot; only the
 * on-disk store file — modeled here by this shared object — persists).
 */
function makeStatefulMockStore(): Store<AppStoreSchema> {
  const data: Partial<AppStoreSchema> = {};
  return {
    get: vi.fn().mockImplementation((key: keyof AppStoreSchema) => data[key]),
    set: vi.fn().mockImplementation((key: keyof AppStoreSchema, value: unknown) => {
      (data as Record<string, unknown>)[key] = value;
    }),
  } as unknown as Store<AppStoreSchema>;
}

describe('ElectronStoreService — activeCloud persists across a simulated relaunch', () => {
  it('should read back activeCloud from a new service instance pointed at the same store', () => {
    const sharedMockStore = makeStatefulMockStore();
    const safeStorage = makeSafeStorage();

    vi.spyOn(
      ElectronStoreService.prototype as unknown as { readIsElectron(): boolean },
      'readIsElectron',
    ).mockReturnValue(true);
    vi.spyOn(
      ElectronStoreService.prototype as unknown as { createStore(): Store<AppStoreSchema> },
      'createStore',
    ).mockReturnValue(sharedMockStore);

    // First "launch": a service instance writes the operator's cloud choice.
    const firstLaunch = new ElectronStoreService(safeStorage);
    firstLaunch.set('activeCloud', 'aws');

    // Second "launch": a brand-new instance, same underlying store — this is
    // exactly what happens when the app restarts and re-constructs its
    // providers from scratch.
    const secondLaunch = new ElectronStoreService(safeStorage);

    expect(secondLaunch.get('activeCloud')).toBe('aws');
  });
});

// ---------------------------------------------------------------------------
// Pasted credentials — getPastedCredentials / setPastedCredentials
// ---------------------------------------------------------------------------

describe('ElectronStoreService — getPastedCredentials / setPastedCredentials', () => {
  let service: ElectronStoreService;
  let safeStorage: SafeStorageService;

  beforeEach(() => {
    safeStorage = makeSafeStorage();
    service = new ElectronStoreService(safeStorage);
    vi.spyOn(safeStorage, 'encrypt').mockImplementation((plaintext: string) => `enc-${plaintext}`);
    vi.spyOn(safeStorage, 'decrypt').mockImplementation((ciphertext: string) =>
      ciphertext.startsWith('enc-') ? ciphertext.slice(4) : ciphertext,
    );
  });

  it('should encrypt accessKeyId/secretAccessKey before storing under creds.aws.<profileName>', () => {
    service.setPastedCredentials('hyveon-pasted', {
      accessKeyId: 'AKID123',
      secretAccessKey: 'SECRET456',
      region: 'us-east-1',
    });

    const stored = service.get('creds')?.aws['hyveon-pasted'];
    expect(stored).toEqual({ accessKeyId: 'enc-AKID123', secretAccessKey: 'enc-SECRET456', region: 'us-east-1' });
  });

  it('should decrypt accessKeyId/secretAccessKey when reading a pasted profile', () => {
    service.setPastedCredentials('hyveon-pasted', { accessKeyId: 'AKID123', secretAccessKey: 'SECRET456' });

    const result = service.getPastedCredentials('hyveon-pasted');

    expect(result).toEqual({ accessKeyId: 'AKID123', secretAccessKey: 'SECRET456', region: undefined });
  });

  it('should return undefined for a profile name that was never stored', () => {
    expect(service.getPastedCredentials('nonexistent')).toBeUndefined();
  });

  it('should preserve other profiles already stored under creds.aws when writing a new one', () => {
    service.setPastedCredentials('first', { accessKeyId: 'AKID_FIRST', secretAccessKey: 'SECRET_FIRST' });
    service.setPastedCredentials('second', { accessKeyId: 'AKID_SECOND', secretAccessKey: 'SECRET_SECOND' });

    expect(service.getPastedCredentials('first')).toEqual({
      accessKeyId: 'AKID_FIRST',
      secretAccessKey: 'SECRET_FIRST',
      region: undefined,
    });
    expect(service.getPastedCredentials('second')).toEqual({
      accessKeyId: 'AKID_SECOND',
      secretAccessKey: 'SECRET_SECOND',
      region: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// Integration-style: the persisted store file never contains plaintext key
// material. A minimal file-backed `Store` double is used instead of the real
// `electron-store` package (which requires an Electron process to resolve its
// default `userData` path) so this spec can write and re-read an actual file
// on disk while still running under plain Node/vitest.
// ---------------------------------------------------------------------------

/**
 * Minimal disk-backed stand-in for `electron-store`'s `get`/`set` surface,
 * persisting the whole schema object as JSON on every `set()` — enough to
 * let a test inspect the literal bytes written to disk, the way the real
 * library would.
 */
class FileBackedStore {
  constructor(private readonly filePath: string) {
    writeFileSync(this.filePath, '{}', 'utf-8');
  }

  get<K extends keyof AppStoreSchema>(key: K): AppStoreSchema[K] | undefined {
    const data = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<AppStoreSchema>;
    return data[key];
  }

  set<K extends keyof AppStoreSchema>(key: K, value: AppStoreSchema[K]): void {
    const data = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<AppStoreSchema>;
    data[key] = value;
    writeFileSync(this.filePath, JSON.stringify(data), 'utf-8');
  }
}

describe('ElectronStoreService — persisted file contains no plaintext key material', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hyveon-electron-store-'));
    filePath = join(tempDir, 'electron-store.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should never write the plaintext accessKeyId/secretAccessKey to the store file', () => {
    const safeStorage = makeSafeStorage();
    // A real (non-identity) transform is essential here: if encrypt() were a
    // no-op, the file WOULD legitimately contain the plaintext, and the
    // assertion below would pass for the wrong reason.
    vi.spyOn(safeStorage, 'isAvailable').mockReturnValue(true);
    vi.spyOn(safeStorage, 'encrypt').mockImplementation(
      (plaintext: string) => Buffer.from(plaintext).toString('base64'),
    );
    vi.spyOn(safeStorage, 'decrypt').mockImplementation(
      (ciphertext: string) => Buffer.from(ciphertext, 'base64').toString('utf-8'),
    );

    vi.spyOn(
      ElectronStoreService.prototype as unknown as { readIsElectron(): boolean },
      'readIsElectron',
    ).mockReturnValue(true);
    vi.spyOn(
      ElectronStoreService.prototype as unknown as { createStore(): Store<AppStoreSchema> },
      'createStore',
    ).mockReturnValue(new FileBackedStore(filePath) as unknown as Store<AppStoreSchema>);

    const service = new ElectronStoreService(safeStorage);
    const secretAccessKeyId = 'AKIASENSITIVEEXAMPLE';
    const secretAccessKey = 'super-secret-plaintext-value';

    service.setSecretAccessKeyId(secretAccessKeyId);
    service.setSecretAccessKey(secretAccessKey);
    service.setPastedCredentials('hyveon-pasted', {
      accessKeyId: secretAccessKeyId,
      secretAccessKey,
      region: 'us-east-1',
    });

    const rawFileContents = readFileSync(filePath, 'utf-8');
    expect(rawFileContents).not.toContain(secretAccessKeyId);
    expect(rawFileContents).not.toContain(secretAccessKey);
    // Sanity check the file isn't simply empty/unwritten.
    expect(rawFileContents).toContain('region');
  });
});
