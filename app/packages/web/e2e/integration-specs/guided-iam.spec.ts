import { existsSync, readFileSync } from 'node:fs';
import { mockClient } from 'aws-sdk-client-mock';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { IAMClient, CreateAccessKeyCommand, DeleteAccessKeyCommand } from '@aws-sdk/client-iam';
import { WizardController } from '@hyveon/desktop-main/dist/controllers/wizard.controller.js';
import { SafeStorageService } from '@hyveon/desktop-main/dist/services/SafeStorageService.js';
import { test, expect } from './index.js';

/**
 * Verifies the `add-one-click-aws-bootstrap` Group 6 wiring: all five
 * `wizard.guidedIam.*` IPC channels, dispatched through the real
 * `WizardController` instance the `AppModule` DI container resolves (not a
 * separately constructed `GuidedIamService`), reach real AWS SDK calls that
 * `aws-sdk-client-mock` intercepts.
 *
 * This harness runs in a plain Node process (`playwright.integration.config.ts`
 * has no `browser`/`electron` project — see that file), so
 * `process.versions['electron']` is unset here exactly as it is in a unit
 * test process. `aws-sdk-client-mock`'s `mockClient()` patches the
 * `STSClient`/`IAMClient` prototypes process-wide, and this repo's
 * integration config runs `fullyParallel: false` with `workers: 1`
 * (`playwright.integration.config.ts`), so every spec in this file shares one
 * process with no risk of a concurrent worker racing the same prototype
 * patch — the same reasoning `GuidedIamService.test.ts`/`wizard.controller.test.ts`
 * (Task 1's unit tests) already rely on for `mockClient`, just at a lower
 * tier here: the `ipc` fixture dispatches into a real, DI-resolved
 * `WizardController`, which delegates to `GuidedIamService`, instead of a
 * hand-constructed service instance.
 */
const stsMock = mockClient(STSClient);
const iamMock = mockClient(IAMClient);

/**
 * Simulates "the OS keychain is available" for the DI-resolved
 * `SafeStorageService` singleton `rotate()`/`revokeBootstrapKey()` share via
 * `ElectronStoreService` — required because this Playwright process has no
 * real Electron runtime, so `SafeStorageService.isAvailable()` is false here
 * exactly as it is in a unit test process (mirroring
 * `GuidedIamService.test.ts`'s `makeSafeStorage(false)` default), and
 * `GuidedIamService.rotate()` throws `SafeStorageUnavailableError` before
 * touching AWS whenever it is.
 *
 * Overriding `isAvailable` alone is not enough: `ElectronStoreService`'s
 * `setPastedCredentials`/`getPastedCredentials` (which `rotate()` and
 * `revokeBootstrapKey()`'s `resolveAwsCredentialSource` call respectively)
 * both gate their `SafeStorageService.encrypt`/`decrypt` calls on that same
 * `isAvailable()` result — flipping only `isAvailable` to `true` would make
 * them attempt to actually call Electron's `safeStorage.encryptString`/
 * `decryptString`, which crashes outside a real Electron process (`electron`
 * required from plain Node resolves to the binary's path string, not the
 * `{ safeStorage }` module shape). `encrypt`/`decrypt` are overridden to the
 * same pass-through behavior `SafeStorageService` already uses on its own
 * "Electron entirely absent" path (see that class's doc comment) — this
 * combination reproduces exactly the "keychain available, but plaintext
 * storage" state a real `rotate()` unit test targets, without touching any
 * protected member (all three are public methods on the DI-resolved
 * singleton, reassigned only for the lifetime of the fresh `AppModule` the
 * `ipc` fixture compiles per test — never shared across specs).
 */
function forceKeychainAvailable(safeStorage: { isAvailable(): boolean; encrypt(v: string): string; decrypt(v: string): string }): void {
  safeStorage.isAvailable = () => true;
  safeStorage.encrypt = (plaintext: string) => plaintext;
  safeStorage.decrypt = (ciphertext: string) => ciphertext;
}

test.beforeEach(() => {
  stsMock.reset();
  iamMock.reset();
});

test.describe('Guided IAM bootstrap — wizard.guidedIam.* channels', () => {
  test.describe('wizard.guidedIam.prepareTemplate', () => {
    test('should render iam-bootstrap.yaml to a real file on disk with both policy placeholders substituted', async ({ ipc }) => {
      const result = await ipc.dispatch(WizardController, 'prepareGuidedIamTemplate');

      expect(existsSync(result.path)).toBe(true);
      const rendered = readFileSync(result.path, 'utf-8');
      expect(rendered).not.toContain('__HYVEON_DEPLOY_ALL_POLICY_DOCUMENT__');
      expect(rendered).not.toContain('__HYVEON_SELF_ROTATE_POLICY_DOCUMENT__');
    });
  });

  test.describe('wizard.guidedIam.openConsole', () => {
    test('should return opened: false with the console URL as text when Electron is unavailable in this process', async ({ ipc }) => {
      // Sanity-check the assumption this test relies on rather than just
      // asserting it: this Playwright process has no Electron runtime, so
      // `GuidedIamService.readIsElectron()` (gated on
      // `process.versions['electron']`) is false and `openConsole()` takes
      // its documented "Electron unavailable" branch without ever calling
      // `shell.openExternal`.
      expect(process.versions['electron']).toBeUndefined();

      const result = await ipc.dispatch(WizardController, 'openGuidedIamConsole', { region: 'us-east-1' });

      expect(result).toEqual({
        opened: false,
        url: 'https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create',
      });
    });
  });

  test.describe('wizard.guidedIam.submitBootstrapKey', () => {
    test('should return the resolved account ID for a valid bootstrap key pair', async ({ ipc }) => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });

      const result = await ipc.dispatch(WizardController, 'submitGuidedIamBootstrapKey', {
        accessKeyId: 'AKIABOOTSTRAPTEST',
        secretAccessKey: 'test-bootstrap-secret-value',
        region: 'us-east-1',
      });

      expect(result).toEqual({ accountId: '123456789012' });
      // Proves the call reached the real, DI-resolved GuidedIamService's STS
      // client — not just that the controller returned a plausible value.
      const calls = stsMock.commandCalls(GetCallerIdentityCommand);
      expect(calls).toHaveLength(1);
    });
  });

  test.describe('wizard.guidedIam.rotate', () => {
    test('should reach status: complete after CreateAccessKey -> GetCallerIdentity -> DeleteAccessKey all succeed', async ({ ipc }) => {
      forceKeychainAvailable(ipc.get(SafeStorageService));
      iamMock.on(CreateAccessKeyCommand).resolves({
        AccessKey: {
          UserName: 'hyveon-bootstrap',
          AccessKeyId: 'AKIAROTATEDTEST',
          SecretAccessKey: 'rotated-secret-test-value',
          Status: 'Active',
        },
      });
      stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
      iamMock.on(DeleteAccessKeyCommand).resolves({});

      const result = await ipc.dispatch(WizardController, 'rotateGuidedIamKey', {
        bootstrapAccessKeyId: 'AKIABOOTSTRAPTEST',
        bootstrapSecretAccessKey: 'test-bootstrap-secret-value',
        region: 'us-east-1',
      });

      expect(result).toEqual({ status: 'complete' });
      expect(iamMock.commandCalls(CreateAccessKeyCommand)).toHaveLength(1);
      expect(stsMock.commandCalls(GetCallerIdentityCommand)).toHaveLength(1);
      const deleteCalls = iamMock.commandCalls(DeleteAccessKeyCommand);
      expect(deleteCalls).toHaveLength(1);
      // The delete targets the bootstrap key, not the newly minted one.
      expect(deleteCalls[0]!.args[0].input).toEqual({ AccessKeyId: 'AKIABOOTSTRAPTEST' });
    });
  });

  test.describe('wizard.guidedIam.revokeBootstrapKey', () => {
    test('should refuse without throwing when no active AWS credential source is configured', async ({ ipc }) => {
      const result = await ipc.dispatch(WizardController, 'revokeGuidedIamBootstrapKey', {
        bootstrapAccessKeyId: 'AKIABOOTSTRAPTEST',
        region: 'us-east-1',
      });

      expect(result.revoked).toBe(false);
      expect(result.message).toMatch(/No active AWS credential source/);
      expect(iamMock.commandCalls(DeleteAccessKeyCommand)).toHaveLength(0);
    });

    test('should revoke the still-live bootstrap key on the delete-failed manual-retry path', async ({ ipc }) => {
      // Drives rotate() into its delete-failed branch first (the one real
      // caller of revokeBootstrapKey documented on the service): the new key
      // is minted, verified, and activated, but the bootstrap key's own
      // DeleteAccessKey call fails once. revokeBootstrapKey is then the
      // manual retry for that leftover bootstrap key, using the
      // now-active rotated credentials.
      forceKeychainAvailable(ipc.get(SafeStorageService));
      iamMock.on(CreateAccessKeyCommand).resolves({
        AccessKey: {
          UserName: 'hyveon-bootstrap',
          AccessKeyId: 'AKIAROTATEDTEST2',
          SecretAccessKey: 'rotated-secret-test-value-2',
          Status: 'Active',
        },
      });
      stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
      const deleteError = new Error('User is not authorized to perform iam:DeleteAccessKey');
      deleteError.name = 'AccessDenied';
      iamMock.on(DeleteAccessKeyCommand).rejectsOnce(deleteError).resolves({});

      const rotateResult = await ipc.dispatch(WizardController, 'rotateGuidedIamKey', {
        bootstrapAccessKeyId: 'AKIABOOTSTRAPTEST2',
        bootstrapSecretAccessKey: 'test-bootstrap-secret-value-2',
        region: 'us-east-1',
      });
      expect(rotateResult.status).toBe('delete-failed');

      const revokeResult = await ipc.dispatch(WizardController, 'revokeGuidedIamBootstrapKey', {
        bootstrapAccessKeyId: 'AKIABOOTSTRAPTEST2',
        region: 'us-east-1',
      });

      expect(revokeResult).toEqual({ revoked: true });
      const deleteCalls = iamMock.commandCalls(DeleteAccessKeyCommand);
      expect(deleteCalls).toHaveLength(2);
      // Both the failed automatic delete (inside rotate()) and the
      // successful manual retry target the same bootstrap key ID.
      expect(deleteCalls[0]!.args[0].input).toEqual({ AccessKeyId: 'AKIABOOTSTRAPTEST2' });
      expect(deleteCalls[1]!.args[0].input).toEqual({ AccessKeyId: 'AKIABOOTSTRAPTEST2' });
    });
  });
});
