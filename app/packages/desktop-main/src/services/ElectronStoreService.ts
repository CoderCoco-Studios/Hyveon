import { randomUUID } from 'node:crypto';
import { hostname as osHostname, userInfo } from 'node:os';
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
 * A single outstanding record of "this installation caused the backend's DIY
 * lock to be taken" — Task 4.8's ownership-record mechanism, per the
 * `pulumi-engine-runtime` delta spec's "Stale backend lock recovery"
 * requirement: "The app MUST record the identity of every lock it causes to
 * be taken." Written via {@link ElectronStoreService.recordPulumiLockAttempt}
 * immediately before a `preview`/`up`/`destroy` invocation that could take the
 * lock, and cleared via {@link ElectronStoreService.clearPulumiLockAttempt}
 * once that operation completes *normally* — a record still present later is
 * evidence (not proof by itself; see `PulumiLockRecovery.classifyStackLockConflict`)
 * that this installation's own prior run may have orphaned the lock, e.g. via
 * a crash or the forceful-termination escalation path (Task 4.7).
 *
 * `username`/`hostname` are **not secret** — no encryption via
 * {@link SafeStorageService} is applied to this field, unlike
 * `pulumi.passphrase` above.
 */
export interface PulumiLockOwnershipRecord {
  /** Bare Pulumi stack name (see `PULUMI_STACK_NAME`) this attempt was made against. */
  stackName: string;
  /** ISO-8601 timestamp captured when this attempt was recorded, i.e. immediately before the SDK invocation. */
  startedAt: string;
  /**
   * `os.userInfo().username` of *this* process at the moment the attempt was
   * recorded — the same OS-level identity the `pulumi` CLI child process
   * (spawned directly from this Electron process, inheriting its OS session)
   * will report via Go's `user.Current().Username` in its own lock file, per
   * `pkg/backend/diy/lock.go`. This is the closest available proxy for "this
   * installation" — see `PulumiLockRecovery`'s file-level TSDoc for why a
   * tighter, run-specific identifier (e.g. the CLI child's own PID) is not
   * obtainable through the Automation API's public surface.
   */
  username: string;
  /** `os.hostname()` of this machine at the moment the attempt was recorded — see {@link username}'s doc comment. */
  hostname: string;
}

/**
 * Typed schema for the application's persistent electron-store.
 *
 * Secret fields (`aws.accessKeyId`, `aws.secretAccessKey`,
 * `creds.aws.<profileName>.accessKeyId`,
 * `creds.aws.<profileName>.secretAccessKey`, `pulumi.passphrase`) are stored
 * encrypted via {@link SafeStorageService} and must never be read or written
 * directly — always use {@link ElectronStoreService.getSecretAccessKeyId},
 * {@link ElectronStoreService.setSecretAccessKeyId},
 * {@link ElectronStoreService.getSecretAccessKey},
 * {@link ElectronStoreService.setSecretAccessKey},
 * {@link ElectronStoreService.getPastedCredentials},
 * {@link ElectronStoreService.setPastedCredentials},
 * {@link ElectronStoreService.getPulumiPassphrase}, and
 * {@link ElectronStoreService.setPulumiPassphrase}.
 */
export interface AppStoreSchema {
  wizardCompleted: boolean;
  /** Locked to `'aws'` for v1. */
  activeCloud: 'aws';
  /**
   * Gates `electron-updater` update checks (see `updater.ts`). Absent or
   * `false` means disabled — the default for v1, since unsigned builds would
   * fail Gatekeeper/SmartScreen regardless. No renderer/settings UI exposes
   * this yet; flipping it is a manual electron-store edit.
   */
  enableAutoUpdate?: boolean;
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
   *
   * `lockTable` no longer names a bootstrapped resource (task 5.1 removed
   * `ensureLockTable`) — it is kept only because the still-live
   * `terraform.init` call requires a non-empty `dynamodbTable` backend-config
   * value, rehydrated from this same field on Reconfigure. Task 10.3
   * (replacing the Terraform-init step) is where this field should finally
   * be dropped.
   */
  bootstrap?: {
    stateBucket: string;
    lockTable: string;
    configurationBucket: string;
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
  /**
   * Automation API secrets-passphrase storage (see `PulumiWorkspaceService`).
   * The passphrase is generated once, the first time a Pulumi stack is
   * created, and reused for the lifetime of that stack — a missing or
   * undecryptable entry for a stack that already exists must never be
   * silently replaced (a new passphrase cannot decrypt state encrypted with
   * the old one).
   */
  pulumi?: {
    /** Stored as an encrypted base64 blob — do not read this field directly. */
    passphrase?: string;
    /**
     * Outstanding lock-ownership records, keyed by a freshly-minted run id —
     * see {@link PulumiLockOwnershipRecord}'s doc comment and Task 4.8's
     * `PulumiLockRecovery` module. Not secret — stored in plaintext, unlike
     * `passphrase` above.
     */
    lockOwnership?: Record<string, PulumiLockOwnershipRecord>;
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
   * Read `pulumi.passphrase`, decrypting the stored blob via
   * {@link SafeStorageService}.
   *
   * @remarks
   * Callers that need to distinguish "never stored" from "stored but
   * undecryptable" (the `pulumi-engine-runtime` delta spec's "Missing
   * passphrase for an existing stack fails loudly" scenario) must check
   * presence via `get('pulumi')?.passphrase !== undefined` themselves
   * *before* calling this — like {@link decrypt}, this method can itself
   * throw (a corrupted/foreign ciphertext) rather than returning `undefined`.
   * `PulumiWorkspaceService` owns that distinction; this accessor only mirrors
   * {@link getSecretAccessKeyId}'s shape.
   *
   * @returns The decrypted passphrase, or `undefined` if never stored.
   */
  getPulumiPassphrase(): string | undefined {
    const pulumi = this.get('pulumi');
    if (pulumi?.passphrase === undefined) return undefined;
    return this.safeStorage.decrypt(pulumi.passphrase);
  }

  /**
   * Write `pulumi.passphrase`, encrypting the value via
   * {@link SafeStorageService} before storage. Merges with the existing
   * `pulumi` object so other fields are preserved.
   *
   * @remarks
   * Callers must check {@link SafeStorageService.isAvailable} themselves
   * before calling this for a *new* stack's passphrase — mirroring
   * `AwsProfileService.savePastedCredentials`'s "fail loudly before any
   * write" precedent, this method does not enforce that on its own (like
   * {@link setSecretAccessKeyId}, it transparently degrades to plaintext
   * storage outside Electron via {@link SafeStorageService.encrypt}, which is
   * fine for AWS keys' test/CI convenience but would be a silent security
   * regression for a passphrase if a caller relied on it instead of checking
   * availability itself).
   *
   * @param value - Plaintext passphrase to encrypt and store.
   */
  setPulumiPassphrase(value: string): void {
    const encrypted = this.safeStorage.encrypt(value);
    const current = this.get('pulumi') ?? {};
    this.set('pulumi', { ...current, passphrase: encrypted });
    logger.debug('ElectronStoreService: pulumi.passphrase written (encrypted)');
  }

  /**
   * Records that an infrastructure operation against `stackName` is about to
   * invoke the Pulumi engine — Task 4.8's ownership-record mechanism (see
   * {@link PulumiLockOwnershipRecord}'s doc comment). Must be called
   * immediately before the SDK invocation that could take the backend's DIY
   * lock, so a crash or the Task 4.7 forceful-termination escalation path
   * mid-operation still leaves a record this installation can later prove
   * against via `PulumiLockRecovery.classifyStackLockConflict`. Merges into
   * any existing `pulumi.lockOwnership` map rather than overwriting it.
   *
   * @returns The freshly-minted run id. Pass it to
   *   {@link clearPulumiLockAttempt} once the operation completes *normally*
   *   — never when it was forcefully terminated, since the entire point of
   *   this record is to survive exactly that case.
   */
  recordPulumiLockAttempt(stackName: string): string {
    const runId = randomUUID();
    const current = this.get('pulumi') ?? {};
    const record: PulumiLockOwnershipRecord = {
      stackName,
      startedAt: new Date().toISOString(),
      username: userInfo().username,
      hostname: osHostname(),
    };
    this.set('pulumi', { ...current, lockOwnership: { ...current.lockOwnership, [runId]: record } });
    return runId;
  }

  /**
   * Clears the ownership record for `runId` — call once an operation
   * completes normally (success, or a genuine non-abort failure): a normal
   * CLI exit releases its own backend lock via the DIY backend's own
   * `Unlock()` call, so the record is no longer needed as reclaim evidence.
   * Never call this when the operation was forcefully terminated (Task
   * 4.7) — see {@link recordPulumiLockAttempt}'s doc comment. A no-op if
   * `runId` is not present (already cleared, or never recorded).
   */
  clearPulumiLockAttempt(runId: string): void {
    const current = this.get('pulumi') ?? {};
    if (!current.lockOwnership || !(runId in current.lockOwnership)) return;
    const remaining = { ...current.lockOwnership };
    delete remaining[runId];
    this.set('pulumi', { ...current, lockOwnership: remaining });
  }

  /**
   * Lists every currently-outstanding lock-ownership record for `stackName`
   * — every attempt this installation has recorded that has not since been
   * cleared via {@link clearPulumiLockAttempt}. Used by
   * `PulumiLockRecovery.classifyStackLockConflict` to decide whether a
   * conflicting backend lock is a provable orphan of this installation's own
   * prior run.
   *
   * Returns each record together with its `runId` (unlike a bare
   * `PulumiLockOwnershipRecord`) so a caller that identifies which record(s)
   * it actually relied on as evidence can clear exactly those via
   * {@link clearPulumiLockAttempt} — `PulumiLockRecovery.classifyStackLockConflict`
   * uses this both to prune expired records and to consume the record it
   * reclaims against, so a single past reclaim can't stand as permanent,
   * reusable justification for reclaiming an unrelated future lock.
   */
  listPulumiLockAttempts(stackName: string): (PulumiLockOwnershipRecord & { runId: string })[] {
    const lockOwnership = this.get('pulumi')?.lockOwnership ?? {};
    return Object.entries(lockOwnership)
      .filter(([, record]) => record.stackName === stackName)
      .map(([runId, record]) => ({ runId, ...record }));
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
