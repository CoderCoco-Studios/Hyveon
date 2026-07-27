import { Injectable } from '@nestjs/common';
import type Store from 'electron-store';
import { logger } from '../logger.js';
import { SafeStorageService } from './SafeStorageService.js';

// electron-store@11 is ESM-only — require() would throw ERR_REQUIRE_ESM.
// Load via dynamic import, but only inside Electron; in plain-Node test
// environments process.versions.electron is undefined so this stays undefined
// and createStore() (which is only called inside Electron) is never reached.
const ElectronStoreModule = process.versions['electron']
  ? await import('electron-store')
  : undefined;

/**
 * A single pasted-credentials entry under `creds.aws.<profileName>`.
 * `accessKeyId`/`secretAccessKey` are encrypted base64 blobs — do not read
 * them directly; use {@link ElectronStoreService.getPastedCredentials} /
 * {@link ElectronStoreService.setPastedCredentials}.
 */
export interface PastedAwsCredentials {
  /** Stored as an encrypted base64 blob — do not read this field directly. */
  accessKeyId: string;
  /** Stored as an encrypted base64 blob — do not read this field directly. */
  secretAccessKey: string;
  region?: string;
}

/**
 * Typed schema for the application's persistent electron-store.
 *
 * Secret fields (`aws.accessKeyId`, `aws.secretAccessKey`,
 * `creds.aws.<profileName>.accessKeyId`,
 * `creds.aws.<profileName>.secretAccessKey`) are stored encrypted via
 * {@link SafeStorageService} and must never be read or written directly —
 * always use {@link ElectronStoreService.getSecretAccessKeyId},
 * {@link ElectronStoreService.setSecretAccessKeyId},
 * {@link ElectronStoreService.getSecretAccessKey},
 * {@link ElectronStoreService.setSecretAccessKey},
 * {@link ElectronStoreService.getPastedCredentials}, and
 * {@link ElectronStoreService.setPastedCredentials}.
 */
export interface AppStoreSchema {
  wizardCompleted: boolean;
  /** Locked to `'aws'` for v1. */
  activeCloud: 'aws';
  aws: {
    region?: string;
    profile?: string;
    /** Stored as an encrypted base64 blob — do not read this field directly. */
    accessKeyId?: string;
    /** Stored as an encrypted base64 blob — do not read this field directly. */
    secretAccessKey?: string;
  };
  /**
   * The bootstrap step's resource names, as last submitted (whether that
   * submission succeeded or is still `pending`/`failed` for a given
   * resource — this just records what the operator asked for). Names are
   * operator-editable, so without this the Settings "Reconfigure" flow
   * (#211) would have no way to rehydrate a non-default name and would run
   * `terraform init` against the wrong bucket/table.
   */
  bootstrap?: {
    stateBucket: string;
    lockTable: string;
    tfvarsBucket: string;
  };
  /**
   * Pasted-credentials profiles from the wizard's credentials step, keyed by
   * profile name (default `hyveon-pasted` — see `AwsProfileService`). Separate
   * from `aws` above, which holds the *selected* profile/region for the
   * "pick an existing profile" path.
   */
  creds: {
    aws: Record<string, PastedAwsCredentials>;
  };
}

/**
 * Wraps `electron-store` with a typed {@link AppStoreSchema} and provides
 * transparent encryption of secret fields via {@link SafeStorageService}.
 *
 * When running outside an Electron process (unit tests, CI) the service uses a
 * `Map<string, unknown>` as an in-memory backing store — the public API surface
 * is identical, but reads/writes do not persist across process restarts.
 *
 * Protected methods (`createStore`, `readIsElectron`) are extracted so tests
 * can stub them via `vi.spyOn` without importing native Electron modules.
 */
@Injectable()
export class ElectronStoreService {
  private readonly _store: Store<AppStoreSchema> | null;
  private readonly _map: Map<string, unknown> | null;

  constructor(private readonly safeStorage: SafeStorageService) {
    if (this.readIsElectron()) {
      this._store = this.createStore();
      this._map = null;
    } else {
      this._store = null;
      this._map = new Map();
    }
  }

  /**
   * Returns `true` when running inside an Electron process — i.e. the store is
   * backed by a real disk file in the user-data directory.
   */
  isElectron(): boolean {
    return this.readIsElectron();
  }

  /**
   * Read a top-level key from the store.
   *
   * @param key - One of the top-level keys defined in {@link AppStoreSchema}.
   * @returns The stored value, or `undefined` if the key has not been set.
   */
  get<K extends keyof AppStoreSchema>(key: K): AppStoreSchema[K] | undefined {
    if (this._store !== null) {
      return this._store.get(key) as AppStoreSchema[K] | undefined;
    }
    return this._map!.get(key) as AppStoreSchema[K] | undefined;
  }

  /**
   * Write a top-level key to the store.
   *
   * @param key - One of the top-level keys defined in {@link AppStoreSchema}.
   * @param value - The value to persist.
   */
  set<K extends keyof AppStoreSchema>(key: K, value: AppStoreSchema[K]): void {
    if (this._store !== null) {
      this._store.set(key, value);
    } else {
      this._map!.set(key, value);
    }
  }

  /**
   * Read `aws.accessKeyId`, decrypting the stored blob via
   * {@link SafeStorageService}.
   *
   * @returns The decrypted access key ID, or `undefined` if not stored.
   */
  getSecretAccessKeyId(): string | undefined {
    const aws = this.get('aws');
    if (aws?.accessKeyId === undefined) return undefined;
    return this.safeStorage.decrypt(aws.accessKeyId);
  }

  /**
   * Write `aws.accessKeyId`, encrypting the value via {@link SafeStorageService}
   * before storage.  Merges with the existing `aws` object so other fields are
   * preserved.
   *
   * @param value - Plaintext access key ID to encrypt and store.
   */
  setSecretAccessKeyId(value: string): void {
    const encrypted = this.safeStorage.encrypt(value);
    const current = this.get('aws') ?? {};
    this.set('aws', { ...current, accessKeyId: encrypted });
    logger.debug('ElectronStoreService: aws.accessKeyId written (encrypted)');
  }

  /**
   * Read `aws.secretAccessKey`, decrypting the stored blob via
   * {@link SafeStorageService}.
   *
   * @returns The decrypted secret access key, or `undefined` if not stored.
   */
  getSecretAccessKey(): string | undefined {
    const aws = this.get('aws');
    if (aws?.secretAccessKey === undefined) return undefined;
    return this.safeStorage.decrypt(aws.secretAccessKey);
  }

  /**
   * Write `aws.secretAccessKey`, encrypting the value via
   * {@link SafeStorageService} before storage.  Merges with the existing `aws`
   * object so other fields are preserved.
   *
   * @param value - Plaintext secret access key to encrypt and store.
   */
  setSecretAccessKey(value: string): void {
    const encrypted = this.safeStorage.encrypt(value);
    const current = this.get('aws') ?? {};
    this.set('aws', { ...current, secretAccessKey: encrypted });
    logger.debug('ElectronStoreService: aws.secretAccessKey written (encrypted)');
  }

  /**
   * Read a pasted-credentials profile from `creds.aws.<profileName>`,
   * decrypting `accessKeyId`/`secretAccessKey` via {@link SafeStorageService}.
   *
   * @remarks
   * Decrypted values must only ever be consumed inside main-process SDK
   * client factories (e.g. `CloudProviderModule`'s `useFactory` providers) —
   * never returned over IPC to the renderer. Callers over IPC (see
   * `WizardController.saveCredentials`) must not echo this method's return
   * value back to the caller.
   *
   * @param profileName - The pasted-profile name to read.
   * @returns The decrypted credentials, or `undefined` if the profile isn't stored.
   */
  getPastedCredentials(profileName: string): { accessKeyId: string; secretAccessKey: string; region?: string } | undefined {
    const entry = this.get('creds')?.aws?.[profileName];
    if (entry === undefined) return undefined;
    return {
      accessKeyId: this.safeStorage.decrypt(entry.accessKeyId),
      secretAccessKey: this.safeStorage.decrypt(entry.secretAccessKey),
      region: entry.region,
    };
  }

  /**
   * Write a pasted-credentials profile to `creds.aws.<profileName>`,
   * encrypting `accessKeyId`/`secretAccessKey` via {@link SafeStorageService}
   * before storage. Merges with any existing `creds.aws` map so other
   * profiles are preserved.
   *
   * @param profileName - The pasted-profile name to write (default naming —
   *   e.g. `hyveon-pasted` — is the caller's responsibility; see `AwsProfileService`).
   * @param value - Plaintext credentials to encrypt and store.
   */
  setPastedCredentials(profileName: string, value: { accessKeyId: string; secretAccessKey: string; region?: string }): void {
    const currentCreds = this.get('creds') ?? { aws: {} };
    this.set('creds', {
      ...currentCreds,
      aws: {
        ...currentCreds.aws,
        [profileName]: {
          accessKeyId: this.safeStorage.encrypt(value.accessKeyId),
          secretAccessKey: this.safeStorage.encrypt(value.secretAccessKey),
          region: value.region,
        },
      },
    });
    logger.debug(`ElectronStoreService: creds.aws.${profileName} written (encrypted)`);
  }

  /**
   * Constructs the underlying `electron-store` instance.  Called once in the
   * constructor when running inside Electron. Extracted as a protected method
   * so tests can stub it via `vi.spyOn` to avoid touching the real user-data
   * directory.
   */
  protected createStore(): Store<AppStoreSchema> {
    // ElectronStoreModule is always defined here: the constructor calls
    // createStore() only when readIsElectron() is true.
    const StoreClass = ElectronStoreModule!.default;
    return new StoreClass({ name: 'electron-store' });
  }

  /**
   * Returns `true` when `process.versions['electron']` is set, indicating this
   * process is running inside Electron.  Extracted as a protected method so
   * tests can stub it via `vi.spyOn` without mutating `process.versions`.
   */
  protected readIsElectron(): boolean {
    return !!process.versions['electron'];
  }
}
