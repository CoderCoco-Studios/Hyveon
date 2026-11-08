import { Injectable } from '@nestjs/common';
import { createRequire } from 'module';
import { logger } from '../logger.js';
import { errMessage } from '@hyveon/shared';

const _require = createRequire(import.meta.url);

/**
 * Thrown when a secret must be encrypted or saved but the OS keychain (via `SafeStorageService`) is unavailable inside
 * Electron. Secrets are never persisted in plaintext there, so callers must surface the error and refuse to save
 * rather than degrade (outside Electron, `encrypt()` still passes plaintext through for tests and CI).
 */
export class SafeStorageUnavailableError extends Error {
  constructor() {
    super(
      'Cannot save the value: the OS keychain (safeStorage) is unavailable. ' +
        'Secrets are never stored in plaintext — for AWS access, pick an existing AWS CLI profile instead.',
    );
    this.name = 'SafeStorageUnavailableError';
  }
}

/**
 * Wraps Electron's `safeStorage` API for OS-keychain-backed encryption of
 * sensitive strings (e.g. API tokens, secrets).
 *
 * Outside an Electron process (unit tests, plain Node CI) the service degrades gracefully: `encrypt()` returns the
 * plaintext unchanged and `decrypt()` returns the input unchanged, so callers need no environment branching of their
 * own. Inside Electron with a locked or otherwise unavailable OS keychain both throw rather than read or write a
 * secret in the clear.
 *
 * All four Electron-touching operations are extracted into `protected` methods
 * (`readIsElectron`, `readIsAvailable`, `encryptString`, `decryptString`) so
 * tests can stub them via `vi.spyOn` without importing the native `electron`
 * module.
 */
@Injectable()
export class SafeStorageService {
  // @spec APP-WIZARD-CUSTODY-006
  /**
   * Returns `true` when encryption is available — i.e. the service is running
   * inside an Electron process **and** the OS keychain (Keychain, libsecret,
   * DPAPI) is unlocked and accessible.
   */
  isAvailable(): boolean {
    if (!this.readIsElectron()) return false;
    return this.readIsAvailable();
  }

  // @spec APP-WIZARD-CREDS-005, APP-WIZARD-CUSTODY-007
  /**
   * Encrypt `plaintext` using Electron's `safeStorage.encryptString()` and
   * return the result as a base64-encoded string suitable for storage.
   *
   * Outside an Electron process the plaintext is returned unchanged. Inside Electron with the OS keychain
   * locked/unavailable it throws, because a plaintext value written then could never be read back by {@link decrypt}
   * and would leave a rotation with no usable key.
   *
   * @param plaintext - The string to encrypt.
   * @returns Base64-encoded ciphertext, or the original `plaintext` outside Electron.
   * @throws SafeStorageUnavailableError if the keychain is unavailable inside Electron.
   */
  encrypt(plaintext: string): string {
    const electron = this.readIsElectron();
    const available = electron && this.readIsAvailable();
    logger.debug('SafeStorageService.encrypt: encrypting value', { available });
    if (!electron) {
      logger.warn('SafeStorageService: not running inside Electron — returning plaintext unchanged');
      return plaintext;
    }
    if (!available) {
      logger.warn('SafeStorageService.encrypt: OS keychain unavailable — refusing to store the value');
      throw new SafeStorageUnavailableError();
    }
    try {
      const buf = this.encryptString(plaintext);
      return buf.toString('base64');
    } catch (err) {
      const message = errMessage(err);
      logger.error('SafeStorageService.encrypt: safeStorage.encryptString failed', { error: message });
      throw new Error(`Failed to encrypt value via the OS keychain: ${message}`);
    }
  }

  // @spec APP-WIZARD-CREDS-005, APP-WIZARD-CUSTODY-007
  /**
   * Decrypt a base64-encoded ciphertext produced by {@link encrypt} back to
   * its original plaintext using Electron's `safeStorage.decryptString()`.
   *
   * Outside an Electron process the input is returned unchanged (on the
   * assumption it was stored as plaintext by the degraded `encrypt()` path).
   * Inside Electron with the OS keychain unavailable it throws, because the
   * stored value is most likely ciphertext and returning it would hand base64
   * noise to callers as a secret.
   *
   * @param ciphertext - Base64-encoded encrypted string, or raw plaintext when
   *   {@link encrypt} produced it outside an Electron process.
   * @returns Decrypted plaintext, or the original `ciphertext` outside Electron.
   * @throws Error if the keychain is unavailable inside Electron, or native decryption fails.
   */
  decrypt(ciphertext: string): string {
    const electron = this.readIsElectron();
    const available = electron && this.readIsAvailable();
    logger.debug('SafeStorageService.decrypt: decrypting value', { available });
    if (!electron) {
      return ciphertext;
    }
    if (!available) {
      logger.warn('SafeStorageService.decrypt: OS keychain unavailable — refusing to return the stored value');
      throw new Error('Cannot decrypt the stored value: the OS keychain (safeStorage) is unavailable.');
    }
    const buf = Buffer.from(ciphertext, 'base64');
    try {
      return this.decryptString(buf);
    } catch (err) {
      const message = errMessage(err);
      logger.error('SafeStorageService.decrypt: safeStorage.decryptString failed', { error: message });
      throw new Error(`Failed to decrypt value via the OS keychain: ${message}`);
    }
  }

  /**
   * Returns `true` when `process.versions['electron']` is set, indicating the
   * service is running inside an Electron process. Extracted as a protected
   * method so tests can stub it via `vi.spyOn` without touching
   * `process.versions` directly.
   */
  protected readIsElectron(): boolean {
    return !!process.versions['electron'];
  }

  /**
   * Calls `safeStorage.isEncryptionAvailable()` and returns its result.
   * Only called after `readIsElectron()` returns `true`. Extracted as a
   * protected method so tests can stub it via `vi.spyOn`.
   */
  protected readIsAvailable(): boolean {
    const { safeStorage } = _require('electron') as {
      safeStorage: { isEncryptionAvailable(): boolean };
    };
    return safeStorage.isEncryptionAvailable();
  }

  /**
   * Calls `safeStorage.encryptString(plaintext)` and returns the resulting
   * `Buffer`. Only called after `readIsElectron()` returns `true`. Extracted
   * as a protected method so tests can stub it via `vi.spyOn`.
   *
   * @param plaintext - The string to encrypt.
   * @returns Raw encrypted bytes as a `Buffer`.
   */
  protected encryptString(plaintext: string): Buffer {
    const { safeStorage } = _require('electron') as {
      safeStorage: { encryptString(plaintext: string): Buffer };
    };
    return safeStorage.encryptString(plaintext);
  }

  /**
   * Calls `safeStorage.decryptString(buf)` and returns the decrypted string.
   * Only called after `readIsElectron()` returns `true`. Extracted as a
   * protected method so tests can stub it via `vi.spyOn`.
   *
   * @param buf - Raw encrypted bytes previously produced by `encryptString`.
   * @returns Decrypted plaintext string.
   */
  protected decryptString(buf: Buffer): string {
    const { safeStorage } = _require('electron') as {
      safeStorage: { decryptString(buf: Buffer): string };
    };
    return safeStorage.decryptString(buf);
  }
}
