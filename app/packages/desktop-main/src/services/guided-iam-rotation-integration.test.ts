/**
 * Regression test for the `add-one-click-aws-bootstrap` Group 5 plan's
 * "Task 5.4 scoping" claim (`docs/superpowers/plans/bootstrap-5-iam-gate.md`):
 * `GuidedIamService.rotate()` activates the rotated key as the store's
 * active credential source *before* returning `complete`, and
 * `IamCheckService.checkPermissions()` reads that same active source on
 * every call — so no new orchestration code is needed for a post-rotation
 * permission check to target the rotated key. This test drives both real
 * services against one shared, real `ElectronStoreService` to prove that
 * invariant end-to-end, rather than asserting it separately against two
 * independently-mocked halves.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { IAMClient, CreateAccessKeyCommand, DeleteAccessKeyCommand, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import { ElectronStoreService } from './ElectronStoreService.js';
import { SafeStorageService } from './SafeStorageService.js';
import { GuidedIamService, GUIDED_PROFILE_NAME } from './GuidedIamService.js';
import { IamCheckService } from './IamCheckService.js';

/** Typed stand-in for the AWS STS SDK client, shared by both services under test. */
const stsMock = mockClient(STSClient);

/** Typed stand-in for the AWS IAM SDK client, shared by both services under test. */
const iamMock = mockClient(IAMClient);

const REGION = 'us-west-2';

/**
 * The bootstrap key pair `rotate()` is given as input. `GuidedIamService`
 * never persists this pair to `ElectronStoreService` (it only ever flows
 * through explicit method parameters — see `GuidedIamService`'s class doc
 * comment), so it must never show up as the credential source
 * `IamCheckService.checkPermissions()` resolves after rotation completes.
 */
const BOOTSTRAP_ACCESS_KEY_ID = 'AKIABOOTSTRAPKEY000';
const BOOTSTRAP_SECRET = 'bootstrap-secret-never-persisted';

/** The freshly-minted key pair `rotate()` activates as the active credential source. */
const ROTATED_ACCESS_KEY_ID = 'AKIAROTATEDKEY111';
const ROTATED_SECRET = 'rotated-secret-value-222';

/**
 * Test-only subclass re-exposing `IamCheckService`'s protected client-factory
 * seams (mirroring `TestableIamCheckService` in `IamCheckService.test.ts`),
 * but also stashing the constructed client instances so the test can inspect
 * which credentials each one actually resolves to — `checkPermissions()`
 * itself never returns the clients it builds, so a caller of the public API
 * alone cannot distinguish "built with the rotated key" from "built with a
 * stale/wrong key" any other way.
 */
class InspectableIamCheckService extends IamCheckService {
  /** The `STSClient` most recently constructed by `checkPermissions()`. */
  lastStsClient?: STSClient;
  /** The `IAMClient` most recently constructed by `checkPermissions()`. */
  lastIamClient?: IAMClient;

  protected override createStsClient(): STSClient {
    const client = super.createStsClient();
    this.lastStsClient = client;
    return client;
  }

  protected override createIamClient(): IAMClient {
    const client = super.createIamClient();
    this.lastIamClient = client;
    return client;
  }
}

/**
 * Resolves an AWS SDK v3 client's `config.credentials` provider function to
 * the plain `{ accessKeyId, secretAccessKey }` it was constructed with.
 * Static credentials passed to a client constructor are normalized into a
 * memoized async provider rather than kept as the original plain object, so
 * reading `client.config.credentials` directly would only yield a function.
 */
async function resolveCredentials(client: STSClient | IAMClient): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  const resolved = await client.config.credentials();
  return { accessKeyId: resolved.accessKeyId, secretAccessKey: resolved.secretAccessKey };
}

beforeEach(() => {
  stsMock.reset();
  iamMock.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GuidedIamService.rotate() -> IamCheckService.checkPermissions() integration', () => {
  it('should build checkPermissions() clients from the rotated key (not the bootstrap key) and resolve origin: guided', async () => {
    // rotate() step 1: mint a new key pair using the bootstrap key.
    iamMock.on(CreateAccessKeyCommand).resolves({
      AccessKey: {
        UserName: 'hyveon-bootstrap',
        AccessKeyId: ROTATED_ACCESS_KEY_ID,
        SecretAccessKey: ROTATED_SECRET,
        Status: 'Active',
      },
    });
    // Serves both rotate() step 3's verification call and
    // checkPermissions()'s own getCallerArn() call — both must succeed
    // against whichever key each was actually built from for the flow to
    // reach the assertions below.
    stsMock.on(GetCallerIdentityCommand).resolves({
      Account: '123456789012',
      Arn: 'arn:aws:iam::123456789012:user/hyveon-deploy',
    });
    // rotate() step 5: revoke the bootstrap key.
    iamMock.on(DeleteAccessKeyCommand).resolves({});
    // checkPermissions()'s simulation: every action allowed.
    iamMock.on(SimulatePrincipalPolicyCommand).resolves({
      EvaluationResults: [{ EvalActionName: 'ecs:*', EvalDecision: 'allowed' }],
    });

    const safeStorage = new SafeStorageService();
    // rotate()'s upfront keychain gate (`SafeStorageService.isAvailable()`)
    // is bypassed for exactly this one call — every other `isAvailable()`
    // call in this test (inside `setPastedCredentials`'s `encrypt()` calls)
    // falls through to the real, non-Electron-environment implementation,
    // so credentials are still stored/read through the real encrypt/decrypt
    // degraded (identity) path, same as every other non-Electron test in
    // this suite.
    vi.spyOn(safeStorage, 'isAvailable').mockReturnValueOnce(true);
    const store = new ElectronStoreService(safeStorage);
    const guidedIamService = new GuidedIamService(store, safeStorage);
    const iamCheckService = new InspectableIamCheckService(store);

    const rotateResult = await guidedIamService.rotate({
      bootstrapAccessKeyId: BOOTSTRAP_ACCESS_KEY_ID,
      bootstrapSecretAccessKey: BOOTSTRAP_SECRET,
      region: REGION,
    });
    expect(rotateResult).toEqual({ status: 'complete' });
    // Sanity check on the shared store: rotation activated the rotated
    // key's profile as the active credential source before returning.
    expect(store.get('aws')).toEqual({ profile: GUIDED_PROFILE_NAME, region: REGION });

    const result = await iamCheckService.checkPermissions();

    expect(result.status).toBe('passed');
    expect(result.origin).toBe('guided');
    expect(result.blocking).toBe(false);

    // The core claim: checkPermissions()'s own STS and IAM clients were
    // built from the ROTATED key, not the bootstrap key — proving the
    // credential source flows through automatically with zero new
    // orchestration code between rotate() and checkPermissions().
    const stsCredentials = await resolveCredentials(iamCheckService.lastStsClient!);
    const iamCredentials = await resolveCredentials(iamCheckService.lastIamClient!);
    expect(stsCredentials).toEqual({ accessKeyId: ROTATED_ACCESS_KEY_ID, secretAccessKey: ROTATED_SECRET });
    expect(iamCredentials).toEqual({ accessKeyId: ROTATED_ACCESS_KEY_ID, secretAccessKey: ROTATED_SECRET });
    expect(stsCredentials.accessKeyId).not.toBe(BOOTSTRAP_ACCESS_KEY_ID);
    expect(iamCredentials.accessKeyId).not.toBe(BOOTSTRAP_ACCESS_KEY_ID);
  });
});
