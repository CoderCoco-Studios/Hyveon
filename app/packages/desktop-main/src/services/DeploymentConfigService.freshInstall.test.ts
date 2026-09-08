/**
 * End-to-end proof that `BootstrapService.ensureDeploymentConfig` creates
 * the initial `deployment-config.json` object: every `DeploymentConfigService`
 * write path (`writeConfig`, shared by `addGameServer`/`updateGameServer`/
 * `removeGameServer`, and `updateTopLevelSettings`) reads the document
 * before writing (`fetchRawConfig`), and that read throws a plain `Error`
 * when the object doesn't exist — so a fresh install must seed it before the
 * dashboard's Settings save or add-a-game flows can work.
 *
 * Unlike `DeploymentConfigService.write.test.ts`/`DeploymentConfigService.s3.test.ts` (which
 * either stub `RemoteFileStore` directly or seed a document up front), this
 * spec drives the REAL sequence end to end against a single shared S3
 * double:
 *
 *  1. `BootstrapService` and a real `AwsRemoteFileStore` are both backed by
 *     the SAME `aws-sdk-client-mock` `S3Client` interceptor — mirrors
 *     `DeploymentConfigService.s3.test.ts`'s "exercise the real `AwsRemoteFileStore`"
 *     approach, extended to also cover `BootstrapService`'s raw-SDK seed
 *     path against the identical in-memory bucket.
 *  2. The bucket starts with NO `deployment-config.json` object — `getRawConfig()`
 *     is asserted to reject, proving the bug's precondition is genuinely
 *     reproduced, not assumed.
 *  3. `BootstrapService.ensureDeploymentConfig()` runs (the fix).
 *  4. `DeploymentConfigService.updateTopLevelSettings()` (a Settings save setting a
 *     real `hostedZoneName`) and `DeploymentConfigService.addGameServer()` (the Games
 *     UI's write path) are called against the SAME store and now succeed.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- test-only: exercises the real AwsRemoteFileStore/BootstrapService against a mocked S3Client (see file header).
import { S3Client, GetObjectCommand, HeadObjectCommand, NoSuchKey, PutObjectCommand } from '@aws-sdk/client-s3';
import { AwsRemoteFileStore } from '@hyveon/cloud-aws';
import { BootstrapService } from './BootstrapService.js';
import { DeploymentConfigService } from './DeploymentConfigService.js';
import type { ConfigService } from './ConfigService.js';
import type { ElectronStoreService } from './ElectronStoreService.js';
import { configServiceStub } from '../testing/config-service.fixture.js';

const s3Mock = mockClient(S3Client);

/** Build an `ElectronStoreService` stub whose `get('aws')` resolves to the given choice — mirrors `BootstrapService.test.ts`'s equivalent helper. */
function makeStore(aws: { profile?: string; region?: string } | undefined): ElectronStoreService {
  return {
    get: (key: string) => (key === 'aws' ? aws : undefined),
    getPastedCredentials: () => undefined,
  } as Partial<ElectronStoreService> as ElectronStoreService;
}

/** Builds a `ConfigService` stub exposing just the methods `DeploymentConfigService` reads. */
function makeConfig(bucket: string): ConfigService {
  return {
    ...configServiceStub(),
    getConfigurationBucket: () => bucket,
    readEnvConfigCacheTtlMs: () => 30000,
  } as ConfigService;
}

/** Builds a fake S3 `Body` stream whose `transformToByteArray()` resolves to the given bytes. */
function fakeBody(bytes: Uint8Array): { transformToByteArray: () => Promise<Uint8Array> } {
  return { transformToByteArray: async () => bytes };
}

/** An AWS SDK v3 error carrying the given error-code `name` and (optionally) HTTP status, as thrown by a rejected command. */
function awsError(name: string, httpStatusCode?: number): Error {
  const err = new Error(name) as Error & { $metadata?: { httpStatusCode?: number } };
  err.name = name;
  if (httpStatusCode !== undefined) err.$metadata = { httpStatusCode };
  return err;
}

describe('fresh-install config seed (final-review round 2, finding 1)', () => {
  const BUCKET = 'my-config-bucket';

  /** In-memory single-object store shared by every S3 command the test intercepts below — the ONE bucket both `BootstrapService` and `AwsRemoteFileStore` operate against. */
  let stored: { body: Uint8Array; etag: string } | undefined;

  beforeEach(() => {
    s3Mock.reset();
    stored = undefined;

    s3Mock.on(HeadObjectCommand).callsFake(async () => {
      if (!stored) throw awsError('NotFound', 404);
      return {};
    });
    s3Mock.on(PutObjectCommand).callsFake(async (input) => {
      const body =
        input.Body instanceof Uint8Array ? input.Body : new TextEncoder().encode(String(input.Body ?? ''));
      stored = { body, etag: 'etag-1' };
      return { ETag: `"${stored.etag}"` };
    });
    s3Mock.on(GetObjectCommand).callsFake(async () => {
      if (!stored) throw new NoSuchKey({ message: 'not found', $metadata: {} });
      return { Body: fakeBody(stored.body) as never, ETag: `"${stored.etag}"` };
    });
  });

  it('should let updateTopLevelSettings and addGameServer succeed after BootstrapService.ensureDeploymentConfig seeds a bucket that starts with no deployment-config.json object', async () => {
    const remoteFileStore = new AwsRemoteFileStore(() => ({ bucket: BUCKET, region: 'us-west-2' }));
    const deploymentConfig = new DeploymentConfigService(makeConfig(BUCKET), remoteFileStore);

    // 1. Seed absent — reproduces the bug's precondition for real, not by
    // assumption: every write path calls fetchRawConfig() first, and it
    // rejects when the object genuinely doesn't exist.
    await expect(deploymentConfig.getRawConfig()).rejects.toThrow(/not found/i);

    // 2. The fix: BootstrapService seeds the initial document into the SAME
    // bucket DeploymentConfigService reads/writes, via the SAME mocked S3Client.
    const bootstrap = new BootstrapService(makeStore({ region: 'us-west-2' }));
    const seedResult = await bootstrap.ensureDeploymentConfig(BUCKET);
    expect(seedResult).toEqual({ status: 'created' });

    // 3. Seed present — a Settings save (a real hostedZoneName, exactly what
    // the Settings form submits) now succeeds instead of throwing.
    const { etag } = await deploymentConfig.getRawConfig();
    const settingsWrite = await deploymentConfig.updateTopLevelSettings({ hostedZoneName: 'example.com' }, etag);
    expect(settingsWrite.etag).toBeTruthy();

    const { settings } = await deploymentConfig.getTopLevelSettings();
    expect(settings.hostedZoneName).toBe('example.com');
    // Every other field still carries the seed's defaults (from
    // withDeploymentConfigDefaults) — the settings write only touched
    // hostedZoneName.
    expect(settings.projectName).toBe('hyveon');

    // 4. Adding a game (the Games UI's write path) now succeeds too.
    await deploymentConfig.addGameServer('minecraft', {
      image: 'itzg/minecraft-server',
      cpu: 1024,
      memory: 2048,
      ports: [{ container: 25565, protocol: 'tcp' }],
      volumes: [{ name: 'data', container_path: '/data' }],
    });

    const servers = await deploymentConfig.getGameServers();
    expect(servers.map((s) => s.name)).toEqual(['minecraft']);
  });

  it('should report exists (not created) and never overwrite an operator-edited document when ensureDeploymentConfig is re-run after a Settings save', async () => {
    const remoteFileStore = new AwsRemoteFileStore(() => ({ bucket: BUCKET, region: 'us-west-2' }));
    const deploymentConfig = new DeploymentConfigService(makeConfig(BUCKET), remoteFileStore);
    const bootstrap = new BootstrapService(makeStore({ region: 'us-west-2' }));

    await bootstrap.ensureDeploymentConfig(BUCKET);
    const { etag } = await deploymentConfig.getRawConfig();
    await deploymentConfig.updateTopLevelSettings({ hostedZoneName: 'example.com' }, etag);

    // Re-running bootstrap (e.g. a wizard resume, or Reconfigure) must not
    // clobber the operator's edit.
    const secondSeed = await bootstrap.ensureDeploymentConfig(BUCKET);
    expect(secondSeed).toEqual({ status: 'exists' });

    const { settings } = await deploymentConfig.getTopLevelSettings();
    expect(settings.hostedZoneName).toBe('example.com');
  });
});
